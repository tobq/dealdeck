// Session persistence (data/decks/<id>.json) + per-deck SSE event bus.
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import type { ChatMessage, Deck, DeckEntity, DeckEvent, DeckView, Receipt, ReceiptSummary } from '../shared/types.js';

const DIR = path.resolve('data/decks');
fs.mkdirSync(DIR, { recursive: true });

/** Anthropic Messages API content, kept verbatim so a resumed session continues the SAME conversation. */
export type ApiMessage = { role: 'user' | 'assistant'; content: unknown };

export interface Session {
  deck: Deck;
  chat: ChatMessage[];
  receipts: Receipt[];
  messages: ApiMessage[]; // full agent conversation incl. tool_use / tool_result / thinking blocks
  busy: boolean;
}

const cache = new Map<string, Session>();
const subscribers = new Map<string, Set<Response>>();

export const nowIso = () => new Date().toISOString();
export const shortId = (n = 6) => Math.random().toString(36).slice(2, 2 + n);
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'deck';

export function createSession(entity: DeckEntity, forkOf: Session | null = null): Session {
  const id = `${slugify(entity.name)}-${shortId()}`;
  const t = nowIso();
  const s: Session = forkOf
    ? { ...structuredClone(forkOf), busy: false }
    : { deck: { id, entity, title: entity.name, slides: [], status: 'building', createdAt: t, updatedAt: t }, chat: [], receipts: [], messages: [], busy: false };
  s.deck.id = id;
  if (forkOf) { s.deck.forkOf = forkOf.deck.id; s.deck.createdAt = t; s.deck.updatedAt = t; }
  cache.set(id, s);
  save(s);
  return s;
}

/** Deck ids are "<slug>-<6 chars>"; anything else (e.g. "../x") must never reach the filesystem. */
const VALID_ID = /^[a-z0-9-]{1,80}$/;

/** A turn killed mid tool-loop (restart, thrown tool batch, fork mid-build) leaves an assistant tool_use
 *  with no tool_result, which the Messages API rejects on the next turn. Answer each dangling call. */
export function repairMessages(s: Session) {
  const last = s.messages[s.messages.length - 1];
  if (last?.role !== 'assistant' || !Array.isArray(last.content)) return;
  const uses = (last.content as Array<{ type?: string; id?: string }>).filter((b) => b?.type === 'tool_use' && b.id);
  if (!uses.length) return;
  s.messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Interrupted before this tool finished; call it again if still needed.' })) });
}

export function getSession(id: string): Session | null {
  if (!VALID_ID.test(id)) return null;
  if (cache.has(id)) return cache.get(id)!;
  const f = path.join(DIR, `${id}.json`);
  if (!fs.existsSync(f)) return null;
  const s = JSON.parse(fs.readFileSync(f, 'utf8')) as Session;
  s.busy = false; // a restart kills any in-flight turn
  if (s.deck.status === 'building') s.deck.status = s.deck.slides.length ? 'ready' : 'error'; // no build is running any more
  repairMessages(s);
  cache.set(id, s);
  return s;
}

let saveTimers = new Map<string, NodeJS.Timeout>();
/** Debounced atomic write. */
export function save(s: Session) {
  s.deck.updatedAt = nowIso();
  clearTimeout(saveTimers.get(s.deck.id));
  saveTimers.set(s.deck.id, setTimeout(() => {
    const f = path.join(DIR, `${s.deck.id}.json`);
    // Inside a timer: an fs error here (Windows EPERM/EBUSY on rename while AV/indexer holds the file) would
    // be an uncaught exception that kills the server. Log and retry on the next save instead.
    try {
      fs.writeFileSync(f + '.tmp', JSON.stringify(s));
      fs.renameSync(f + '.tmp', f);
    } catch (e) {
      console.error('[store] save failed', s.deck.id, (e as Error).message);
      saveTimers.delete(s.deck.id);
      setTimeout(() => save(s), 500);
    }
  }, 150));
}

export function listRecent(limit = 12): Deck[] {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  const decks: Deck[] = [];
  for (const f of files) {
    try { const s = getSession(f.replace(/\.json$/, '')); if (s && !s.deck.forkOf && s.deck.slides.length) decks.push(s.deck); } catch { /* skip corrupt */ }
  }
  return decks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

export const summarize = (r: Receipt): ReceiptSummary => {
  const { json, ...rest } = r;
  return { ...rest, bytes: JSON.stringify(json ?? null).length };
};

export function view(s: Session): DeckView {
  return { deck: s.deck, chat: s.chat, receipts: s.receipts.map(summarize), busy: s.busy };
}

export function addReceipt(s: Session, r: Omit<Receipt, 'id' | 'at'>): Receipt {
  const receipt: Receipt = { ...r, id: `r${s.receipts.length + 1}`, at: nowIso() };
  s.receipts.push(receipt);
  emit(s.deck.id, { type: 'receipt', receipt: summarize(receipt) });
  save(s);
  return receipt;
}

export function setBusy(s: Session, busy: boolean) {
  if (busy) repairMessages(s); // a previous turn may have died between tool_use and tool_result
  s.busy = busy;
  emit(s.deck.id, { type: 'busy', busy });
}

export function emit(deckId: string, e: DeckEvent) {
  const subs = subscribers.get(deckId);
  if (!subs) return;
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of subs) { try { res.write(line); } catch { subs.delete(res); } }
}

export function subscribe(deckId: string, res: Response, s: Session) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`data: ${JSON.stringify({ type: 'snapshot', view: view(s) } satisfies DeckEvent)}\n\n`);
  if (!subscribers.has(deckId)) subscribers.set(deckId, new Set());
  subscribers.get(deckId)!.add(res);
  res.on('error', () => subscribers.get(deckId)?.delete(res));
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 15000);
  res.on('close', () => { clearInterval(ka); subscribers.get(deckId)?.delete(res); });
}
