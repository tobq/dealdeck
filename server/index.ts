// Dealdeck server: Express API under /api + Vite middleware serving the SPA from web/.
import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import type { ChatBody, CreateDeckBody, ImportBody } from '../shared/types.js';
import { createSession, getSession, listRecent, subscribe, view } from './store.js';
import { resolveDealroomUrl, searchEntities } from './dealroom.js';
import { ensureNarration, handleChat, runBullBear, startDeckBuild } from './agent.js';
import { registerVoiceRoutes } from './voice.js';
import { registerShareRoutes } from './share.js';

const PORT = Number(process.env.PORT || 5178);
const app = express();
app.use(express.json({ limit: '2mb' }));

// Async handler wrapper: Express 4 drops rejected promises, which hangs the request.
const h = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => fn(req, res).catch(next);

app.get('/api/search', h(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json([]);
  const hits = await searchEntities(q, 'company,investor');
  res.json(hits.filter((x) => x.type === 'company' || x.type === 'investor'));
}));

function startBuild(entity: CreateDeckBody & { image?: string | null; tagline?: string | null; websiteDomain?: string | null }) {
  const s = createSession({ uuid: entity.uuid, kind: entity.kind, name: entity.name, image: entity.image ?? null, tagline: entity.tagline ?? null, websiteDomain: entity.websiteDomain ?? null });
  startDeckBuild(s).catch((e) => console.error('[build]', s.deck.id, e));
  return s;
}

app.post('/api/decks', h(async (req, res) => {
  const b = req.body as CreateDeckBody & { image?: string; tagline?: string; websiteDomain?: string };
  if (!b?.uuid || !b?.name || (b.kind !== 'company' && b.kind !== 'investor')) return res.status(400).json({ error: 'uuid, name, kind required' });
  res.json({ id: startBuild(b).deck.id });
}));

app.post('/api/import', h(async (req, res) => {
  const { url } = req.body as ImportBody;
  const hit = url ? await resolveDealroomUrl(url) : null;
  if (!hit) return res.status(404).json({ error: `Could not find a Dealroom company or investor for "${url}"` });
  res.json({ id: startBuild(hit).deck.id });
}));

app.get('/api/recent', (_req, res) => { res.json(listRecent()); });

app.get('/api/decks/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(view(s));
});

app.get('/api/decks/:id/events', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).end();
  subscribe(req.params.id, res, s);
});

app.get('/api/decks/:id/receipts/:rid', (req, res) => {
  const s = getSession(req.params.id);
  const r = s?.receipts.find((x) => x.id === req.params.rid);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

app.post('/api/decks/:id/chat', h(async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { text, voice } = req.body as ChatBody;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  if (s.busy) return res.status(409).json({ error: 'busy' });
  res.status(202).json({ ok: true });
  handleChat(s, text.trim(), { voice: !!voice }).catch((e) => console.error('[chat]', s.deck.id, e));
}));

app.post('/api/decks/:id/fork', h(async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const f = createSession(s.deck.entity, s);
  res.json({ id: f.deck.id });
}));

app.post('/api/decks/:id/bullbear', h(async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.busy) return res.status(409).json({ error: 'busy' });
  res.status(202).json({ ok: true });
  runBullBear(s).catch((e) => console.error('[bullbear]', s.deck.id, e));
}));

app.post('/api/decks/:id/narrate', h(async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.status(202).json({ ok: true });
  ensureNarration(s).catch((e) => console.error('[narrate]', s.deck.id, e));
}));

registerVoiceRoutes(app);
registerShareRoutes(app);

app.use('/api', (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  console.error('[api]', err?.message ?? err);
  res.status(500).json({ error: String(err?.message ?? err) });
});

const vite = await createViteServer({ configFile: 'vite.config.ts', server: { middlewareMode: true }, appType: 'spa' });
app.use(vite.middlewares);

app.listen(PORT, '0.0.0.0', () => console.log(`Dealdeck on http://localhost:${PORT}`));
