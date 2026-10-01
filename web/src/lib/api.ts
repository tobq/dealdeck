// Typed fetch helpers for every Dealdeck API route.
import type {
  ChatBody, CreateDeckBody, Deck, DeckView, EntityKind, ImportBody, Receipt, SearchHit, ShareInfo, SuggestBody, SuggestResponse,
} from '../../../shared/types';

async function req<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `${res.status} ${res.statusText}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data as T;
}

export const api = {
  search: (q: string, signal?: AbortSignal) =>
    req<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`, undefined, signal),
  createDeck: (body: CreateDeckBody) => req<{ id: string }>('POST', '/api/decks', body),
  importUrl: (url: string) => req<{ id: string }>('POST', '/api/import', { url } satisfies ImportBody),
  getDeck: (id: string) => req<DeckView>('GET', `/api/decks/${encodeURIComponent(id)}`),
  eventsUrl: (id: string) => `/api/decks/${encodeURIComponent(id)}/events`,
  receipt: (id: string, rid: string) =>
    req<Receipt>('GET', `/api/decks/${encodeURIComponent(id)}/receipts/${encodeURIComponent(rid)}`),
  chat: (id: string, text: string, opts: { voice?: boolean } = {}) =>
    req<unknown>('POST', `/api/decks/${encodeURIComponent(id)}/chat`, { text, voice: opts.voice } satisfies ChatBody),
  fork: (id: string) => req<{ id: string }>('POST', `/api/decks/${encodeURIComponent(id)}/fork`, {}),
  bullbear: (id: string) => req<unknown>('POST', `/api/decks/${encodeURIComponent(id)}/bullbear`, {}),
  narrate: (id: string) => req<unknown>('POST', `/api/decks/${encodeURIComponent(id)}/narrate`, {}),
  recent: () => req<Deck[]>('GET', '/api/recent'),
  suggest: (body: SuggestBody, signal?: AbortSignal) => req<SuggestResponse>('POST', '/api/suggest', body, signal),
  share: (deckId: string) => req<ShareInfo>('POST', '/api/share', { deckId }),
  sttToken: () => req<{ token: string }>('GET', '/api/stt-token'),
  ttsUrl: '/api/tts',
};

/** Search by name, pick the best company/investor hit, create a deck. Returns the deck id. */
export async function createDeckFromHit(hit: { uuid: string; type: string; name: string }): Promise<string> {
  const kind: EntityKind = hit.type === 'investor' ? 'investor' : 'company';
  const { id } = await api.createDeck({ uuid: hit.uuid, kind, name: hit.name });
  return id;
}

export async function createDeckByName(name: string): Promise<string> {
  const hits = await api.search(name);
  const usable = hits.filter((h) => h.type === 'company' || h.type === 'investor');
  const exact = usable.find((h) => h.name.toLowerCase() === name.toLowerCase());
  const hit = exact || usable[0];
  if (!hit) throw new Error(`No Dealroom match for "${name}"`);
  return createDeckFromHit(hit);
}

// --- tiny pathname router -------------------------------------------------
export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
