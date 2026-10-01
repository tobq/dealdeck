// Shared wire contracts between server/ and web/. Every module codes against THIS file.

export type EntityKind = 'company' | 'investor';

export interface SearchHit {
  uuid: string;
  type: 'company' | 'investor' | 'person' | 'university' | 'gov_ngo';
  name: string;
  tagline: string | null;
  image: string | null;
  hqCity: string | null;
  hqCountry: string | null;
  websiteDomain: string | null;
  isUnicorn: boolean | null;
  investorRank: number | null;
}

/** One external call the agent made. Every number on a slide points at one or more of these. */
export interface Receipt {
  id: string; // short, e.g. "r7"
  source: 'dealroom' | 'web' | 'twoshot';
  endpoint: string; // "/data/companies/{uuid}/funding-rounds" or a web URL
  params: Record<string, unknown>;
  status: number;
  ms: number;
  at: string; // ISO
  json: unknown; // full response body (parsed JSON, or {text} for web pages, truncated to ~200KB)
}
export type ReceiptSummary = Omit<Receipt, 'json'> & { bytes: number };

export interface Cited { receipts?: string[] }

export interface ChartSeries { name: string; points: Array<{ x: string; y: number }> }

export interface Slide {
  id: string;
  kind: 'title' | 'metrics' | 'bullets' | 'chart' | 'table' | 'people' | 'compare' | 'questions';
  title: string;
  subtitle?: string;
  bullets?: Array<{ text: string } & Cited>;
  metrics?: Array<{ label: string; value: string; note?: string } & Cited>;
  chart?: { type: 'bar' | 'line'; unit?: string; yLabel?: string; series: ChartSeries[] } & Cited;
  table?: { columns: string[]; rows: Array<{ cells: string[] } & Cited> };
  people?: Array<{ name: string; role: string; blurb?: string; image?: string } & Cited>;
  /** compare = two columns, e.g. Bull vs Bear, us vs them */
  compare?: { left: { heading: string; points: Array<{ text: string } & Cited> }; right: { heading: string; points: Array<{ text: string } & Cited> } };
  image?: string; // hero/cover image url (title slide)
  narration?: string; // speaker notes for Present mode, 1-3 spoken sentences
  /**
   * Expressive mode (preferred): a self-contained HTML fragment for a 1920x1080 canvas, rendered in a
   * sandboxed iframe on top of the base stylesheet (web/src/lib/slideDoc.ts: Inter, --accent #3b5bfd,
   * --ink, --muted, --line, --good, --bad). Inline <style>/<svg> allowed; scripts only via
   * <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script> + inline script. Citations: any
   * element with data-r="r3" (e.g. <sup class="cite" data-r="r3">r3</sup>) opens that receipt.
   * When html is present the structured fields above are optional.
   */
  html?: string;
}

export interface DeckEntity { uuid: string; kind: EntityKind; name: string; image?: string | null; tagline?: string | null; websiteDomain?: string | null }

export interface Deck {
  id: string; // url id, "<slug>-<6 chars>"
  entity: DeckEntity;
  title: string;
  slides: Slide[];
  coverImage?: string | null;
  status: 'building' | 'ready' | 'error';
  createdAt: string;
  updatedAt: string;
  forkOf?: string | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string; // written answer (markdown ok)
  spoken?: string; // what was said aloud, if voice
  at: string;
}

/** GET /api/decks/:id */
export interface DeckView { deck: Deck; chat: ChatMessage[]; receipts: ReceiptSummary[]; busy: boolean }

export type SpeakVoice = 'narrator' | 'bull' | 'bear';

/** Server-Sent Events on GET /api/decks/:id/events (each `data:` line is one DeckEvent JSON). */
export type DeckEvent =
  | { type: 'snapshot'; view: DeckView } // first event on connect
  | { type: 'deck'; deck: Deck } // full deck replace (after set_deck / status change)
  | { type: 'slide'; slide: Slide; index: number } // upsert one slide at index
  | { type: 'slide_removed'; id: string }
  | { type: 'status'; text: string } // progress line, e.g. "Pulling funding rounds..."
  | { type: 'receipt'; receipt: ReceiptSummary }
  | { type: 'busy'; busy: boolean }
  | { type: 'assistant_delta'; text: string } // streaming written answer
  | { type: 'chat'; message: ChatMessage } // a finished user or assistant message
  | { type: 'speak'; id: string; text: string; voice: SpeakVoice; interject?: boolean }
  | { type: 'review'; iteration: number; notes: string[]; done: boolean } // reviewer loop progress
  | { type: 'error'; message: string };

/** POST /api/decks body. `thesis` (optional) adds a "Thesis fit" slide to company decks. */
export interface CreateDeckBody { uuid: string; kind: EntityKind; name: string; thesis?: string }

/** POST /api/suggest body: a free-text thesis and/or the user's own fund (investor uuid). */
export interface SuggestBody { thesis?: string; fundUuid?: string; fundName?: string; limit?: number }
export interface Suggestion {
  uuid: string;
  kind: EntityKind; // always 'company' today
  name: string;
  image: string | null;
  tagline: string | null;
  hqCity: string | null;
  hqCountry: string | null;
  lastRound: string | null; // e.g. "$12M Series A, Mar 2026"
  why: string; // one sentence: why it fits the thesis
  receipts?: string[];
}
/** POST /api/suggest response (takes ~10-30s; the UI shows a progress state). */
export interface SuggestResponse { thesisSummary: string; suggestions: Suggestion[] }
/** POST /api/import body: any Dealroom URL or path, e.g. "app.dealroom.co/companies/synthesia" */
export interface ImportBody { url: string }
/** POST /api/decks/:id/chat body */
export interface ChatBody { text: string; voice?: boolean }
/** POST /api/share response */
export interface ShareInfo { url: string; qrDataUrl: string }
