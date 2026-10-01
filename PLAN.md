# Dealdeck - plan (Dealroom API Hackathon, 1 Oct 2026, submit 19:00)

Type a company -> ~30s later an investment-memo deck built from LIVE Dealroom data -> talk to it
(voice or text); it answers with receipts, queries Dealroom/web live, and edits the deck as you talk.

## Settled decisions (owner, 16:30-17:00)
- Scope: core + voice live-edits deck + receipts on every number + Bull vs Bear + narrated "Present"
  mode (in-browser, v4 voice-over; MP4 via TwoShot Web Graphics only if time is left).
- Deck: structured slide JSON -> live HTML render (real charts from Dealroom numbers); TwoShot GPT
  Image 2 (model 1040) generates the cover/hero art in parallel. No slides-as-images.
- Brain: claude-proxy (local :8089, same as Claude Code), model = SELECTION SPEC, cheap+fast:
  `i:>=65,s:12,c:agentic` (measured: fable-5-1@low, 1.7s, $0 marginal). Env-overridable.
- Voice (re-checked vs prior research): STT `scribe_v2_realtime` (browser WS, server-minted
  single-use token, VAD commit, open mic + barge-in + mute); TTS `eleven_v4_turbo` streaming,
  fallback `eleven_v3_conversational`. Forge "speak_text" pattern (say the summary, write the detail).
- Name/repo: Dealdeck, local git at C:/Users/Tobi/code/dealdeck. Nothing pushed until the
  submission format is known + owner confirms.
- Hosting: run on the PC, open from the MacBook over Tailscale HTTPS (private, mic works).
  Use `tailscale serve --https=8443` so the existing 443 -> :8089 CP share is untouched.

## Architecture (one Node/TS process + Vite React UI)
- server/cp.ts: raw fetch to CP /v1/messages, SSE parse, tool loop (Forge anthropicClient shape).
- server/agent.ts: ONE analyst agent per session. Builds the deck, answers Q&A, edits the deck.
  The Q&A continues the SAME conversation, so it natively holds all the reasoning + raw data.
- server/dealroom.ts: OAuth client-credentials (token cached 24h), Bearer + X-Client-Id,
  typed tools (search, company + sections: funding rounds, investors, team, similar, valuations,
  headcount, web traffic, news, jobs; transactions; investors) + generic `dealroom_get` escape hatch.
  Every call -> a RECEIPT {id, endpoint, params, status, json, ms}.
- server/web.ts: web_search (DuckDuckGo HTML) + web_fetch (fetch + strip), Forge's fallback path.
- server/twoshot.ts: POST api.twoshot.app/generation {modelId:1040, inputs}, poll, cover URL.
- server/voice.ts: /api/stt-token (ElevenLabs single-use token), /api/tts (stream eleven_v4_turbo).
- Deck tools: set_deck / upsert_slide / delete_slide / set_narration; slides carry `receipts` per
  number. Server pushes deck + agent events to the browser over SSE.
- web/: deck viewer (cards + charts), receipts side panel (raw JSON), chat + voice dock,
  Present mode (per-slide narration, auto-advance), Bull vs Bear (two voices).
- Demo-proofing: decks persisted to disk; pre-build 3 demo companies so the demo can't stall.

## Execution
1. Contracts (types, slide schema, tool + event shapes, file ownership) - main session.
2. Parallel build workflow, one agent per module above (disjoint files).
3. Integrate, E2E on real companies, adversarial review pass, fix.
4. Cache demo decks, demo script (3 min), submission.

## Round 3 decisions (owner, 17:05-17:20)
- Model: PIN `claude-opus-5-5` effort low (CP's own data: ~2x faster/task than fable@low; the spec
  ranker's speed term does not reward that - quirk to ticket after the hackathon). On a CP 429/503,
  fall back to the spec `i:>=65,s:12,c:agentic`.
- Landing: clean light keynote style. One search box, Dealroom autocomplete over COMPANIES +
  INVESTORS (logo, HQ, tagline), 3 example chips, quiet "recent decks" row.
- Two deck templates: company -> investment memo (VC view); investor -> fund deck from an LP's
  perspective (funds raised, portfolio + marks, unicorn/exit hit rate, recent deal pace, sector/stage
  focus, co-investors, team, questions for the GP).
- Every deck has its own URL `/d/<slug>-<id>`; deck + receipts + full agent conversation persisted
  server-side, so reopening resumes Q&A exactly.
- Share: button starts a public tunnel + shows a QR; viewers get deck, receipts, Present and Q&A;
  viewer Q&A FORKS a private copy (never edits the owner's deck). Owner approved going public on Share.
- URL import trick: any path that contains a Dealroom URL auto-imports, e.g.
  `<host>/app.dealroom.co/companies/synthesia` or `/investors/localglobe` -> builds that deck.
  With an owned domain (dealroomdeck.co/.net/.com all unregistered per RDAP at 17:18) the trick
  becomes "insert `deck` into the Dealroom hostname": app.dealroom.co -> app.dealroomdeck.co.
  Needs: owner buys the domain + `cloudflared tunnel login`; then a named tunnel gives a stable
  public host (replaces the random trycloudflare URL for Share too).

## Open (non-blocking)
- Dealroom zip: owner clicks Download on the PC's Bitwarden tab.
- Submission format: learn at kickoff.
- Demo companies: default Synthesia, Wayve, ElevenLabs (ElevenLabs narrates its own deck).
- Field research from Phoenix Court VCs -> IC memo section headings feed the slide template.
