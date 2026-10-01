// TwoShot image generation for deck cover art.
// POST /generation returns the job id as plain text; GET /generation/{id} -> {status, outputs:[{image:{id}}]}.
// Generated images are served from the TwoShot CDN as https://i.twoshot.app/<imageId>.webp.
const API = 'https://api.twoshot.app';
const CDN = 'https://i.twoshot.app';
// 1040 ("Image Creator & Editor") is disabled; 1140 (GPT Image 2.5) is its successor with the same core inputs.
const MODEL_ID = Number(process.env.TWOSHOT_IMAGE_MODEL_ID || 1140);
const CAP_MS = 90_000;
const POLL_MS = 2_000;
const TERMINAL = new Set(['success', 'partial_success', 'failed', 'cancelled']);
// Cloudflare in front of api.twoshot.app rejects default runtime agents (403 / 1010).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export interface ImageGeneration {
  url: string | null;
  jobId: string | null;
  status: string;
  ms: number;
  error?: string;
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': process.env.TWOSHOT_API_KEY ?? '', 'User-Agent': UA, accept: 'application/json, text/plain' };
  if (json) h['content-type'] = 'application/json';
  return h;
}

function imageUrlFrom(outputs: unknown): string | null {
  if (!Array.isArray(outputs)) return null;
  for (const o of outputs as Array<Record<string, any>>) {
    const img = o?.image;
    if (typeof img?.url === 'string' && img.url.startsWith('https://')) return img.url;
    if (img?.id != null) return `${CDN}/${img.id}.webp`;
    if (typeof o?.url === 'string' && o.url.startsWith('https://')) return o.url;
  }
  return null;
}

/** Full result (job id, status, timing) for callers that want to record a receipt. Never throws. */
export async function generateImage(
  prompt: string,
  opts: { width?: number; height?: number; quality?: 'low' | 'medium' | 'high'; capMs?: number } = {},
): Promise<ImageGeneration> {
  const t0 = Date.now();
  const cap = opts.capMs ?? CAP_MS;
  const fail = (status: string, error: string, jobId: string | null = null): ImageGeneration => ({ url: null, jobId, status, ms: Date.now() - t0, error });
  if (!process.env.TWOSHOT_API_KEY) return fail('error', 'TWOSHOT_API_KEY not set');
  let jobId: string | null = null;
  try {
    const r = await fetch(`${API}/generation`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({
        modelId: MODEL_ID,
        inputs: { prompt: prompt.slice(0, 5000), width: opts.width ?? 1600, height: opts.height ?? 900, quality: opts.quality ?? 'medium' },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await r.text()).trim();
    if (!r.ok) return fail('error', `POST /generation ${r.status}: ${body.slice(0, 200)}`);
    jobId = body.replace(/^"|"$/g, '');
    while (Date.now() - t0 < cap) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      const p = await fetch(`${API}/generation/${encodeURIComponent(jobId)}`, { headers: headers(), signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!p?.ok) continue; // transient poll failure: keep polling until the cap
      const j = (await p.json().catch(() => null)) as Record<string, any> | null;
      const status = String(j?.status ?? j?.job?.status ?? '');
      if (!TERMINAL.has(status)) continue;
      const url = imageUrlFrom(j?.outputs);
      return url ? { url, jobId, status, ms: Date.now() - t0 } : fail(status, 'no image in outputs', jobId);
    }
    return fail('timeout', `no result within ${Math.round(cap / 1000)}s`, jobId);
  } catch (e) {
    return fail('error', (e as Error).message, jobId);
  }
}

/** Cover art for a deck: https image url, or null on any failure (never throws). */
export async function generateCoverImage(prompt: string): Promise<string | null> {
  const r = await generateImage(prompt);
  if (!r.url) console.warn(`[twoshot] cover image failed: ${r.status} ${r.error ?? ''}`.trim());
  return r.url;
}
