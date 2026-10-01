// Voice routes: ElevenLabs Scribe realtime token (browser opens the WS itself) + streaming TTS.
// The API key never leaves the server. Verified live 2026-10-01: single-use token mints (200);
// eleven_v4_turbo streams audio/mpeg (TTFB ~1.6s cold), eleven_v3_conversational also works (~1.8s).
import express, { type Express, type Request, type Response } from 'express';
import { Readable } from 'node:stream';
import type { SpeakVoice } from '../shared/types.js';

const API = 'https://api.elevenlabs.io/v1';
const MODELS = ['eleven_v4_turbo', 'eleven_v3_conversational'] as const;
/** Stock (premade) voices, picked for contrast with each other: an energetic male bull, a clear
 *  British female bear. Alternates are used if the narrator voice happens to be one of them. */
const BULL = ['TX3LPaxmHKxFdv7VOQHJ' /* Liam */, 'IKne3meq5aSn9XLyUdCD' /* Charlie */];
const BEAR = ['Xb7hH8MSUJpSbSDYk0k2' /* Alice */, 'onwK4e9ZLuTAKqWW03F9' /* Daniel */];
const NARRATOR_FALLBACK = 'JBFqnCBsd6RMkjVDRZzb'; // George

let modelIdx = 0; // sticky: once v4 turbo 4xxs we stay on the fallback for the process lifetime

const key = () => process.env.ELEVENLABS_API_KEY || '';

export function voiceIdFor(voice: SpeakVoice): string {
  const narrator = process.env.ELEVENLABS_VOICE_ID || NARRATOR_FALLBACK;
  if (voice === 'bull') return BULL.find((v) => v !== narrator)!;
  if (voice === 'bear') return BEAR.find((v) => v !== narrator)!;
  return narrator;
}

async function synth(text: string, voice: SpeakVoice, signal: AbortSignal): Promise<globalThis.Response> {
  for (;;) {
    const model = MODELS[modelIdx];
    const r = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceIdFor(voice))}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': key() },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      signal,
    });
    if (r.ok || r.status < 400 || r.status >= 500 || r.status === 401 || r.status === 429 || modelIdx >= MODELS.length - 1) return r;
    // 4xx on this model (e.g. unknown model id / not available on the plan): fall back once.
    console.warn(`[voice] tts model ${model} -> ${r.status}; falling back to ${MODELS[modelIdx + 1]}`);
    await r.body?.cancel().catch(() => {});
    modelIdx++;
  }
}

export function registerVoiceRoutes(app: Express) {
  app.get('/api/stt-token', async (_req: Request, res: Response) => {
    if (!key()) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
    try {
      const r = await fetch(`${API}/single-use-token/realtime_scribe`, { method: 'POST', headers: { 'xi-api-key': key() } });
      const j = (await r.json().catch(() => ({}))) as { token?: string };
      if (!r.ok || !j.token) return res.status(502).json({ error: `token mint failed (${r.status})` });
      res.set('cache-control', 'no-store').json({ token: j.token });
    } catch (e) {
      res.status(502).json({ error: `token mint failed: ${(e as Error).message}` });
    }
  });

  // POST is the contract; GET (?text=&voice=) lets an <audio> element stream progressive MP3 natively
  // (plays from the first bytes, and setting src='' aborts the request = instant barge-in).
  app.post('/api/tts', express.json({ limit: '256kb' }), (req, res) => tts(req.body?.text, req.body?.voice, res));
  app.get('/api/tts', (req, res) => tts(req.query.text, req.query.voice, res));
}

async function tts(rawText: unknown, v: unknown, res: Response) {
  {
    const text = String(rawText ?? '').trim().slice(0, 4000);
    const voice: SpeakVoice = v === 'bull' || v === 'bear' ? v : 'narrator';
    if (!text) return res.status(400).json({ error: 'text required' });
    if (!key()) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
    // Barge-in: the browser aborts its fetch -> we abort the upstream synthesis too.
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const r = await synth(text, voice, ac.signal);
      if (!r.ok || !r.body) {
        const detail = (await r.text().catch(() => '')).slice(0, 300);
        return res.status(r.status >= 400 ? r.status : 502).json({ error: `tts failed (${r.status})`, detail });
      }
      res.status(200).set({ 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-tts-model': MODELS[modelIdx] });
      Readable.fromWeb(r.body as any).on('error', () => res.end()).pipe(res);
    } catch (e) {
      if (ac.signal.aborted) return;
      if (!res.headersSent) res.status(502).json({ error: `tts failed: ${(e as Error).message}` });
      else res.end();
    }
  }
}
