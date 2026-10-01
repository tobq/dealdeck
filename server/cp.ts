// Streaming client for claude-proxy /v1/messages (Anthropic Messages wire).
export type ContentBlock = Record<string, any> & { type: string };

export interface CpRequest {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  tools?: object[];
  shardKey: string;
  onText?: (delta: string) => void;
  maxTokens?: number;
}
export interface CpResult { content: ContentBlock[]; stopReason: string | null; model?: string }

class RetryableError extends Error {}

function baseUrl() { return (process.env.CP_BASE_URL || 'http://localhost:8089').replace(/\/$/, ''); }

async function once(req: CpRequest, fallback: boolean): Promise<CpResult> {
  const body: Record<string, unknown> = {
    model: fallback ? (process.env.CP_FALLBACK_SPEC || 'i:>=65,s:12,c:agentic') : (process.env.CP_MODEL || 'claude-opus-5-5'),
    max_tokens: req.maxTokens ?? 16000,
    stream: true,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: req.messages,
  };
  if (!fallback && process.env.CP_EFFORT) body.output_config = { effort: process.env.CP_EFFORT };
  if (req.tools?.length) body.tools = req.tools;

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-twoshot-client': 'dealdeck',
        'x-shard-key': req.shardKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    throw new RetryableError(`network: ${e?.message ?? e}`);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    const msg = `CP ${res.status}: ${text.slice(0, 500)}`;
    if ([429, 503, 529].includes(res.status)) throw new RetryableError(msg);
    throw new Error(msg);
  }

  const blocks: ContentBlock[] = [];
  const partialJson = new Map<number, string>();
  let stopReason: string | null = null;
  let model: string | undefined;

  const handle = (ev: any) => {
    switch (ev.type) {
      case 'message_start': model = ev.message?.model; break;
      case 'content_block_start': {
        const b = { ...ev.content_block };
        if (b.type === 'tool_use') { partialJson.set(ev.index, ''); b.input = {}; }
        if (b.type === 'text') b.text = b.text ?? '';
        if (b.type === 'thinking') { b.thinking = b.thinking ?? ''; }
        blocks[ev.index] = b;
        break;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index]; const d = ev.delta;
        if (!b || !d) break;
        if (d.type === 'text_delta') { b.text += d.text; req.onText?.(d.text); }
        else if (d.type === 'input_json_delta') partialJson.set(ev.index, (partialJson.get(ev.index) ?? '') + d.partial_json);
        else if (d.type === 'thinking_delta') b.thinking += d.thinking;
        else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b?.type === 'tool_use') {
          const raw = partialJson.get(ev.index) ?? '';
          try { b.input = raw ? JSON.parse(raw) : {}; } catch { b.input = {}; b._badJson = raw.slice(0, 200); }
        }
        break;
      }
      case 'message_delta': if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason; break;
      case 'error': {
        const t = ev.error?.type ?? 'error';
        const msg = `CP stream ${t}: ${ev.error?.message ?? ''}`;
        if (/overloaded|rate_limit|unavailable/i.test(t) && !blocks.length) throw new RetryableError(msg);
        throw new Error(msg);
      }
    }
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch (e: any) {
      if (!blocks.length) throw new RetryableError(`network: ${e?.message ?? e}`);
      throw e;
    }
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let ev: any;
      try { ev = JSON.parse(data); } catch { continue; }
      handle(ev);
    }
  }
  const content = blocks.filter(Boolean).map((b) => { const { _badJson, ...rest } = b; return rest as ContentBlock; });
  return { content, stopReason, model };
}

/** One call; on 429/503/529/network error retries ONCE with the fallback spec (no effort). */
export async function cpMessage(req: CpRequest): Promise<CpResult> {
  try {
    return await once(req, false);
  } catch (e) {
    if (!(e instanceof RetryableError)) throw e;
    console.warn(`[cp] primary failed (${(e as Error).message.slice(0, 120)}), retrying with fallback spec`);
    return once(req, true);
  }
}
