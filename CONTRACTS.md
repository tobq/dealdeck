# Dealdeck module contracts (read with shared/types.ts and PLAN.md)

Runtime: Node 24 + tsx (no build step), ESM, `import ... from './x.js'` style relative imports.
One process on PORT (5178): Express API under /api + Vite middleware serving web/ (SPA).
Env (.env, loaded by server/index.ts via dotenv): DEALROOM_CLIENT_ID, DEALROOM_CLIENT_SECRET,
ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, TWOSHOT_API_KEY, CP_BASE_URL, CP_MODEL, CP_EFFORT,
CP_FALLBACK_SPEC, PORT, optional DEALROOM_PROXY (http proxy url for Dealroom egress).
NEVER log secret values. No mocks / fake data anywhere.

## Shared tool shape (server/tooling.ts - owned by the AGENT module author)
```ts
export interface ToolCtx { session: Session; status(text: string): void }
export interface ToolDef {
  name: string; description: string; input_schema: object; // JSON Schema
  run(input: any, ctx: ToolCtx): Promise<unknown>; // returned value is JSON.stringified into tool_result
}
```
Tools that call external services MUST call `addReceipt(ctx.session, {...})` (server/store.ts) and
return `{ receipt: <id>, data: <trimmed json> }` so the model can cite receipt ids on slides.

## server/dealroom.ts (DEALROOM module)
- Base: `https://api.beta.dealroom.app` (paths have NO /api prefix, e.g. `/data/search`).
  Token: POST https://accounts.dealroom.co/oauth/token, audience `https://api.beta.dealroom.app`,
  client_credentials; cache 24h. Headers: `Authorization: Bearer`, `X-Client-Id`, browser User-Agent.
  Egress: Dealroom's Cloudflare blocks this PC's VPN IP; support optional DEALROOM_PROXY via undici ProxyAgent.
- Spec: .dealroom-kit/openapi-beta.yaml (1MB - grep it, don't read whole), docs dir .dealroom-kit/.
- `export async function searchEntities(q: string, types?: string): Promise<SearchHit[]>`
- `export async function dealroomGet(path: string, query?: Record<string, string|number|boolean>): Promise<{ status: number; json: any; ms: number }>`
- `export async function resolveDealroomUrl(url: string): Promise<{ uuid: string; kind: EntityKind; name: string; image?: string|null; tagline?: string|null } | null>`
  (accepts "app.dealroom.co/companies/<slug>", "/companies/<slug>", "/investors/<slug>", full urls)
- `export const dealroomTools: ToolDef[]` - typed tools for the agent: search, company profile,
  funding rounds, investors, team/founders, similar companies, valuations, headcount, web traffic,
  news, jobs, investor profile, investor portfolio, investor funds, LP fund positions, transactions,
  plus a generic `dealroom_get(path, query)` escape hatch. Trim responses (drop huge arrays/fields)
  before returning to the model; the FULL json goes into the receipt.

## server/web.ts (DEALROOM module author also owns this)
- `export const webTools: ToolDef[]` - `web_search` (DuckDuckGo html endpoint, top 8 results) and
  `web_fetch` (fetch url, strip html to text, 12k chars). Both add receipts (source 'web').

## server/cp.ts + server/agent.ts + server/prompts.ts + server/tooling.ts (AGENT module)
- cp.ts: raw fetch to `${CP_BASE_URL}/v1/messages`, stream:true, SSE parse; headers
  anthropic-version 2023-06-01, x-twoshot-client dealdeck, x-shard-key <deckId> (cache affinity).
  model = CP_MODEL with `output_config: {effort: CP_EFFORT}`; on 429/503/529 or network error retry
  ONCE with model = CP_FALLBACK_SPEC and NO output_config.effort (spec + effort = 400).
- agent.ts exports:
  `startDeckBuild(s: Session): Promise<void>` (initial deck), `handleChat(s, text, {voice}): Promise<void>`,
  `runBullBear(s): Promise<void>`, `ensureNarration(s): Promise<void>`.
  ONE conversation per session (s.messages); chat turns append to it, so Q&A sees all prior
  reasoning + raw tool results. Tool loop until stop_reason != tool_use. Run tool calls of one
  turn in PARALLEL (Promise.all). Emit progress via emit(): status / slide / deck / assistant_delta /
  chat / speak / busy / error. Persist via save().
- Deck tools (in agent.ts): `set_deck({title, slides})`, `upsert_slide({index?, slide})`,
  `delete_slide({id})`, `speak_text({text, voice?})` (voice turns only). Slides validated against
  shared/types Slide (fill missing ids). Every number on a slide must carry receipts ids.
- Templates: company = VC investment memo; investor = fund deck from an LP's perspective
  (see PLAN.md). 8-10 slides, each with `narration`.
- Cover art: call `generateCoverImage(prompt)` from server/twoshot.ts at build start, in parallel,
  non-blocking; when it resolves set deck.coverImage + title slide image and emit 'deck'.

## server/twoshot.ts + server/share.ts (INFRA module)
- twoshot.ts: `export async function generateCoverImage(prompt: string): Promise<string|null>`
  POST https://api.twoshot.app/generation {modelId:1040, inputs:{prompt, width:1600, height:900, quality:'medium'}}
  header X-API-Key (returns plain-text job id); poll GET /generation/{id} until terminal; return the
  image url from outputs. Browser-like User-Agent (Cloudflare blocks default agents). 90s cap.
- share.ts: `export function registerShareRoutes(app)`: POST /api/share {deckId} -> ShareInfo.
  Uses PUBLIC_BASE_URL env if set (named tunnel / domain), else spawns
  `C:/standalone-binaries/cloudflared.exe tunnel --url http://localhost:PORT` once (windowsHide),
  parses the trycloudflare URL, reuses it. QR via `qrcode` toDataURL.

## server/voice.ts (VOICE module)
- `export function registerVoiceRoutes(app)`:
  GET /api/stt-token -> {token} via POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe (xi-api-key)
  POST /api/tts {text, voice: SpeakVoice} -> audio/mpeg stream from
  /v1/text-to-speech/{voiceId}/stream, model_id `eleven_v4_turbo` (verify it works; fall back to
  `eleven_v3_conversational` on 4xx). narrator = ELEVENLABS_VOICE_ID; bull/bear = two distinct stock voices.

## server/index.ts (main session owns) - routes:
GET /api/search?q=  | POST /api/decks CreateDeckBody -> {id} | POST /api/import ImportBody -> {id}
GET /api/decks/:id -> DeckView | GET /api/decks/:id/events (SSE) | GET /api/decks/:id/receipts/:rid -> Receipt
POST /api/decks/:id/chat ChatBody -> 202 | POST /api/decks/:id/fork -> {id} | POST /api/decks/:id/bullbear -> 202
POST /api/decks/:id/narrate -> 202 | GET /api/recent -> Deck[] | + voice + share routes.

## web/ (UI modules) - Vite React 18 TS, no UI framework, plain CSS (web/src/styles.css).
Style: minimal LIGHT keynote. White, generous whitespace, big confident type (Inter via Google Fonts),
one accent colour (#3b5bfd), near-black text, soft grey borders. No gradients/glassmorphism/emojis.
- UI-CORE owns: web/index.html, web/src/main.tsx, App.tsx (router: `/` Landing, `/d/:id` DeckPage,
  any other path = import route: treat the path as a Dealroom URL -> POST /api/import -> replace to /d/:id),
  pages/Landing.tsx (centered logo + search box, autocomplete dropdown (logo, name, type badge, HQ,
  tagline), arrow keys + Enter, 200ms debounce; 3 example chips; recent decks row),
  pages/DeckPage.tsx (slide rail + big slide stage + receipts panel + mounts ChatDock/PresentMode/
  BullBear/ShareButton), components/SlideView.tsx (renders every Slide kind; charts via recharts;
  cited values are clickable -> open receipt), components/ReceiptPanel.tsx (fetch full receipt,
  pretty JSON), lib/api.ts (typed fetch helpers for every route), lib/useDeck.ts (SSE subscription ->
  DeckView state, re-dispatches every event onto lib/bus.ts), styles.css.
- UI-VOICE owns: web/src/voice/* (mic capture AudioWorklet 16k PCM -> Scribe realtime WS
  `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&token=..&audio_format=pcm_16000&commit_strategy=vad`,
  committed transcript -> api.chat(deckId, text, {voice:true}); audio player queue that plays /api/tts
  for every bus 'speak' event; barge-in = stop playback when user speech starts; mute toggle),
  components/ChatDock.tsx (transcript + text input + mic button, streaming assistant text),
  components/PresentMode.tsx (fullscreen, plays each slide's narration via TTS then auto-advances),
  components/BullBear.tsx (button -> POST bullbear; renders the two-voice debate from bus 'speak'
  events with voice bull/bear), components/ShareButton.tsx (POST /api/share -> modal with url + QR).
  Props: `ChatDock({deckId, chat, streaming, busy})`, `PresentMode({deck, startIndex, onClose})`,
  `BullBear({deckId})`, `ShareButton({deckId})`.
- lib/bus.ts (main session): `bus.on(type, cb) -> off`, `bus.emit(event)`.
