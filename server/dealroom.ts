// Dealroom API client (OAuth client-credentials, cached token) + agent tools.
// Base https://api.beta.dealroom.app, paths have NO /api prefix. Spec: .dealroom-kit/openapi-beta.yaml.
import type { EntityKind, SearchHit } from '../shared/types.js';
import { addReceipt } from './store.js';
import type { ToolCtx, ToolDef } from './tooling.js';

const BASE = 'https://api.beta.dealroom.app';
const TOKEN_URL = 'https://accounts.dealroom.co/oauth/token';
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Optional egress proxy. undici is not a declared dependency, so load it only when present.
let dispatcherP: Promise<unknown | null> | null = null;
function proxyDispatcher(): Promise<unknown | null> {
  const url = process.env.DEALROOM_PROXY;
  if (!url) return Promise.resolve(null);
  dispatcherP ??= (async () => {
    try {
      const spec = 'undici'; // variable specifier: optional module, absent from package.json
      const mod: any = await import(spec);
      return new mod.ProxyAgent(url);
    } catch {
      console.warn('[dealroom] DEALROOM_PROXY set but the undici package is not installed; calling directly');
      return null;
    }
  })();
  return dispatcherP;
}

async function drFetch(url: string, init: RequestInit): Promise<Response> {
  const dispatcher = await proxyDispatcher();
  init = { signal: AbortSignal.timeout(30_000), ...init }; // a hung call would wedge the turn (busy stuck true)
  return fetch(url, dispatcher ? ({ ...init, dispatcher } as RequestInit) : init);
}

function cloudflareBlocked(status: number, ctype: string | null, body: string) {
  return status === 403 && (/text\/html/i.test(ctype ?? '') || /Attention Required|cloudflare/i.test(body.slice(0, 2000)));
}

let token: { value: string; exp: number } | null = null;
async function getToken(): Promise<string> {
  if (token && Date.now() < token.exp) return token.value;
  const client_id = process.env.DEALROOM_CLIENT_ID;
  const client_secret = process.env.DEALROOM_CLIENT_SECRET;
  if (!client_id || !client_secret) throw new Error('DEALROOM_CLIENT_ID / DEALROOM_CLIENT_SECRET are not set');
  const res = await drFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': BROWSER_UA },
    body: JSON.stringify({ client_id, client_secret, audience: BASE, grant_type: 'client_credentials' }),
  });
  const text = await res.text();
  if (cloudflareBlocked(res.status, res.headers.get('content-type'), text)) throw new Error('Dealroom blocked this network (Cloudflare 403)');
  if (!res.ok) throw new Error(`Dealroom token request failed: HTTP ${res.status}`);
  const j = JSON.parse(text);
  const ttl = Math.min(Number(j.expires_in) || 86400, 86400);
  token = { value: j.access_token, exp: Date.now() + (ttl - 120) * 1000 };
  return token.value;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** Raw GET against the Dealroom data API. Never throws on HTTP errors except the Cloudflare network block. */
export async function dealroomGet(path: string, query?: Record<string, string | number | boolean>): Promise<{ status: number; json: any; ms: number }> {
  const p = path.startsWith('/') ? path : `/${path}`;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries((query ?? {}) as Query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = `${BASE}${p}${qs.size ? `?${qs}` : ''}`;
  const t0 = Date.now();
  const doFetch = async () => drFetch(url, {
    headers: {
      authorization: `Bearer ${await getToken()}`,
      'x-client-id': process.env.DEALROOM_CLIENT_ID ?? '',
      'user-agent': BROWSER_UA,
      accept: 'application/json',
    },
  });
  let res = await doFetch();
  if (res.status === 401) { token = null; res = await doFetch(); }
  // Dealroom rate-limits bursts (RATE_LIMITED 429); a parallel tool batch hits it routinely.
  for (let i = 0; res.status === 429 && i < 3; i++) {
    const ra = Number(res.headers.get('retry-after'));
    await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 1500 * (i + 1)));
    res = await doFetch();
  }
  const text = await res.text();
  const ms = Date.now() - t0;
  if (cloudflareBlocked(res.status, res.headers.get('content-type'), text)) throw new Error('Dealroom blocked this network (Cloudflare 403)');
  let json: any;
  try { json = text ? JSON.parse(text) : null; } catch { json = { text: text.slice(0, 2000) }; }
  return { status: res.status, json, ms };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** Dealroom returns scheme-less image hosts ("storage.googleapis.com/..."); browsers need https. */
export const imageUrl = (v: unknown): string | null => {
  const s = str(v);
  return s && !/^https?:\/\//.test(s) && !s.startsWith('data:') ? `https://${s.replace(/^\/+/, '')}` : s;
};

export async function searchEntities(q: string, types?: string): Promise<SearchHit[]> {
  const { status, json } = await dealroomGet('/data/search', { q, limit: 10, ...(types ? { types } : {}) });
  if (status >= 400) throw new Error(`Dealroom search failed: HTTP ${status} ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  return rows.map((r) => ({
    uuid: r.uuid,
    type: r.type,
    name: r.name,
    tagline: str(r.tagline),
    image: imageUrl(r.image),
    hqCity: str(r.hq_city),
    hqCountry: str(r.hq_country),
    websiteDomain: str(r.website_domain),
    isUnicorn: typeof r.is_unicorn === 'boolean' ? r.is_unicorn : null,
    investorRank: typeof r.investor_rank === 'number' ? r.investor_rank : null,
  }));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** "app.dealroom.co/companies/<slug>", "/investors/<slug>", full urls -> best matching entity. */
export async function resolveDealroomUrl(url: string): Promise<{ uuid: string; kind: EntityKind; name: string; image?: string | null; tagline?: string | null } | null> {
  let raw = String(url ?? '').trim();
  try { raw = decodeURIComponent(raw); } catch { /* malformed %-escape: match the raw text */ }
  const m = /(?:^|\/)(companies|investors)\/([^/?#\s]+)/i.exec(raw);
  if (!m) return null;
  const kind: EntityKind = m[1].toLowerCase() === 'investors' ? 'investor' : 'company';
  const slug = m[2].toLowerCase();
  const words = slug.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  let hits: SearchHit[];
  try {
    hits = await searchEntities(words, kind);
    if (!hits.length && words.includes(' ')) hits = await searchEntities(words.split(' ')[0], kind);
  } catch (e) {
    // Dealroom unreachable (network block / token): build from the URL's own slug so the agent can still
    // research the entity (it falls back to the web). The slug is the user's input, not invented data.
    console.warn(`[dealroom] resolve "${slug}" via search failed (${(e as Error).message}); using the URL slug`);
    return { uuid: slug, kind, name: words.replace(/\b[a-z]/g, (c) => c.toUpperCase()), image: null, tagline: null };
  }
  const typed = hits.filter((h) => h.type === kind);
  if (!typed.length) return null;
  const target = norm(slug);
  const best = typed.find((h) => norm(h.name) === target)
    ?? typed.find((h) => h.websiteDomain && norm(h.websiteDomain.split('.')[0]) === target)
    ?? typed.find((h) => norm(h.name).startsWith(target) || target.startsWith(norm(h.name)))
    ?? typed[0];
  return { uuid: best.uuid, kind, name: best.name, image: best.image, tagline: best.tagline };
}

// ---------- trimming ----------
const MAX_ITEMS = 25;
const MAX_STR = 600;
const NESTED_ITEMS = 6;
const NESTED_STR = 160;
const NESTED_DROP = new Set(['about', 'description', 'long_description', 'tagline', 'website', 'linkedin', 'twitter', 'path', 'url', 'dealroom_url']);
const DROP_KEYS = new Set(['locked', 'created_at', 'deleted_at', 'updated_at', 'images', 'image_urls', 'svg', 'logo_svg', 'lat', 'lon', 'latitude', 'longitude',
  'angellist', 'crunchbase', 'facebook', 'instagram', 'youtube', 'city_unique_id', 'state_unique_id', 'country_unique_id', 'continent_unique_id', 'city_region_unique_ids', 'next_cursor']);
const IMAGE_KEY = /^(image|logo|avatar|photo|picture|icon|thumbnail)(_url)?$/i;
const HTML_TAG = /<\/?[a-z][^>]*>/i;
const stripHtml = (t: string) => t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const nm = (o: any): string | null => (o && typeof o === 'object' ? str(o.name) : null);
/** {role, city:{name}, country:{name}, ...} -> "hq: London, United Kingdom" (ids/coords/continent are noise). */
function compactLocation(l: any): unknown {
  if (!l || typeof l !== 'object' || Array.isArray(l) || !(l.city || l.country)) return l;
  const place = [nm(l.city), nm(l.country)].filter(Boolean).join(', ');
  return l.role ? `${l.role}: ${place}` : place;
}

/** Keep decision-useful content: drop nulls/empties/noise keys, cap arrays at 25 and strings at 600 chars. */
export function trim(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return undefined;
  // Nested entities (an investor's portfolio inside an investors row, etc.) are context, not the subject:
  // keep them short so one section does not cost 60KB on every model turn.
  const nested = depth >= 3;
  if (typeof v === 'string') {
    const t = HTML_TAG.test(v) ? stripHtml(v) : v;
    const max = nested ? NESTED_STR : MAX_STR;
    return t.length > max ? t.slice(0, max) + '...' : t;
  }
  if (typeof v !== 'object') return v;
  if (depth > 7) return undefined;
  if (Array.isArray(v)) {
    const cap = nested ? NESTED_ITEMS : MAX_ITEMS;
    const items = v.slice(0, cap).map((x) => trim(x, depth + 1)).filter((x) => x !== undefined);
    if (!items.length) return undefined;
    if (v.length > cap) items.push(`...${v.length - cap} more`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (DROP_KEYS.has(k) || (nested && NESTED_DROP.has(k))) continue;
    if (IMAGE_KEY.test(k) && typeof x === 'string') { const u = imageUrl(x); if (u) out[k] = u; continue; }
    const t = trim((k === 'locations' || k === 'location') ? (Array.isArray(x) ? x.map(compactLocation) : compactLocation(x)) : x, depth + 1);
    if (t === undefined) continue;
    if (typeof t === 'object' && !Array.isArray(t) && !Object.keys(t as object).length) continue;
    out[k] = t;
  }
  return Object.keys(out).length ? out : undefined;
}

const RECEIPT_CAP = 200_000;
function capJson(json: unknown): unknown {
  const s = JSON.stringify(json ?? null);
  return s.length > RECEIPT_CAP ? { truncated: true, bytes: s.length, text: s.slice(0, RECEIPT_CAP) } : json;
}

/** One Dealroom call -> receipt -> {receipt, data} for the model. */
async function call(ctx: ToolCtx, endpoint: string, path: string, query: Record<string, string | number | boolean> = {}, shape?: (data: any) => any) {
  const { status, json, ms } = await dealroomGet(path, query);
  const r = addReceipt(ctx.session, { source: 'dealroom', endpoint, params: { path, ...query }, status, ms, json: capJson(json) });
  if (status >= 400) return { receipt: r.id, status, error: json?.error ?? json };
  const raw = json?.data !== undefined ? json.data : json;
  const data = trim(shape ? shape(raw) : raw) ?? null;
  const page = json?.page ? trim(json.page) : undefined;
  return { receipt: r.id, data, ...(page ? { page } : {}) };
}

// Filter keys discovered live from /reference/filters?scope=<scope> (cached), so we never guess a key that silently returns 0 rows.
const filterKeyCache = new Map<string, Promise<string[]>>();
function filterKeys(scope: string): Promise<string[]> {
  if (!filterKeyCache.has(scope)) {
    filterKeyCache.set(scope, dealroomGet('/reference/filters', { scope }).then(({ json }) => {
      const keys: string[] = [];
      const walk = (n: any) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n.key === 'string') keys.push(n.key);
        Object.values(n).forEach(walk);
      };
      walk(json);
      return keys;
    }).catch(() => []));
  }
  return filterKeyCache.get(scope)!;
}
async function pickFilterKey(scope: string, prefer: RegExp[], fallback: string): Promise<string> {
  const keys = await filterKeys(scope);
  for (const re of prefer) { const k = keys.find((x) => re.test(x)); if (k) return k; }
  return fallback;
}

const uuidProp = { type: 'string', description: 'Dealroom entity UUID (from dealroom_search or the deck entity)' };
const limitProp = { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows (default 25)' };
const lim = (n: unknown, d = 25) => Math.max(1, Math.min(100, Number(n) || d));

/** Headcount breakdown = monthly % shares per country/department; the newest month per dimension is the decision-useful slice. */
function latestHeadcount(d: any): any {
  if (!Array.isArray(d) || !d.length) return d;
  const key = (r: any) => (Number(r.year) || 0) * 100 + (Number(r.month) || 0);
  const out: any[] = [];
  for (const type of [...new Set(d.map((r: any) => r.breakdown_type))]) {
    const rows = d.filter((r: any) => r.breakdown_type === type);
    const newest = Math.max(...rows.map(key));
    out.push(...rows.filter((r: any) => key(r) === newest).sort((a: any, b: any) => (b.percentage ?? 0) - (a.percentage ?? 0))
      .map((r: any) => ({ breakdown_type: r.breakdown_type, item: r.item_name, year: r.year, month: r.month, percentage: r.percentage })));
  }
  return out;
}

const COMPANY_SECTIONS = ['funding_rounds', 'investors', 'team', 'similar', 'valuations', 'headcount', 'web_traffic', 'financials', 'news', 'jobs', 'patents'] as const;
const COMPANY_SUBPATH: Record<string, string> = {
  funding_rounds: 'funding-rounds', investors: 'investors', team: 'team', similar: 'similar', valuations: 'valuations',
  headcount: 'headcount-breakdown', web_traffic: 'web-traffic', financials: 'financials', patents: 'patents',
};
const INVESTOR_SECTIONS = ['portfolio', 'funds', 'team', 'similar', 'lp_positions', 'deals'] as const;
const INVESTOR_SUBPATH: Record<string, string> = { portfolio: 'portfolio', funds: 'funds', team: 'team', similar: 'similar', lp_positions: 'lp-funds' };
const label = (s: string) => s.replace(/_/g, ' ');

export const dealroomTools: ToolDef[] = [
  {
    name: 'dealroom_search',
    description: 'Search Dealroom entities (companies, investors, people, universities) by name. Returns uuid, type, name, tagline, HQ, domain, unicorn flag, investor rank.',
    input_schema: { type: 'object', properties: { q: { type: 'string' }, types: { type: 'string', description: 'Comma list: company,investor,person,university,gov_ngo' } }, required: ['q'] },
    async run(input, ctx) {
      ctx.status(`Searching Dealroom for "${input.q}"...`);
      return call(ctx, '/data/search', '/data/search', { q: String(input.q), limit: 10, ...(input.types ? { types: String(input.types) } : {}) });
    },
  },
  {
    name: 'dealroom_company',
    description: 'Full Dealroom company profile by UUID: description, HQ, founding date, tags/industries, total funding, valuation, employees, status, unicorn/VC-backed flags, traffic, founders.',
    input_schema: { type: 'object', properties: { uuid: uuidProp, currency: { type: 'string', description: 'ISO 4217, default USD' } }, required: ['uuid'] },
    async run(input, ctx) {
      ctx.status('Pulling company profile...');
      return call(ctx, '/data/companies/{id}', `/data/companies/${encodeURIComponent(input.uuid)}`, input.currency ? { currency: String(input.currency) } : {});
    },
  },
  {
    name: 'dealroom_company_section',
    description: 'One section of a company: funding_rounds (newest first, amounts + valuations + round types + investors), investors, team (founders/execs), similar (competitors), valuations (history), headcount (breakdown over time), web_traffic (history), financials (revenue/EBITDA when known), news, jobs, patents.',
    input_schema: { type: 'object', properties: { uuid: uuidProp, section: { type: 'string', enum: [...COMPANY_SECTIONS] }, limit: limitProp }, required: ['uuid', 'section'] },
    async run(input, ctx) {
      const section = String(input.section);
      const id = encodeURIComponent(input.uuid);
      const limit = lim(input.limit);
      ctx.status(`Pulling ${label(section)}...`);
      if (section === 'news' || section === 'jobs') {
        // Verified live: both scopes filter by entity_id; news sorts by publish_date, jobs by date_posted.
        const sort = section === 'news' ? '-publish_date' : '-date_posted';
        return call(ctx, `/data/${section}`, `/data/${section}`, { filter: `entity_id[eq]:${input.uuid}`, limit, sort });
      }
      const sub = COMPANY_SUBPATH[section];
      if (!sub) throw new Error(`Unknown company section "${section}"; use one of ${COMPANY_SECTIONS.join(', ')}`);
      // web-traffic and headcount-breakdown are full chronological series (oldest first, limit ignored):
      // keep the newest months so the row cap does not leave only 2018 data.
      const shape = section === 'web_traffic' ? (d: any) => (Array.isArray(d) ? d.slice(-limit).reverse() : d)
        : section === 'headcount' ? latestHeadcount
        : undefined;
      return call(ctx, `/data/companies/{id}/${sub}`, `/data/companies/${id}/${sub}`, { limit }, shape);
    },
  },
  {
    name: 'dealroom_investor',
    description: 'Full Dealroom investor profile by UUID: type, HQ, AUM/total invested, number of investments/exits, unicorn hits, stages, sectors, rank.',
    input_schema: { type: 'object', properties: { uuid: uuidProp }, required: ['uuid'] },
    async run(input, ctx) {
      ctx.status('Pulling investor profile...');
      return call(ctx, '/data/investors/{id}', `/data/investors/${encodeURIComponent(input.uuid)}`);
    },
  },
  {
    name: 'dealroom_investor_section',
    description: 'One section of an investor: portfolio (companies + rounds), funds (vehicles raised: size, year, type), team (partners), similar (peer investors), lp_positions (funds this entity is an LP in), deals (recent transactions it took part in).',
    input_schema: { type: 'object', properties: { uuid: uuidProp, section: { type: 'string', enum: [...INVESTOR_SECTIONS] }, limit: limitProp }, required: ['uuid', 'section'] },
    async run(input, ctx) {
      const section = String(input.section);
      const id = encodeURIComponent(input.uuid);
      const limit = lim(input.limit);
      ctx.status(`Pulling investor ${label(section)}...`);
      if (section === 'deals') {
        // /data/transactions has no investor-id filter (verified via /reference/filters); investor_name[eq] is the key.
        const prof = await dealroomGet(`/data/investors/${id}`);
        const name = str(prof.json?.data?.name) ?? str(prof.json?.name);
        if (!name) return { status: prof.status, error: 'could not resolve the investor name for the transactions filter' };
        return call(ctx, '/data/transactions', '/data/transactions', { filter: `investor_name[eq]:${name}`, sort: '-date', limit });
      }
      const sub = INVESTOR_SUBPATH[section];
      if (!sub) throw new Error(`Unknown investor section "${section}"; use one of ${INVESTOR_SECTIONS.join(', ')}`);
      return call(ctx, `/data/investors/{id}/${sub}`, `/data/investors/${id}/${sub}`, { limit });
    },
  },
  {
    name: 'dealroom_transactions',
    description: 'Filtered list of funding transactions across all companies. filter uses Dealroom syntax, e.g. and(date[gte]:2024,amount[gte]:1000000,is_vc_round[eq]:true). For VC funding totals apply is_vc_round[eq]:true, growth_stage[nin_any]:412, taxonomy_id[nin_any]:1102801. Discover filter keys with dealroom_get /reference/filters?scope=transactions.',
    input_schema: { type: 'object', properties: { filter: { type: 'string' }, sort: { type: 'string', description: 'e.g. -date or -amount' }, limit: limitProp, include_total: { type: 'boolean' } }, required: [] },
    async run(input, ctx) {
      ctx.status('Pulling transactions...');
      const q: Record<string, string | number | boolean> = { limit: lim(input.limit), sort: input.sort ? String(input.sort) : '-date' };
      if (input.filter) q.filter = String(input.filter);
      if (input.include_total) q.include_total = true;
      return call(ctx, '/data/transactions', '/data/transactions', q);
    },
  },
  {
    name: 'dealroom_get',
    description: 'Generic GET on the Dealroom API (escape hatch). Paths (no /api prefix): /data/search?q=; /data/entities, /data/companies, /data/investors, /data/funds, /data/founders, /data/people, /data/news, /data/jobs, /data/transactions, /data/valuations (lists: filter, sort, limit, offset, include_total, view=summary|full, currency); /data/companies/{id} + /funding-rounds /valuations /investors /financials /web-traffic /headcount-breakdown /team /patents /similar; /data/investors/{id} + /portfolio /funds /lp-funds /team /similar; /data/funds/{id}; /data/founders/{id}(/founded-companies); /data/people/{id}(/career,/education); /data/news/{id}; /data/jobs/{id}; /data/entities/{id}(/lp-funds); /analytics/timeseries; /analytics/aggregate/{source}(/multi-metric); /reference/filters?scope=companies|investors|transactions|news|jobs|funds|people; /reference/filters/{key}/values. Filter syntax: and(a[gte]:1,b[in_any]:x|y), ops eq neq gt gte lt lte in_any nin_any.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } } }, required: ['path'] },
    async run(input, ctx) {
      const path = String(input.path);
      ctx.status(`Querying Dealroom ${path.split('?')[0]}...`);
      const [p, inlineQs] = path.split('?');
      const query: Record<string, string | number | boolean> = {};
      if (inlineQs) for (const [k, v] of new URLSearchParams(inlineQs)) query[k] = v;
      Object.assign(query, input.query ?? {});
      return call(ctx, p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}'), p, query);
    },
  },
];
