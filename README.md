# Dealdeck

**Any company or fund, as an investor deck, in seconds. Then talk to it.**

Built in one evening at the Dealroom API Hackathon (London, 1 Oct 2026).

## What it does

- **Search** any company or investor (live Dealroom autocomplete), or paste any Dealroom URL after our host
  (`/app.dealroom.co/companies/wayve`) and it imports.
- **Deck in seconds**: an agent pulls the Dealroom graph (profile, funding rounds, investors, team,
  similar companies, valuations, web traffic, financials, news), plans the deck, and writes expressive
  HTML slides in parallel. Company -> VC investment memo. Investor -> fund deck from an LP's perspective.
- **Receipts on every number**: click any figure to see the exact Dealroom call and raw JSON behind it.
- **Visual reviewer loop**: a critic agent reviews rendered screenshots of every slide plus the data,
  and the builder fixes what it finds (max 2 rounds) before the deck opens.
- **Talk to the deck**: voice or text Q&A. The agent keeps the full build context (data + reasoning),
  queries Dealroom and the web live, and edits slides while it answers.
- **Present**: narrated, auto-advancing playback with pause; **Bull vs Bear** two-voice debate.
- **Thesis sourcing**: describe a thesis and/or pick your fund; it infers the thesis from the
  portfolio and suggests companies you don't own yet, each with why it fits.
- **Share**: public link + QR; viewers' questions fork a private copy.

## Stack

- Dealroom API (new graph API, OAuth client credentials) for all company/investor data
- Claude via TwoShot's claude-proxy (agent loop, parallel tool use, planner + parallel slide writers)
- TwoShot generation API (GPT Image) for cover art
- ElevenLabs: Scribe v2 realtime (speech in), Eleven v4 Turbo (speech out)
- Node + Express + Vite/React, headless Chrome for reviewer screenshots

## Run

```
npm install
cp .env.example .env   # DEALROOM_CLIENT_ID/SECRET, ELEVENLABS_API_KEY, TWOSHOT_API_KEY, CP_BASE_URL, CP_MODEL
npm start              # http://localhost:5178
```
