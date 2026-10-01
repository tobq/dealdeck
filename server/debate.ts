// Bull vs Bear: two independent agents, each with its own persona and private reasoning, debating
// whether to invest in the company (or fund), turn by turn. Lines are written sequentially: each side
// replies only after hearing the other's last line, and every line is emitted (and starts playing) as
// soon as it is written.
import { cpMessage } from './cp.js';
import { emit, nowIso, save, setBusy, shortId, type Session } from './store.js';
import type { Slide, SpeakVoice } from '../shared/types.js';

const ROUNDS = 3; // each side speaks 3 times

export const stripHtml = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** One slide as plain text (html stripped, or the structured fields). */
export function slideText(sl: Slide): string {
  return sl.html ? stripHtml(sl.html) : JSON.stringify({ ...sl, id: undefined, narration: undefined, html: undefined });
}

/** The deck as plain text: what both debaters (and the FAQ writer) argue from. */
export function deckBrief(s: Session, perSlide = 1500): string {
  return s.deck.slides.map((sl, i) => `Slide ${i + 1} - ${sl.title}: ${slideText(sl).slice(0, perSlide)}`).join('\n');
}

const PERSONA: Record<'bull' | 'bear', string> = {
  bull: 'You are the BULL: a conviction-driven venture partner arguing FOR investing. You find the upside, the momentum, the asymmetric bet.',
  bear: 'You are the BEAR: a sceptical, forensic venture partner arguing AGAINST investing. You find the risks, the weak data, the valuation stretch.',
};

function system(side: 'bull' | 'bear', s: Session): string {
  const e = s.deck.entity;
  const subject = e.kind === 'investor' ? `the fund ${e.name}` : `the company ${e.name}`;
  return `${PERSONA[side]}
You are in a live, spoken investment-committee debate, in front of an audience, about whether to invest in ${subject}. Argue about the business and the investment decision, never about the deck or its slides.
Rules: reply with ONE spoken line of 1-2 short sentences (under 40 words), punchy and conversational, no lists, no markdown, no citations or receipt ids, no stage directions. Ground every claim in the research facts below; never invent numbers. Directly rebut the other side's last point when there is one; do not repeat yourself. Think privately first if useful, then output only the line.

RESEARCH FACTS:
${deckBrief(s)}`;
}

async function line(side: 'bull' | 'bear', s: Session, transcript: Array<{ side: string; text: string }>, final: boolean): Promise<string> {
  const history = transcript.length
    ? transcript.map((t) => `${t.side.toUpperCase()}: ${t.text}`).join('\n')
    : '(you open the debate)';
  const ask = `Debate so far:\n${history}\n\nYour turn${final ? ' (your closing line: land your single strongest point)' : ''}. Reply with the line only.`;
  const r = await cpMessage({ system: system(side, s), messages: [{ role: 'user', content: ask }], shardKey: `${s.deck.id}-${side}`, maxTokens: 1200 });
  return r.content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join(' ').replace(/\s+/g, ' ').trim()
    .replace(/^(BULL|BEAR)\s*:\s*/i, '');
}

export async function runDebate(s: Session): Promise<void> {
  if (s.busy) { emit(s.deck.id, { type: 'error', message: 'Busy - try again in a moment.' }); return; }
  setBusy(s, true);
  const transcript: Array<{ side: 'bull' | 'bear'; text: string }> = [];
  s.deck.debate = []; // the deck keeps only the latest debate
  emit(s.deck.id, { type: 'deck', deck: s.deck });
  try {
    emit(s.deck.id, { type: 'status', text: 'Bull and Bear are preparing...' });
    for (let i = 0; i < ROUNDS * 2; i++) {
      const side: 'bull' | 'bear' = i % 2 === 0 ? 'bull' : 'bear';
      const final = i >= ROUNDS * 2 - 2;
      let text = await line(side, s, transcript, final);
      if (!text) text = await line(side, s, transcript, final); // one retry (e.g. an empty reply or refusal)
      if (!text) continue;
      transcript.push({ side, text });
      const id = shortId(8);
      emit(s.deck.id, { type: 'speak', id, text, voice: side as SpeakVoice });
      (s.deck.debate ??= []).push({ id, side, text });
      emit(s.deck.id, { type: 'deck', deck: s.deck });
      save(s);
    }
    const summary = transcript.map((t) => `**${t.side === 'bull' ? 'Bull' : 'Bear'}:** ${t.text}`).join('\n');
    const msg = { id: shortId(8), role: 'assistant' as const, text: `Bull vs Bear debate\n${summary}`, at: nowIso() };
    s.chat.push(msg);
    // Keep the analyst's conversation aware of the debate for later questions.
    s.messages.push({ role: 'user', content: [{ type: 'text', text: `(The audience just heard this Bull vs Bear debate about ${s.deck.entity.name}:)\n${summary}` }] });
    s.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Noted the debate.' }] });
    emit(s.deck.id, { type: 'chat', message: msg });
    save(s);
  } catch (err: any) {
    console.error('[bullbear]', s.deck.id, err?.message ?? err);
    emit(s.deck.id, { type: 'error', message: 'The debate hit a snag, try again.' });
  } finally {
    setBusy(s, false);
  }
}
