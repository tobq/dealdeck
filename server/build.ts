// Parallel initial build: prefetch the standard Dealroom bundle directly, ONE planner turn that returns an
// outline + shared style brief, then one independent writer call per slide, all in parallel.
// Any throw here makes agent.ts fall back to the serial build for that deck.
import { cpMessage, type ContentBlock } from './cp.js';
import { runToolBatch, toAnthropicTools, type ToolDef, type ToolCtx, type ToolUseBlock } from './tooling.js';
import { dealroomTools } from './dealroom.js';
import { webTools } from './web.js';
import { emit, save, type Session } from './store.js';
import { buildPlannerSystem, buildPlannerKickoff, buildWriterSystem, buildWriterTask } from './prompts.js';
import type { Slide } from '../shared/types.js';

const MAX_PLANNER_ROUNDS = 4;
const PER_RESULT_CHARS = 12_000;

interface Pull { label: string; tool: string; input: Record<string, unknown> }
export interface OutlineSlide { id: string; kind?: string; title: string; purpose?: string; key_facts?: string[]; receipts?: string[]; visual?: string }
export interface Outline { title: string; style_brief: string; slides: OutlineSlide[] }

export interface BuildDeps {
  statusTool: ToolDef;
  slideSchema: object;
  normSlide(raw: any, s: Session, fallbackId?: string): Slide;
}

function bundle(s: Session): Pull[] {
  const { uuid, kind } = s.deck.entity;
  if (kind === 'investor') {
    return [
      { label: 'Profile', tool: 'dealroom_investor', input: { uuid } },
      ...(['portfolio', 'funds', 'team', 'deals', 'lp_positions'] as const).map((section) => ({ label: section.replace(/_/g, ' '), tool: 'dealroom_investor_section', input: { uuid, section } })),
    ];
  }
  return [
    { label: 'Profile', tool: 'dealroom_company', input: { uuid, currency: 'USD' } },
    ...(['funding_rounds', 'investors', 'team', 'similar', 'valuations', 'web_traffic', 'financials', 'news', 'headcount'] as const)
      .map((section) => ({ label: section.replace(/_/g, ' '), tool: 'dealroom_company_section', input: { uuid, section, ...(section === 'web_traffic' ? { limit: 24 } : {}) } })),
  ];
}

const cap = (txt: string) => (txt.length > PER_RESULT_CHARS ? txt.slice(0, PER_RESULT_CHARS) + '...[truncated]' : txt);
const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Run the standard bundle in parallel straight through the tools' run() (receipts are created normally). */
async function prefetch(s: Session): Promise<string> {
  const quiet: ToolCtx = { session: s, status: () => {} };
  const byName = new Map(dealroomTools.map((t) => [t.name, t]));
  const parts = await Promise.all(bundle(s).map(async (p) => {
    try {
      const out: any = await byName.get(p.tool)!.run(p.input, quiet);
      const n = Array.isArray(out?.data) ? out.data.length : null;
      emit(s.deck.id, { type: 'status', text: `${sentence(p.label)} in${n !== null ? ` (${n} row${n === 1 ? '' : 's'})` : ''}` });
      return `### ${p.tool} ${JSON.stringify(p.input)} -> receipt ${out?.receipt ?? '?'}\n${cap(JSON.stringify(out))}`;
    } catch (e: any) {
      return `### ${p.tool} ${JSON.stringify(p.input)} -> error: ${String(e?.message ?? e).slice(0, 200)}`;
    }
  }));
  return parts.join('\n\n');
}

function textOf(content: ContentBlock[]): string {
  return content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
}

function parseJson(v: any): any {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

/** Returns the outline and the planner's conversation (prefetch context + any extra lookups). */
async function plan(s: Session, context: string, deps: BuildDeps): Promise<{ outline: Outline; messages: Array<{ role: 'user' | 'assistant'; content: any }>; extra: string[] }> {
  let outline: Outline | null = null;
  const submit: ToolDef = {
    name: 'submit_outline',
    description: 'Submit the deck plan: title, shared style brief, and the slides in order (as many as the story needs, typically 6-12). Call exactly once, when you have the data you need.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        style_brief: { type: 'string', description: 'Shared visual language for ALL slides: layout grid and margins, type scale (px per role), colour use, chart style, citation style. Concrete, 5-10 lines.' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'short slug, first slide "title"' },
              kind: { type: 'string' },
              title: { type: 'string' },
              purpose: { type: 'string', description: 'the one message of this slide' },
              key_facts: { type: 'array', items: { type: 'string' }, description: 'facts/numbers to show, each with its receipt id e.g. "Series D $250M Mar 2024 [r3]"' },
              receipts: { type: 'array', items: { type: 'string' } },
              visual: { type: 'string', description: 'layout / chart idea' },
            },
            required: ['id', 'title', 'purpose'],
          },
        },
      },
      required: ['title', 'style_brief', 'slides'],
    },
    async run(input) {
      const slides = parseJson(input.slides);
      if (!Array.isArray(slides) || slides.length < 3) throw new Error('slides must be an array of at least 3 slides');
      const seen = new Set<string>();
      outline = {
        title: String(input.title ?? s.deck.entity.name),
        style_brief: String(input.style_brief ?? ''),
        slides: slides.map((x: any, i: number) => {
          let id = String(x?.id ?? '').trim().replace(/[^\w-]/g, '') || `s${i + 1}`;
          if (seen.has(id)) id = `${id}${i + 1}`;
          seen.add(id);
          return { ...x, id, title: String(x?.title ?? '') };
        }),
      };
      return { ok: true, slides: outline.slides.length };
    },
  };
  const tools = [...dealroomTools, ...webTools, deps.statusTool, submit];
  const apiTools = toAnthropicTools(tools);
  const system = buildPlannerSystem(s.deck.entity, s.thesis);
  const ctx: ToolCtx = { session: s, status: (text) => emit(s.deck.id, { type: 'status', text }) };
  const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [{ role: 'user', content: [{ type: 'text', text: buildPlannerKickoff(s.deck.entity, s.thesis, context) }] }];
  const extra: string[] = [];
  for (let round = 0; round < MAX_PLANNER_ROUNDS && !outline; round++) {
    const last = round === MAX_PLANNER_ROUNDS - 1;
    emit(s.deck.id, { type: 'status', text: round === 0 ? 'Planning the story...' : last ? 'Finalising the outline...' : 'Checking extra data...' });
    if (last) messages[messages.length - 1].content.push({ type: 'text', text: 'Last round: call submit_outline NOW with what you have.' });
    const r = await cpMessage({ system, messages, tools: apiTools, shardKey: `${s.deck.id}-plan`, maxTokens: 12000 });
    const content = r.content.filter((b) => !(b.type === 'text' && !String(b.text ?? '').trim()));
    if (!content.length) break;
    messages.push({ role: 'assistant', content });
    const uses = content.filter((b) => b.type === 'tool_use') as unknown as ToolUseBlock[];
    if (!uses.length) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Call submit_outline now.' }] });
      continue;
    }
    const results = await runToolBatch(tools, uses, ctx);
    uses.forEach((u, i) => {
      if (u.name.startsWith('dealroom_') || u.name.startsWith('web_')) extra.push(`### ${u.name} ${JSON.stringify(u.input)}\n${cap(results[i].content)}`);
    });
    messages.push({ role: 'user', content: results });
  }
  if (!outline) throw new Error('planner did not submit an outline');
  return { outline, messages, extra };
}

/** One writer: independent call whose only tool is write_slide. Returns the raw slide. */
async function writeSlide(s: Session, outline: Outline, i: number, data: string, deps: BuildDeps): Promise<any> {
  const writeTool = { name: 'write_slide', description: 'Submit the finished slide. Call exactly once.', input_schema: { type: 'object', properties: { slide: deps.slideSchema }, required: ['slide'] } };
  const o = outline.slides[i];
  const system = buildWriterSystem(outline.style_brief);
  const messages = [{ role: 'user' as const, content: [
    { type: 'text', text: `DATA (tool results with receipt ids):\n${data}` },
    { type: 'text', text: buildWriterTask(s.deck.entity, outline, i) },
  ] }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await cpMessage({ system, messages, tools: [writeTool], shardKey: `${s.deck.id}-w${i}`, maxTokens: 12000 });
    const use = r.content.find((b) => b.type === 'tool_use' && b.name === 'write_slide');
    const raw = use ? parseJson(use.input?.slide) : parseJson((textOf(r.content).match(/\{[\s\S]*\}/) ?? [''])[0]);
    if (raw && typeof raw === 'object' && typeof raw.html === 'string' && raw.html.trim()) return { ...raw, id: o.id, title: raw.title || o.title };
  }
  throw new Error(`writer for slide ${i + 1} (${o.id}) returned no html`);
}

/** Build the deck in parallel; on success s.deck.slides is filled and s.messages holds a compact summary. */
export async function runParallelBuild(s: Session, kickoff: string, deps: BuildDeps): Promise<void> {
  const deckId = s.deck.id;
  const t0 = Date.now();
  const context = await prefetch(s);
  console.log(`[build] ${deckId} prefetch ${Date.now() - t0}ms`);
  emit(deckId, { type: 'status', text: 'Planning the deck...' });
  const { outline, messages, extra } = await plan(s, context, deps);
  console.log(`[build] ${deckId} outline ${outline.slides.length} slides at ${Date.now() - t0}ms`);
  s.deck.title = outline.title || s.deck.title;
  emit(deckId, { type: 'status', text: `Writing ${outline.slides.length} slides in parallel...` });
  const data = [context, ...extra].join('\n\n');
  rememberBuild(s, data, outline);
  const placed: Array<Slide | null> = outline.slides.map(() => null);
  let done = 0;
  const writeOne = async (i: number) => {
    const raw = await writeSlide(s, outline, i, data, deps);
    placed[i] = deps.normSlide(raw, s, outline.slides[i].id);
    done++;
    s.deck.slides = placed.filter((x): x is Slide => !!x);
    emit(deckId, { type: 'deck', deck: s.deck });
    emit(deckId, { type: 'status', text: `Slide ${i + 1} of ${outline.slides.length} written (${done}/${outline.slides.length} done)` });
    if (done === 1) console.log(`[build] ${deckId} first slide at ${Date.now() - t0}ms`);
    save(s);
  };
  const rejectedIdx = (st: PromiseSettledResult<void>[], idx: number[], pass: string) => idx.filter((i, k) => {
    const r = st[k];
    if (r.status !== 'rejected') return false;
    console.warn(`[build] ${deckId} writer ${i + 1} (${outline.slides[i].id}) rejected (${pass}):`, (r.reason as any)?.message ?? r.reason);
    return true;
  });
  const all = outline.slides.map((_, i) => i);
  const retry = rejectedIdx(await Promise.allSettled(all.map(writeOne)), all, 'first try');
  let failed = 0;
  if (retry.length) {
    emit(deckId, { type: 'status', text: `Retrying ${retry.length} slide${retry.length === 1 ? '' : 's'}...` });
    failed = rejectedIdx(await Promise.allSettled(retry.map(writeOne)), retry, 'retry').length;
  }
  console.log(`[build] ${deckId} slides written ${done}/${outline.slides.length} at ${Date.now() - t0}ms`);
  if (done < Math.min(3, outline.slides.length)) throw new Error(`only ${done} slides written`);

  // Keep the main conversation coherent for Q&A: data + outline + what was built.
  const summary = s.deck.slides.map((sl, i) => `${i}: id=${sl.id} kind=${sl.kind} "${sl.title}"`).join('\n');
  const lastPlanner = messages[messages.length - 1];
  const note = { type: 'text', text: `${kickoff}\n(The slides were then written from this outline in parallel.)` };
  if (lastPlanner.role === 'user') lastPlanner.content = [...(lastPlanner.content as any[]), note];
  else messages.push({ role: 'user', content: [note] });
  s.messages = [
    ...messages,
    { role: 'assistant', content: [{ type: 'text', text: `Built "${s.deck.title}" (${s.deck.slides.length} slides${failed ? `, ${failed} failed and were dropped` : ''}). Style brief: ${outline.style_brief}\nSlides (index: id kind "title"):\n${summary}\nAll data above carries receipt ids; I edit slides with upsert_slide (same id).` }] },
  ] as any;
  save(s);
}

/** Data + brief of the last parallel build per session, so reviewer fixes can also run per slide in parallel. */
const buildMemo = new WeakMap<Session, { data: string; outline: Outline }>();
export function rememberBuild(s: Session, data: string, outline: Outline) { buildMemo.set(s, { data, outline }); }

/** Apply reviewer notes "<slide id>: <fix>" with one independent fixer per slide, in parallel.
 * Returns the notes it could not map to a slide (the caller sends those to the main conversation). */
export async function fixSlidesParallel(s: Session, notes: string[], deps: BuildDeps): Promise<string[]> {
  const memo = buildMemo.get(s);
  if (!memo) return notes;
  const bySlide = new Map<string, string[]>();
  const rest: string[] = [];
  for (const n of notes) {
    const id = n.split(':')[0].trim();
    if (s.deck.slides.some((sl) => sl.id === id)) bySlide.set(id, [...(bySlide.get(id) ?? []), n]);
    else rest.push(n);
  }
  const writeTool = { name: 'write_slide', description: 'Submit the fixed slide. Call exactly once.', input_schema: { type: 'object', properties: { slide: deps.slideSchema }, required: ['slide'] } };
  await Promise.all([...bySlide.entries()].map(async ([id, ns]) => {
    const cur = s.deck.slides.find((sl) => sl.id === id);
    if (!cur) return;
    try {
      const r = await cpMessage({
        system: buildWriterSystem(memo.outline.style_brief),
        messages: [{ role: 'user', content: [
          { type: 'text', text: `DATA (tool results with receipt ids):\n${memo.data}` },
          { type: 'text', text: `Current slide JSON:\n${JSON.stringify({ id: cur.id, kind: cur.kind, title: cur.title, narration: cur.narration, html: cur.html })}\n\nReviewer notes for this slide:\n${ns.map((n) => `- ${n}`).join('\n')}\nFix every note and return the FULL fixed slide (same id "${id}") via write_slide.` },
        ] }],
        tools: [writeTool], shardKey: `${s.deck.id}-fix-${id}`, maxTokens: 12000,
      });
      const use = r.content.find((b) => b.type === 'tool_use' && b.name === 'write_slide');
      const raw = use ? parseJson(use.input?.slide) : null;
      if (!raw || typeof raw !== 'object' || typeof raw.html !== 'string' || !raw.html.trim()) return;
      const idx = s.deck.slides.findIndex((sl) => sl.id === id);
      if (idx < 0) return;
      const slide = deps.normSlide({ ...s.deck.slides[idx], ...raw, id }, s, id);
      s.deck.slides[idx] = slide;
      emit(s.deck.id, { type: 'slide', slide, index: idx });
      save(s);
    } catch (e: any) {
      console.warn(`[build] fixer ${id} failed:`, e?.message ?? e);
    }
  }));
  // Record the fixes in the main conversation so Q&A knows the deck changed.
  const last = s.messages[s.messages.length - 1];
  if (last?.role === 'assistant') {
    s.messages.push({ role: 'user', content: [{ type: 'text', text: `Reviewer notes applied per slide:\n${[...bySlide.values()].flat().map((n) => `- ${n}`).join('\n')}` }] } as any);
    s.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Applied the reviewer fixes to those slides.' }] } as any);
  }
  save(s);
  return rest;
}
