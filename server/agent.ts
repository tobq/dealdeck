// The analyst agent: ONE conversation per session (s.messages) that builds the deck, answers Q&A,
// edits the deck and speaks. Tool calls of one turn run in parallel.
import { cpMessage, type ContentBlock } from './cp.js';
import { runToolBatch, toAnthropicTools, type ToolDef, type ToolUseBlock } from './tooling.js';
import { dealroomTools } from './dealroom.js';
import { webTools } from './web.js';
import { generateCoverImage } from './twoshot.js';
import { emit, save, setBusy, nowIso, shortId, type Session } from './store.js';
import { buildSystemPrompt, buildDeckKickoff, BULL_BEAR_KICKOFF, NARRATION_KICKOFF } from './prompts.js';
import type { ChatMessage, Slide, SpeakVoice } from '../shared/types.js';

const MAX_ROUNDS = 12;
const KINDS = new Set<Slide['kind']>(['title', 'metrics', 'bullets', 'chart', 'table', 'people', 'compare', 'questions']);
const VOICES = new Set<SpeakVoice>(['narrator', 'bull', 'bear']);

/** What was spoken during the current turn, per deck (for ChatMessage.spoken). */
const spokenThisTurn = new Map<string, string[]>();

// ---------- slide normalisation ----------
function inferKind(s: any): Slide['kind'] {
  if (s.metrics) return 'metrics';
  if (s.chart) return 'chart';
  if (s.table) return 'table';
  if (s.people) return 'people';
  if (s.compare) return 'compare';
  return 'bullets';
}

/** Coerce every `receipts` field to string[] (models sometimes send a bare string). */
function fixReceipts(v: any): any {
  if (Array.isArray(v)) return v.map(fixReceipts);
  if (!v || typeof v !== 'object') return v;
  const out: any = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === 'receipts') {
      const arr = Array.isArray(val) ? val : typeof val === 'string' ? val.split(/[,\s]+/) : [];
      out.receipts = arr.filter((x) => typeof x === 'string' && x.trim()).map((x: string) => x.trim());
    } else out[k] = fixReceipts(val);
  }
  return out;
}

function parseMaybeJson(v: any) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function normSlide(raw: any, s: Session, fallbackId?: string): Slide {
  const sl: any = fixReceipts(parseMaybeJson(raw) && typeof parseMaybeJson(raw) === 'object' ? parseMaybeJson(raw) : {});
  if (typeof sl.id !== 'string' || !sl.id.trim()) sl.id = fallbackId ?? `s${shortId(5)}`;
  if (!KINDS.has(sl.kind)) sl.kind = inferKind(sl);
  sl.title = typeof sl.title === 'string' ? sl.title : '';
  if (sl.chart?.series && Array.isArray(sl.chart.series)) {
    sl.chart.series = sl.chart.series.map((se: any) => ({
      name: String(se?.name ?? ''),
      points: (Array.isArray(se?.points) ? se.points : [])
        .map((p: any) => ({ x: String(p?.x ?? ''), y: Number(p?.y) }))
        .filter((p: any) => Number.isFinite(p.y)),
    }));
  }
  if (sl.table?.rows && Array.isArray(sl.table.rows)) {
    sl.table.rows = sl.table.rows.map((r: any) => ({ ...r, cells: (Array.isArray(r?.cells) ? r.cells : Array.isArray(r) ? r : []).map((c: any) => String(c ?? '')) }));
  }
  if (sl.kind === 'title' && s.deck.coverImage && !sl.image) sl.image = s.deck.coverImage;
  if (typeof sl.narration !== 'string') delete sl.narration;
  return sl as Slide;
}

// ---------- deck tools ----------
const slideSchema = {
  type: 'object',
  description: 'A Slide object (see the slide JSON guide in the system prompt). Must include kind, title, narration and receipts on every cited number.',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: [...KINDS] },
    title: { type: 'string' },
    subtitle: { type: 'string' },
    narration: { type: 'string' },
  },
  required: ['kind', 'title'],
};

const deckTools: ToolDef[] = [
  {
    name: 'set_deck',
    description: 'Replace the WHOLE deck with these slides (use once, after pulling data). Each slide needs narration and receipts ids on every number.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, slides: { type: 'array', items: slideSchema } }, required: ['title', 'slides'] },
    async run(input, ctx) {
      const s = ctx.session;
      const raw = parseMaybeJson(input.slides);
      if (!Array.isArray(raw) || !raw.length) throw new Error('slides must be a non-empty array');
      const seen = new Set<string>();
      const slides = raw.map((r: any) => {
        const sl = normSlide(r, s);
        if (seen.has(sl.id)) sl.id = `s${shortId(5)}`;
        seen.add(sl.id);
        return sl;
      });
      if (typeof input.title === 'string' && input.title.trim()) s.deck.title = input.title.trim();
      s.deck.slides = slides;
      emit(s.deck.id, { type: 'deck', deck: s.deck });
      save(s);
      return { ok: true, slides: slides.map((sl, i) => ({ index: i, id: sl.id, kind: sl.kind, title: sl.title })) };
    },
  },
  {
    name: 'upsert_slide',
    description: 'Insert or replace ONE slide. Same id = replace in place (or move if index given). New id = insert at index (default: end).',
    input_schema: { type: 'object', properties: { index: { type: 'integer', description: '0-based position' }, slide: slideSchema }, required: ['slide'] },
    async run(input, ctx) {
      const s = ctx.session;
      const slides = s.deck.slides;
      const raw = parseMaybeJson(input.slide);
      const existingIdx = raw?.id ? slides.findIndex((x) => x.id === raw.id) : -1;
      const slide = normSlide(raw, s);
      const want = Number.isInteger(input.index) ? Math.max(0, Math.min(input.index, slides.length)) : null;
      let index: number;
      if (existingIdx >= 0 && (want === null || want === existingIdx)) {
        slides[existingIdx] = slide; index = existingIdx;
        emit(s.deck.id, { type: 'slide', slide, index });
      } else {
        if (existingIdx >= 0) slides.splice(existingIdx, 1);
        index = want === null ? slides.length : Math.min(want, slides.length);
        slides.splice(index, 0, slide);
        emit(s.deck.id, { type: existingIdx >= 0 ? 'deck' : 'slide', ...(existingIdx >= 0 ? { deck: s.deck } : { slide, index }) } as any);
      }
      save(s);
      return { ok: true, id: slide.id, index, total: slides.length };
    },
  },
  {
    name: 'delete_slide',
    description: 'Delete a slide by id.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(input, ctx) {
      const s = ctx.session;
      const i = s.deck.slides.findIndex((x) => x.id === input.id);
      if (i < 0) throw new Error(`No slide with id ${input.id}; ids: ${s.deck.slides.map((x) => x.id).join(', ')}`);
      s.deck.slides.splice(i, 1);
      emit(s.deck.id, { type: 'slide_removed', id: input.id });
      save(s);
      return { ok: true, total: s.deck.slides.length };
    },
  },
  {
    name: 'speak_text',
    description: 'Say something ALOUD to the user (voice turns and Bull vs Bear only). 1-3 short spoken sentences, plain words, no symbols or markdown.',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string', enum: [...VOICES] } }, required: ['text'] },
    async run(input, ctx) {
      const s = ctx.session;
      const text = String(input.text ?? '').trim();
      if (!text) throw new Error('text is empty');
      const voice: SpeakVoice = VOICES.has(input.voice) ? input.voice : 'narrator';
      emit(s.deck.id, { type: 'speak', id: shortId(8), text, voice });
      const list = spokenThisTurn.get(s.deck.id);
      if (list) list.push(voice === 'narrator' ? text : `${voice}: ${text}`);
      return 'ok';
    },
  },
];

function allTools(): ToolDef[] {
  return [...dealroomTools, ...webTools, ...deckTools];
}

// ---------- the turn loop ----------
function pushUser(s: Session, content: string | object[]) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const last = s.messages[s.messages.length - 1];
  if (last?.role === 'user') {
    // Previous turn ended on tool_results (round cap / error): merge so roles keep alternating.
    const prev = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : (last.content as object[]);
    last.content = [...prev, ...blocks];
  } else s.messages.push({ role: 'user', content: blocks });
}

function cleanAssistant(content: ContentBlock[]): ContentBlock[] {
  return content.filter((b) => !(b.type === 'text' && !String(b.text ?? '').trim()));
}

interface TurnOpts { chat: boolean }

/** Run one user turn to completion; returns the written answer. */
async function runTurn(s: Session, userText: string, opts: TurnOpts): Promise<string> {
  const deckId = s.deck.id;
  const tools = allTools();
  const apiTools = toAnthropicTools(tools);
  const system = buildSystemPrompt(s.deck.entity);
  const ctx = { session: s, status: (text: string) => emit(deckId, { type: 'status', text }) };
  spokenThisTurn.set(deckId, []);
  let written = '';
  pushUser(s, userText);
  save(s);
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let firstDelta = true;
      const r = await cpMessage({
        system, messages: s.messages, tools: apiTools, shardKey: deckId,
        onText: (d) => {
          let piece = d;
          if (firstDelta && written) piece = '\n\n' + d;
          firstDelta = false;
          written += piece;
          if (opts.chat) emit(deckId, { type: 'assistant_delta', text: piece });
        },
      });
      const content = cleanAssistant(r.content);
      if (!content.length) break;
      s.messages.push({ role: 'assistant', content });
      save(s);
      const toolUses = content.filter((b) => b.type === 'tool_use') as unknown as ToolUseBlock[];
      if (!toolUses.length) break; // stop_reason end_turn / max_tokens with no calls
      ctx.status(statusLine(toolUses));
      const results = await runToolBatch(tools, toolUses, ctx);
      s.messages.push({ role: 'user', content: results });
      save(s);
      if (r.stopReason !== 'tool_use' && r.stopReason !== null) break;
    }
    const spoken = spokenThisTurn.get(deckId) ?? [];
    if (opts.chat && (written.trim() || spoken.length)) {
      const msg: ChatMessage = { id: shortId(8), role: 'assistant', text: written.trim(), at: nowIso(), ...(spoken.length ? { spoken: spoken.join('\n') } : {}) };
      s.chat.push(msg);
      emit(deckId, { type: 'chat', message: msg });
    }
    return written.trim();
  } finally {
    spokenThisTurn.delete(deckId);
    save(s);
  }
}

const LABELS: Array<[RegExp, string]> = [
  [/funding|round/, 'funding rounds'], [/investor/, 'investors'], [/team|founder|people/, 'team'],
  [/similar|competitor/, 'competitors'], [/headcount|employee/, 'headcount'], [/traffic/, 'web traffic'],
  [/news/, 'news'], [/fund/, 'funds'], [/portfolio/, 'portfolio'], [/valuation/, 'valuations'],
  [/web_search|web_fetch/, 'the web'], [/set_deck|upsert_slide|delete_slide/, 'the deck'],
];
function statusLine(uses: ToolUseBlock[]): string {
  if (uses.every((u) => u.name === 'speak_text')) return 'Speaking...';
  const parts = new Set<string>();
  for (const u of uses.filter((x) => x.name !== 'speak_text')) {
    const hit = LABELS.find(([re]) => re.test(u.name));
    parts.add(hit ? hit[1] : u.name.replace(/_/g, ' '));
  }
  const list = [...parts];
  if (list.length === 1 && list[0] === 'the deck') return 'Updating the deck...';
  return `Pulling ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` +${list.length - 5} more` : ''}...`;
}

/** Run fn as the session's single in-flight turn. Returns false if another turn is running. */
async function exclusive(s: Session, fn: () => Promise<void>): Promise<boolean> {
  if (s.busy) { emit(s.deck.id, { type: 'error', message: 'Still working on the previous request - try again in a moment.' }); return false; }
  setBusy(s, true);
  try { await fn(); } catch (e: any) {
    console.error(`[agent] ${s.deck.id}:`, e?.message ?? e);
    emit(s.deck.id, { type: 'error', message: String(e?.message ?? e).slice(0, 300) });
  } finally { setBusy(s, false); save(s); }
  return true;
}

// ---------- public API ----------
function applyCover(s: Session, url: string) {
  s.deck.coverImage = url;
  for (const sl of s.deck.slides) if (sl.kind === 'title' && !sl.image) sl.image = url;
  emit(s.deck.id, { type: 'deck', deck: s.deck });
  save(s);
}

export async function startDeckBuild(s: Session): Promise<void> {
  await exclusive(s, async () => {
    const e = s.deck.entity;
    s.deck.status = 'building';
    emit(s.deck.id, { type: 'deck', deck: s.deck });
    emit(s.deck.id, { type: 'status', text: `Pulling live Dealroom data on ${e.name}...` });
    if (!s.deck.coverImage) {
      const prompt = `Editorial keynote cover artwork for ${e.name}${e.tagline ? `, ${e.tagline}` : ''}. Abstract, minimal, bright white background, one cobalt blue accent (#3b5bfd), soft geometric shapes, lots of negative space. No text, no letters, no logos.`;
      generateCoverImage(prompt).then((url) => { if (url) applyCover(s, url); }).catch((err) => console.warn('[agent] cover failed:', err?.message ?? err));
    }
    try {
      await runTurn(s, buildDeckKickoff(e), { chat: true });
      if (!s.deck.slides.length) {
        emit(s.deck.id, { type: 'status', text: 'Writing the deck...' });
        await runTurn(s, 'You have not called set_deck yet. Call set_deck NOW with all slides, using only the data you already pulled (say "not disclosed" where data is missing).', { chat: false });
      }
      s.deck.status = s.deck.slides.length ? 'ready' : 'error';
      if (!s.deck.slides.length) emit(s.deck.id, { type: 'error', message: 'The agent did not produce any slides.' });
    } catch (err) {
      s.deck.status = 'error';
      throw err;
    } finally {
      emit(s.deck.id, { type: 'deck', deck: s.deck });
      save(s);
    }
  });
}

export async function handleChat(s: Session, text: string, opts: { voice?: boolean } = {}): Promise<void> {
  const t = String(text ?? '').trim();
  if (!t) return;
  await exclusive(s, async () => {
    const user: ChatMessage = { id: shortId(8), role: 'user', text: t, at: nowIso() };
    s.chat.push(user);
    emit(s.deck.id, { type: 'chat', message: user });
    await runTurn(s, opts.voice ? `(voice) ${t}` : t, { chat: true });
  });
}

export async function runBullBear(s: Session): Promise<void> {
  await exclusive(s, async () => {
    emit(s.deck.id, { type: 'status', text: 'Bull vs Bear...' });
    await runTurn(s, BULL_BEAR_KICKOFF, { chat: true });
  });
}

export async function ensureNarration(s: Session): Promise<void> {
  const missing = s.deck.slides.filter((sl) => !sl.narration?.trim());
  if (!missing.length) return;
  await exclusive(s, async () => {
    emit(s.deck.id, { type: 'status', text: 'Writing narration...' });
    const list = missing.map((sl) => `${s.deck.slides.indexOf(sl)}: ${sl.id} "${sl.title}"`).join('\n');
    await runTurn(s, `${NARRATION_KICKOFF}\nSlides missing narration (index: id "title"):\n${list}`, { chat: false });
  });
}
