// "Find companies for my thesis": a short standalone sourcing agent over the Dealroom (+ web fallback) tools.
// No deck session: tools write receipts into a throwaway in-memory Session that is never persisted.
import { cpMessage, type ContentBlock } from './cp.js';
import { runToolBatch, toAnthropicTools, type ToolDef, type ToolUseBlock } from './tooling.js';
import { dealroomTools, imageUrl, searchEntities } from './dealroom.js';
import { webTools } from './web.js';
import { nowIso, shortId, type Session } from './store.js';
import type { SuggestBody, Suggestion, SuggestResponse } from '../shared/types.js';

const MAX_ROUNDS = 6;
const DEADLINE_MS = 20_000;
const CACHE_MS = 3 * 60 * 60_000; // long: the demo pre-warms its thesis queries
const cache = new Map<string, { at: number; res: Promise<SuggestResponse> }>();

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function throwawaySession(): Session {
  const t = nowIso();
  const id = `suggest-${shortId(8)}`;
  return {
    deck: { id, entity: { uuid: id, kind: 'company', name: 'suggest' }, title: 'suggest', slides: [], status: 'building', createdAt: t, updatedAt: t },
    chat: [], receipts: [], messages: [], busy: false, ephemeral: true,
  };
}

const SYSTEM = (limit: number) => `You are a venture sourcing analyst. Find ${limit} companies that fit the user's investment thesis, using LIVE Dealroom data.
Today: ${new Date().toISOString().slice(0, 10)}.

Method (be fast: at most 5 tool rounds, many calls in parallel per round):
1. If a fund uuid is given: in ONE parallel round pull dealroom_investor and dealroom_investor_section(portfolio, limit 100) and (deals). Infer its thesis from the portfolio: sectors, stages, geographies, check sizes. Its portfolio companies are EXCLUDED from your answer.
2. Discover filter keys and values: dealroom_get /reference/filters?scope=companies and /reference/filters/{key}/values (industries, hq_location, last funding round type/date, launch_year).
3. Prefer list/filter endpoints over name search: dealroom_get /data/companies with a filter like and(industries[in_any]:...,hq_location[in_any]:...,launch_year[gte]:2019) sorted by most recent funding (e.g. sort -last_funding_date), limit 25-50. Cross-check stage with dealroom_transactions when useful.
4. Pick the best ${limit}, then call submit_suggestions ONCE. uuid, name, image, tagline, hqCity, hqCountry and lastRound must be copied from Dealroom tool results (null when absent); receipts = the receipt ids that support each pick.
If Dealroom calls fail (HTTP 401/403/5xx), fall back to web_search / web_fetch for REAL companies only, set uuid to "" and image to null, and say plainly in thesisSummary that Dealroom was unreachable and the picks come from the web.
Never invent companies, numbers or rounds. "why" = one sentence on how the company fits the thesis. thesisSummary = 1-2 sentences restating the thesis you searched for (and for a fund, what its portfolio says it invests in). No emojis, no em-dashes.`;

function submitTool(onSubmit: (r: SuggestResponse) => void): ToolDef {
  return {
    name: 'submit_suggestions',
    description: 'Submit the final answer. Ends the search.',
    input_schema: {
      type: 'object',
      properties: {
        thesisSummary: { type: 'string' },
        suggestions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              uuid: { type: 'string' }, name: { type: 'string' }, image: { type: ['string', 'null'] }, tagline: { type: ['string', 'null'] },
              hqCity: { type: ['string', 'null'] }, hqCountry: { type: ['string', 'null'] }, lastRound: { type: ['string', 'null'], description: 'e.g. "$12M Series A, Mar 2026"' },
              why: { type: 'string' }, receipts: { type: 'array', items: { type: 'string' } },
            },
            required: ['uuid', 'name', 'why'],
          },
        },
      },
      required: ['thesisSummary', 'suggestions'],
    },
    async run(input) {
      const raw = typeof input.suggestions === 'string' ? JSON.parse(input.suggestions) : input.suggestions;
      onSubmit({ thesisSummary: String(input.thesisSummary ?? ''), suggestions: Array.isArray(raw) ? raw : [] });
      return 'ok';
    },
  };
}

const normName = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Find the Dealroom row for a uuid (or, when the model dropped the uuid, an exact name) in the successful Dealroom receipts. */
function findDealroomRow(s: Session, uuid: string, name = ''): any | null {
  const nn = normName(name);
  let hit: any = null;
  const walk = (n: any, depth: number) => {
    if (hit || !n || typeof n !== 'object' || depth > 8) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
    if (typeof n.name === 'string' && (uuid ? (n.uuid === uuid || n.id === uuid) : (nn && typeof (n.uuid ?? n.id) === 'string' && n.type !== 'investor' && normName(n.name) === nn))) { hit = n; return; }
    for (const v of Object.values(n)) walk(v, depth + 1);
  };
  for (const r of s.receipts) if (r.source === 'dealroom' && r.status < 400) walk(r.json, 0);
  return hit;
}

/** Ground every pick in a receipt: Dealroom rows override display fields; a pick no receipt mentions is dropped. */
function ground(s: Session, picks: any[], exclude: Set<string>, limit: number): Suggestion[] {
  const allText = s.receipts.filter((r) => r.status < 400).map((r) => JSON.stringify(r.json ?? '')).join('\n').toLowerCase();
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const p of picks) {
    const name = str(p?.name);
    if (!name || !allText.includes(name.toLowerCase())) continue;
    const row = findDealroomRow(s, str(p?.uuid) ?? '') ?? findDealroomRow(s, '', name);
    const uuid: string = row ? (str(row.uuid) ?? str(row.id) ?? '') : '';
    const key = row ? uuid : name.toLowerCase();
    if (seen.has(key) || (uuid && exclude.has(uuid))) continue;
    seen.add(key);
    const hq = Array.isArray(row?.hq_locations) ? row.hq_locations[0] : null;
    out.push({
      uuid: row ? uuid : '',
      kind: 'company',
      name: row ? (str(row.name) ?? name) : name,
      image: row ? (imageUrl(row.image) ?? imageUrl(row.images?.['100x100']) ?? imageUrl(p.image)) : null,
      tagline: row ? (str(row.tagline) ?? str(p.tagline)) : str(p.tagline),
      hqCity: (row && (str(row.hq_city) ?? str(hq?.city?.name))) || str(p.hqCity),
      hqCountry: (row && (str(row.hq_country) ?? str(hq?.country?.name))) || str(p.hqCountry),
      lastRound: str(p.lastRound),
      why: str(p.why) ?? '',
      ...(Array.isArray(p.receipts) ? { receipts: p.receipts.filter((x: unknown) => typeof x === 'string') } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Uuids of the fund's portfolio companies, from its portfolio receipts. */
function portfolioUuids(s: Session): Set<string> {
  const set = new Set<string>();
  for (const r of s.receipts) {
    if (r.source !== 'dealroom' || r.status >= 400 || !/portfolio/.test(r.endpoint)) continue;
    const walk = (n: any, d: number) => {
      if (!n || typeof n !== 'object' || d > 6) return;
      if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
      if (typeof n.uuid === 'string') set.add(n.uuid);
      Object.values(n).forEach((v) => walk(v, d + 1));
    };
    walk(r.json, 0);
  }
  return set;
}

async function run(body: SuggestBody): Promise<SuggestResponse> {
  const limit = Math.max(1, Math.min(12, Number(body.limit) || 6));
  const s = throwawaySession();
  let submitted: SuggestResponse | null = null;
  const tools: ToolDef[] = [...dealroomTools, ...webTools, submitTool((r) => { submitted = r; })];
  const apiTools = toAnthropicTools(tools);
  const ctx = { session: s, status: () => {} };
  const ask = [
    body.thesis?.trim() ? `Thesis: ${body.thesis.trim()}` : null,
    body.fundUuid ? `My fund: ${body.fundName ?? 'unnamed'} (Dealroom investor uuid ${body.fundUuid}). Infer its thesis from its portfolio and exclude its portfolio companies.` : null,
    `Find ${limit} companies.`,
  ].filter(Boolean).join('\n');
  s.messages.push({ role: 'user', content: [{ type: 'text', text: ask }] });
  const started = Date.now();

  for (let round = 0; round < MAX_ROUNDS && !submitted; round++) {
    const late = round === MAX_ROUNDS - 1 || Date.now() - started > DEADLINE_MS;
    if (late) {
      const last = s.messages[s.messages.length - 1];
      (last.content as object[]).push({ type: 'text', text: 'Time is up: call submit_suggestions NOW with the best picks from the data you already have.' });
    }
    const r = await cpMessage({ system: SYSTEM(limit), messages: s.messages, tools: apiTools, shardKey: s.deck.id, maxTokens: 8000 });
    const content = r.content.filter((b: ContentBlock) => !(b.type === 'text' && !String(b.text ?? '').trim()));
    if (!content.length) break;
    s.messages.push({ role: 'assistant', content });
    const uses = content.filter((b) => b.type === 'tool_use') as unknown as ToolUseBlock[];
    if (!uses.length) break;
    const results = await runToolBatch(tools, uses, ctx);
    s.messages.push({ role: 'user', content: results });
    if (late) break;
  }
  const sub = submitted as SuggestResponse | null;
  if (!sub) throw new Error('The sourcing agent did not return suggestions in time.');
  const exclude = body.fundUuid ? portfolioUuids(s) : new Set<string>();
  const picks = ground(s, sub.suggestions, exclude, limit);
  await Promise.all(picks.filter((p) => !p.uuid).map(async (p) => {
    // Picks that never appeared in a Dealroom row (web-sourced) get resolved by exact name via search.
    const hit = (await searchEntities(p.name, 'company').catch(() => [])).find((h) => h.type === 'company' && normName(h.name) === normName(p.name));
    if (!hit || exclude.has(hit.uuid)) return;
    Object.assign(p, { uuid: hit.uuid, image: p.image ?? hit.image, tagline: p.tagline ?? hit.tagline, hqCity: p.hqCity ?? hit.hqCity, hqCountry: p.hqCountry ?? hit.hqCountry });
  }));
  return { thesisSummary: sub.thesisSummary, suggestions: picks };
}

export async function suggestCompanies(body: SuggestBody): Promise<SuggestResponse> {
  const key = JSON.stringify([body.thesis?.trim().toLowerCase() ?? '', body.fundUuid ?? '', Number(body.limit) || 6]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.res;
  const res = run(body);
  cache.set(key, { at: Date.now(), res });
  res.catch(() => cache.delete(key)); // never cache a failure
  return res;
}
