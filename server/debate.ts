// Bull vs Bear: two independent agents, each with its own persona and private reasoning, debating
// the deck turn by turn. Every line is emitted (and starts playing) as soon as it is written, while
// the other side is already preparing its reply.
import { cpMessage } from './cp.js';
import { emit, nowIso, save, setBusy, shortId, type Session } from './store.js';
import type { SpeakVoice } from '../shared/types.js';

const ROUNDS = 3; // each side speaks 3 times

const stripHtml = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The deck as plain text: what both debaters argue from. */
function deckBrief(s: Session): string {
  return s.deck.slides.map((sl, i) => {
    const body = sl.html ? stripHtml(sl.html) : JSON.stringify({ ...sl, id: undefined, narration: undefined });
    return `Slide ${i + 1} - ${sl.title}: ${body.slice(0, 1500)}`;
  }).join('\n');
}

const PERSONA: Record<'bull' | 'bear', string> = {
  bull: 'You are the BULL: a conviction-driven venture partner arguing FOR investing. You find the upside, the momentum, the asymmetric bet.',
  bear: 'You are the BEAR: a sceptical, forensic venture partner arguing AGAINST investing. You find the risks, the weak data, the valuation stretch.',
};

function system(side: 'bull' | 'bear', s: Session): string {
  const e = s.deck.entity;
  return `${PERSONA[side]}
You are in a live, spoken investment-committee debate about ${e.name} (${e.kind}), in front of an audience.
Rules: reply with ONE spoken line of 1-2 short sentences (under 40 words), punchy and conversational, no lists, no markdown, no citations or receipt ids, no stage directions. Ground every claim in the deck facts below; never invent numbers. Directly rebut the other side's last point when there is one; do not repeat yourself. Think privately first if useful, then output only the line.

DECK FACTS:
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
  try {
    emit(s.deck.id, { type: 'status', text: 'Bull and Bear are preparing...' });
    for (let i = 0; i < ROUNDS * 2; i++) {
      const side: 'bull' | 'bear' = i % 2 === 0 ? 'bull' : 'bear';
      const text = await line(side, s, transcript, i >= ROUNDS * 2 - 2);
      if (!text) continue;
      transcript.push({ side, text });
      emit(s.deck.id, { type: 'speak', id: shortId(8), text, voice: side as SpeakVoice });
    }
    const summary = transcript.map((t) => `**${t.side === 'bull' ? 'Bull' : 'Bear'}:** ${t.text}`).join('\n');
    const msg = { id: shortId(8), role: 'assistant' as const, text: `Bull vs Bear debate\n${summary}`, at: nowIso() };
    s.chat.push(msg);
    // Keep the analyst's conversation aware of the debate for later questions.
    s.messages.push({ role: 'user', content: [{ type: 'text', text: `(The audience just heard this Bull vs Bear debate about the deck:)\n${summary}` }] });
    s.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Noted the debate.' }] });
    emit(s.deck.id, { type: 'chat', message: msg });
    save(s);
  } catch (err: any) {
    emit(s.deck.id, { type: 'error', message: `Debate failed: ${err?.message ?? err}` });
  } finally {
    setBusy(s, false);
  }
}
