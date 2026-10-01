// The analyst agent: ONE conversation per session (s.messages) that builds the deck, answers Q&A,
// edits the deck and speaks. Tool calls of one turn run in parallel.
import { cpMessage, type ContentBlock } from './cp.js';
import { runToolBatch, toAnthropicTools, type ToolDef, type ToolUseBlock } from './tooling.js';
import { dealroomTools } from './dealroom.js';
import { webTools } from './web.js';
import { generateCoverImage } from './twoshot.js';
import { screenshotSlides, toImageBlocks } from './screenshot.js';
import { emit, save, setBusy, nowIso, shortId, type Session } from './store.js';
import { buildSystemPrompt, buildDeckKickoff, BULL_BEAR_KICKOFF, NARRATION_KICKOFF, REVIEW_SYSTEM, buildReviewInput, buildReviewFix } from './prompts.js';
import type { ChatMessage, Slide, SpeakVoice } from '../shared/types.js';
import { runParallelBuild, fixSlidesParallel } from './build.js';

/** Initial build path: 'parallel' (prefetch + planner + parallel writers) or 'serial' (one conversation). */
const BUILD_MODE = (process.env.BUILD_MODE ?? 'parallel') === 'serial' ? 'serial' : 'parallel';

const MAX_ROUNDS = 26; // build = data rounds + one round per streamed slide
const MAX_REVIEWS = 2;
const COVER_TOKEN = '{{COVER_IMAGE}}';
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
  if (typeof sl.html !== 'string' || !sl.html.trim()) delete sl.html;
  else if (s.deck.coverImage) sl.html = sl.html.split(COVER_TOKEN).join(s.deck.coverImage);
  return sl as Slide;
}

// ---------- deck tools ----------
const slideSchema = {
  type: 'object',
  description: 'A Slide object: {id, kind, title, narration, html} (see the system prompt). Every number in html cites its receipt with data-r.',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: [...KINDS] },
    title: { type: 'string' },
    subtitle: { type: 'string' },
    narration: { type: 'string' },
    html: { type: 'string', description: 'The slide itself: self-contained HTML fragment for a 1920x1080 canvas (see the system prompt). Cite numbers with data-r="<receipt id>".' },
  },
  required: ['kind', 'title'],
};

const statusTool: ToolDef = {
  name: 'set_status',
  description: 'Show the user ONE short line of what you are currently thinking or doing (e.g. "Funding is back-loaded; checking valuation history"). Call it alongside other tool calls.',
  input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async run(input, ctx) {
    const text = String(input.text ?? '').trim().slice(0, 160);
    if (text) emit(ctx.session.deck.id, { type: 'status', text });
    return 'ok';
  },
};

const deckTools: ToolDef[] = [
  statusTool,
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
    description: 'Insert or update ONE slide. Same id = update in place, merging the fields you send onto the existing slide (or move if index given). New id = insert at index (default: end).',
    input_schema: { type: 'object', properties: { index: { type: 'integer', description: '0-based position' }, slide: slideSchema }, required: ['slide'] },
    async run(input, ctx) {
      const s = ctx.session;
      const slides = s.deck.slides;
      const raw = parseMaybeJson(input.slide);
      const existingIdx = raw?.id ? slides.findIndex((x) => x.id === raw.id) : -1;
      // Same id = merge onto the existing slide, so a partial update ({id, narration}) never wipes its content.
      const slide = normSlide(existingIdx >= 0 && raw && typeof raw === 'object' ? { ...slides[existingIdx], ...raw } : raw, s);
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
  const system = buildSystemPrompt(s.deck.entity, s.thesis);
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
      // set_status (the model's own line) wins over the generic tool summary.
      const line = toolUses.some((u) => u.name === 'set_status') ? '' : statusLine(toolUses);
      if (line) ctx.status(line);
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
  uses = uses.filter((u) => u.name !== 'set_status');
  if (!uses.length) return '';
  if (uses.every((u) => u.name === 'speak_text')) return 'Speaking...';
  const parts = new Set<string>();
  for (const u of uses.filter((x) => x.name !== 'speak_text')) {
    const hit = LABELS.find(([re]) => re.test(u.name));
    parts.add(hit ? hit[1] : u.name.replace(/_/g, ' '));
  }
  const list = [...parts];
  const ups = uses.filter((u) => u.name === 'upsert_slide');
  if (list.length === 1 && list[0] === 'the deck') {
    const t = ups.length === 1 ? String(parseMaybeJson(ups[0].input?.slide)?.title ?? '').trim() : '';
    return t ? `Writing slide: ${t}...` : 'Updating the deck...';
  }
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

// ---------- review loop (initial build only) ----------
function receiptExcerpts(s: Session) {
  const per = s.receipts.length > 30 ? 900 : 1600;
  return s.receipts.map((r) => {
    let j = '';
    try { j = JSON.stringify(r.json); } catch { j = String(r.json); }
    return { id: r.id, endpoint: r.endpoint, params: r.params, excerpt: (j ?? '').slice(0, per) };
  });
}

function parseNotes(text: string): string[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    return (Array.isArray(j?.notes) ? j.notes : []).map((n: any) => String(n ?? '').trim()).filter(Boolean).slice(0, 8);
  } catch { return []; }
}

async function reviewDeck(s: Session): Promise<string[]> {
  const slides = s.deck.slides.map((sl) => ({ id: sl.id, kind: sl.kind, title: sl.title, html: sl.html }));
  // The reviewer also SEES the deck: rendered 960x540 screenshots, so it can judge cohesion and layout.
  const shots = await screenshotSlides(s.deck.slides).catch((err) => { console.warn('[agent] screenshots failed:', err?.message ?? err); return []; });
  const visual = shots.length
    ? '\n\nRendered screenshots of the slides are attached above. Also judge them VISUALLY as one deck: cohesive type scale, spacing, alignment and colour across slides; any text overflow, clipping or overlap; unreadable or empty charts; cramped or unbalanced layouts. Name the slide id for every visual note.'
    : '';
  const r = await cpMessage({
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: [...toImageBlocks(shots), { type: 'text', text: buildReviewInput(slides, receiptExcerpts(s)) + visual }] }],
    shardKey: `${s.deck.id}-review`,
    maxTokens: 4000,
  });
  const text = r.content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
  return parseNotes(text);
}

async function reviewLoop(s: Session, parallelFix = false) {
  for (let iteration = 1; iteration <= MAX_REVIEWS; iteration++) {
    emit(s.deck.id, { type: 'status', text: iteration === 1 ? 'Reviewing the deck...' : 'Re-reviewing the deck...' });
    let notes: string[];
    try { notes = await reviewDeck(s); } catch (err: any) {
      console.warn('[agent] review failed:', err?.message ?? err);
      emit(s.deck.id, { type: 'review', iteration, notes: [], done: true });
      return;
    }
    const done = !notes.length || iteration >= MAX_REVIEWS;
    emit(s.deck.id, { type: 'review', iteration, notes, done });
    if (done) return;
    emit(s.deck.id, { type: 'status', text: `Applying ${notes.length} reviewer fix${notes.length === 1 ? '' : 'es'}...` });
    const rest = parallelFix ? await fixSlidesParallel(s, notes, { statusTool, slideSchema, normSlide }).catch(() => notes) : notes;
    if (rest.length) await runTurn(s, buildReviewFix(rest), { chat: false });
  }
}

// ---------- public API ----------
function applyCover(s: Session, url: string) {
  s.deck.coverImage = url;
  for (const sl of s.deck.slides) {
    if (sl.kind === 'title' && !sl.image) sl.image = url;
    if (sl.html?.includes(COVER_TOKEN)) sl.html = sl.html.split(COVER_TOKEN).join(url);
  }
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
      let parallelOk = false;
      if (BUILD_MODE === 'parallel') {
        const saved = s.messages.slice();
        try {
          await runParallelBuild(s, buildDeckKickoff(e, s.thesis), { statusTool, slideSchema, normSlide });
          parallelOk = true;
        } catch (err: any) {
          console.warn('[agent] parallel build failed, falling back to serial:', err?.message ?? err);
          s.messages = saved;
          s.deck.slides = [];
          emit(s.deck.id, { type: 'deck', deck: s.deck });
          emit(s.deck.id, { type: 'status', text: 'Switching to step-by-step build...' });
        }
      }
      if (!parallelOk) await runTurn(s, buildDeckKickoff(e, s.thesis), { chat: true });
      if (s.deck.slides.length < 3) {
        emit(s.deck.id, { type: 'status', text: 'Writing the deck...' });
        await runTurn(s, 'The deck is not finished. Write the remaining slides NOW, one upsert_slide per turn in order, using only the data you already pulled (say "not disclosed" where data is missing).', { chat: false });
      }
      if (!s.deck.slides.length) {
        s.deck.status = 'error';
        emit(s.deck.id, { type: 'error', message: 'The agent did not produce any slides.' });
      } else {
        // Stay 'building' through the review loop: the player shows the loading screen until reviewed.
        await reviewLoop(s, parallelOk);
        s.deck.status = 'ready';
      }
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
