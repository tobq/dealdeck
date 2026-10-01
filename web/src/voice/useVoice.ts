// Open-mic voice loop: mic -> AudioWorklet -> 16 kHz PCM -> ElevenLabs Scribe realtime WS (VAD
// commits) -> committed transcript -> POST /api/decks/:id/chat {voice:true}. Speech plays through
// the shared player; a partial transcript with real words while it plays = barge-in (stop).
import { useCallback, useEffect, useRef, useState } from 'react';
import { bus } from '../lib/bus';
import { player } from './player';
import { viewFields } from '../lib/viewContext';

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';
const RATE = 16000;
const SEND_MS = 100;
const WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

const WORKLET = `class VxTap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('vx-pcm-tap', VxTap);`;

/** Box-filter downsample to 16 kHz (cheap anti-aliasing) + Int16 LE + base64. */
function toPcm16Base64(chunks: Float32Array[], inRate: number): string {
  let len = 0;
  for (const c of chunks) len += c.length;
  const src = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { src.set(c, o); o += c.length; }
  const ratio = inRate / RATE;
  const outLen = Math.floor(src.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio), b = Math.min(src.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += src[j];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const realWords = (t: string) => (t.match(/[\p{L}\p{N}]{2,}/gu) || []).length;

async function sendChat(deckId: string, text: string, slideIndex?: number) {
  const r = await fetch('/api/decks/' + deckId + '/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice: true, ...viewFields(), ...(typeof slideIndex === 'number' ? { slideIndex } : {}) }),
  });
  if (!r.ok) throw new Error(`chat failed (${r.status})`);
}

/** getSlideIndex (optional): the slide the viewer is on, sent with each spoken question. */
export function useVoice(deckId: string, getSlideIndex?: () => number) {
  const [micOn, setMicOn] = useState(false);
  const [muted, setMutedState] = useState(player.isMuted());
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const teardown = useRef<(() => void) | null>(null);
  const deckRef = useRef(deckId);
  deckRef.current = deckId;
  const slideRef = useRef(getSlideIndex);
  slideRef.current = getSlideIndex;

  useEffect(() => player.subscribe((s) => { setSpeaking(s.speaking); setMutedState(s.muted); if (s.speaking) setThinking(false); }), []);
  useEffect(() => bus.on('busy', (e) => { if (!e.busy) setThinking(false); }), []);
  useEffect(() => () => teardown.current?.(), []);

  const commitText = useCallback((text: string) => {
    const t = text.trim();
    setPartial('');
    if (!realWords(t)) return;
    setThinking(true);
    sendChat(deckRef.current, t, slideRef.current?.()).catch((e) => { setThinking(false); setError(e.message); });
  }, []);

  const start = useCallback(async () => {
    setError(null);
    let closed = false;
    const cleanups: Array<() => void> = [];
    const stop = () => {
      if (closed) return;
      closed = true;
      cleanups.reverse().forEach((f) => { try { f(); } catch { /* ignore */ } });
      teardown.current = null;
      setMicOn(false);
      setPartial('');
    };
    teardown.current = stop;
    setMicOn(true);
    try {
      const tokRes = await fetch('/api/stt-token');
      const tok = (await tokRes.json()) as { token?: string; error?: string };
      if (!tok.token) throw new Error(tok.error || 'no speech token');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      cleanups.push(() => stream.getTracks().forEach((t) => t.stop()));
      if (closed) return stop();

      const params = new URLSearchParams({ model_id: 'scribe_v2_realtime', token: tok.token, audio_format: 'pcm_16000', commit_strategy: 'vad', no_verbatim: 'true' });
      const ws = new WebSocket(`${WS_URL}?${params}`);
      cleanups.push(() => { try { ws.close(); } catch { /* ignore */ } });

      // "Short utterances may return nothing": if partials stop and VAD never commits, force a
      // commit; if that still yields nothing, promote the last partial ourselves.
      let lastPartial = '';
      let promoted = 0; // when we self-promoted a partial; a late VAD commit right after is a duplicate
      let quietTimer: number | undefined;
      let promoteTimer: number | undefined;
      cleanups.push(() => { clearTimeout(quietTimer); clearTimeout(promoteTimer); });
      const sendChunk = (b64: string, commit = false) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64, sample_rate: RATE, ...(commit ? { commit: true } : {}) }));
      };
      ws.onmessage = (ev) => {
        let m: { message_type?: string; text?: string; error?: string; message?: string };
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        switch (m.message_type) {
          case 'session_started':
            break;
          case 'partial_transcript': {
            const t = (m.text || '').trim();
            setPartial(t);
            if (!t) break;
            lastPartial = t;
            if (realWords(t) >= 2 && player.get().speaking) player.stop(); // barge-in
            clearTimeout(quietTimer);
            clearTimeout(promoteTimer);
            quietTimer = window.setTimeout(() => {
              sendChunk('', true);
              promoteTimer = window.setTimeout(() => { if (lastPartial) { const p = lastPartial; lastPartial = ''; promoted = Date.now(); commitText(p); } }, 1500);
            }, 1800);
            break;
          }
          case 'committed_transcript': {
            clearTimeout(quietTimer);
            clearTimeout(promoteTimer);
            const t = (m.text || '').trim() || lastPartial;
            lastPartial = '';
            if (Date.now() - promoted < 4000) { promoted = 0; setPartial(''); break; }
            if (t) commitText(t); else setPartial('');
            break;
          }
          case 'committed_transcript_with_timestamps':
            break;
          default:
            if (m.message_type && /error|exceeded|denied|invalid/i.test(m.message_type)) setError(m.error || m.message || m.message_type);
        }
      };
      ws.onerror = () => setError('speech socket error');
      ws.onclose = (ev) => { if (!closed) { if (ev.code !== 1000) setError(`speech socket closed (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`); stop(); } };

      const ctx = new AudioContext();
      cleanups.push(() => { void ctx.close(); });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (closed) return;
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'vx-pcm-tap');
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(node);
      node.connect(sink).connect(ctx.destination); // keep the graph pulling, silently
      cleanups.push(() => { src.disconnect(); node.disconnect(); });
      let buf: Float32Array[] = [];
      let n = 0;
      const per = Math.round(ctx.sampleRate * (SEND_MS / 1000));
      node.port.onmessage = (e) => {
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        buf.push(e.data as Float32Array);
        n += (e.data as Float32Array).length;
        if (n >= per) { sendChunk(toPcm16Base64(buf, ctx.sampleRate)); buf = []; n = 0; }
      };
    } catch (e) {
      setError((e as Error).message || 'microphone failed');
      stop();
    }
  }, [commitText]);

  // Turning the mic off only stops LISTENING ("I'm done talking"): a question already sent keeps running and is still answered.
  const toggleMic = useCallback(() => { if (teardown.current) teardown.current(); else void start(); }, [start]);
  const toggleMute = useCallback(() => player.setMuted(!player.isMuted()), []);

  // The analyst's state shows whether or not the mic is on: muting the mic never hides that it is still answering.
  const state: VoiceState = speaking ? 'speaking' : thinking ? 'thinking' : micOn ? 'listening' : 'idle';
  return { micOn, toggleMic, muted, toggleMute, state, partial, error };
}
