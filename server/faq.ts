// Investor FAQ: one tool-free model call over the deck text + receipt summaries -> 8 sharp questions
// with short cited answers, stored on deck.faq.
import { cpMessage } from './cp.js';
import { emit, save, type Session } from './store.js';
import { deckBrief } from './debate.js';

const FAQ_SYSTEM = `You are a senior venture partner preparing an investment committee. Given a deck (as plain text) and the receipts (data pulls) behind it, write the 8 sharpest questions a sceptical investor would ask, each with a concise answer.
Rules: each answer is 2-4 sentences of markdown, grounded ONLY in the deck and receipts; cite the receipt id inline in square brackets right after the fact, e.g. "raised $1.05B in 2024 [r3]". Never invent numbers; if the data does not answer the question, say plainly what is not disclosed and what to ask the company. No em-dashes.
Output ONLY JSON: {"faq":[{"q":"...","a":"..."}]} with exactly 8 items.`;

const inFlight = new Set<string>();

function receiptLines(s: Session): string {
  const per = s.receipts.length > 30 ? 300 : 600;
  return s.receipts.map((r) => {
    let j = '';
    try { j = JSON.stringify(r.json) ?? ''; } catch { j = String(r.json); }
    return `${r.id} ${r.source} ${r.endpoint} ${JSON.stringify(r.params)}: ${j.slice(0, per)}`;
  }).join('\n');
}

function parseFaq(text: string): Array<{ q: string; a: string }> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    return (Array.isArray(j?.faq) ? j.faq : [])
      .map((x: any) => ({ q: String(x?.q ?? '').trim(), a: String(x?.a ?? '').trim() }))
      .filter((x: { q: string; a: string }) => x.q && x.a)
      .slice(0, 8);
  } catch { return []; }
}

/** Generate deck.faq (8 Q&As), emit 'deck' and save. Never touches the analyst conversation. */
export async function generateFaq(s: Session): Promise<void> {
  if (!s.deck.slides.length || inFlight.has(s.deck.id)) return;
  inFlight.add(s.deck.id);
  try {
    const e = s.deck.entity;
    const input = `Entity: ${e.name} (${e.kind})\n\nDECK:\n${deckBrief(s, 1200)}\n\nRECEIPTS (id source endpoint params: excerpt):\n${receiptLines(s)}`;
    const r = await cpMessage({ system: FAQ_SYSTEM, messages: [{ role: 'user', content: input }], shardKey: `${s.deck.id}-faq`, maxTokens: 6000 });
    const faq = parseFaq(r.content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join(''));
    if (!faq.length) throw new Error('FAQ writer returned no questions');
    s.deck.faq = faq;
    emit(s.deck.id, { type: 'deck', deck: s.deck });
    save(s);
  } finally {
    inFlight.delete(s.deck.id);
  }
}
