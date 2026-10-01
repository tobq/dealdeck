// Share: a public URL + QR code for a deck.
// PUBLIC_BASE_URL (named tunnel / own domain) wins; otherwise a cloudflared QUICK tunnel is started lazily
// on the first POST /api/share, reused for the process lifetime and killed when the process exits.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Express } from 'express';
import QRCode from 'qrcode';
import type { ShareInfo } from '../shared/types.js';
import { getSession } from './store.js';

const CLOUDFLARED = process.env.CLOUDFLARED_PATH || 'C:/standalone-binaries/cloudflared.exe';
const TUNNEL_TIMEOUT_MS = 45_000;
/** After the URL is printed, wait this long at most for the first edge connection before handing it out. */
const REGISTER_GRACE_MS = 15_000;

let child: ChildProcess | null = null;
let basePromise: Promise<string> | null = null;

/** Pull the quick-tunnel hostname out of cloudflared log text (ignores api.trycloudflare.com in error lines). */
export function parseTunnelUrl(text: string): string | null {
  for (const m of text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)) {
    if (m[1].toLowerCase() !== 'api') return m[0];
  }
  return null;
}

function killTunnel() {
  if (child && child.exitCode === null) child.kill();
  child = null;
}

let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', killTunnel);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const onSig = () => {
      killTunnel();
      // Only take over termination when nobody else handles the signal (keeps index.ts graceful shutdown intact).
      if (process.listenerCount(sig) === 1) process.exit(code);
    };
    process.on(sig, onSig);
  }
}

function startQuickTunnel(): Promise<string> {
  const port = process.env.PORT || '5178';
  hookExit();
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(
      CLOUDFLARED,
      // Host header rewrite keeps Vite's dev-server host check happy for the random trycloudflare host.
      ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`, '--http-host-header', `localhost:${port}`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child = proc;
    let log = '';
    let url: string | null = null;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const done = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(graceTimer);
      if (err) { killTunnel(); reject(err); } else resolve(value!);
    };
    const timeout = setTimeout(() => done(new Error('cloudflared did not report a tunnel URL in time')), TUNNEL_TIMEOUT_MS);
    const onData = (buf: Buffer) => {
      log = (log + buf.toString('utf8')).slice(-20_000);
      if (!url) {
        url = parseTunnelUrl(log);
        if (url) graceTimer = setTimeout(() => done(null, url!), REGISTER_GRACE_MS);
      }
      if (url && /Registered tunnel connection/i.test(log)) done(null, url);
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('error', (e) => done(new Error(`cloudflared failed to start: ${e.message}`)));
    proc.on('exit', (code) => {
      if (child === proc) child = null;
      basePromise = null; // a dead tunnel must not be reused; the next share starts a fresh one
      done(new Error(`cloudflared exited (code ${code})`));
    });
  });
}

/** Public origin for share links, without a trailing slash. */
export function publicBaseUrl(): Promise<string> {
  const fixed = process.env.PUBLIC_BASE_URL?.trim();
  if (fixed) return Promise.resolve(fixed.replace(/\/+$/, ''));
  if (!basePromise) {
    basePromise = startQuickTunnel();
    basePromise.catch(() => { basePromise = null; });
  }
  return basePromise;
}

export async function shareInfoFor(base: string, deckId: string): Promise<ShareInfo> {
  // ?shared=1: each viewer is forked into a private copy on open (DeckPage), so the owner's deck is never edited.
  const url = `${base.replace(/\/+$/, '')}/d/${encodeURIComponent(deckId)}?shared=1`;
  const qrDataUrl = await QRCode.toDataURL(url, {
    margin: 1,
    width: 512,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
  return { url, qrDataUrl };
}

export function registerShareRoutes(app: Express) {
  app.post('/api/share', async (req, res) => {
    const deckId = typeof req.body?.deckId === 'string' ? req.body.deckId.trim() : '';
    if (!deckId) return res.status(400).json({ error: 'deckId required' });
    if (!getSession(deckId)) return res.status(404).json({ error: 'deck not found' });
    try {
      const base = await publicBaseUrl();
      res.json(await shareInfoFor(base, deckId));
    } catch (e) {
      res.status(502).json({ error: `share link unavailable: ${(e as Error).message}` });
    }
  });
}
