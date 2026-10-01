// Shared speech player: every bus 'speak' event is queued and played in order through ONE audio
// element at a time. Audio streams via GET /api/tts (progressive MP3 plays from the first bytes);
// the next item is prefetched while the current one plays. stop() = barge-in (aborts the request).
import { bus } from '../lib/bus';
import type { SpeakVoice } from '../../../shared/types';

export interface SpeechItem { id: string; text: string; voice: SpeakVoice; interject?: boolean }
export interface PlayerState { speaking: boolean; item: SpeechItem | null; muted: boolean }

export const ttsUrl = (text: string, voice: SpeakVoice = 'narrator') =>
  `/api/tts?voice=${voice}&text=${encodeURIComponent(text.slice(0, 1800))}`;

const queue: SpeechItem[] = [];
let current: { item: SpeechItem; audio: HTMLAudioElement; done: () => void; ended: Promise<void> } | null = null;
let prefetched: { id: string; audio: HTMLAudioElement } | null = null;
let muted = false;
/** While set, matching bus speech is dropped (the Arguments replay owns the audio). */
let suppress: ((item: SpeechItem) => boolean) | null = null;
const listeners = new Set<(s: PlayerState) => void>();

const state = (): PlayerState => ({ speaking: !!current, item: current?.item ?? null, muted });
const notify = () => { const s = state(); listeners.forEach((cb) => cb(s)); };

function kill(a: HTMLAudioElement) {
  a.pause();
  a.removeAttribute('src');
  a.load(); // aborts the in-flight stream
}

function audioFor(item: SpeechItem): HTMLAudioElement {
  if (prefetched?.id === item.id) { const a = prefetched.audio; prefetched = null; return a; }
  const a = new Audio();
  a.preload = 'auto';
  a.src = ttsUrl(item.text, item.voice);
  return a;
}

function prefetchNext() {
  const next = queue[0];
  if (!next || prefetched?.id === next.id) return;
  if (prefetched) kill(prefetched.audio);
  const a = new Audio();
  a.preload = 'auto';
  a.src = ttsUrl(next.text, next.voice);
  prefetched = { id: next.id, audio: a };
}

/** Play one clip now; resolves when it ends, errors, or is stopped. */
function playItem(item: SpeechItem): Promise<void> {
  // Never two clips at once: whatever is playing is cut before the new one starts.
  if (current) { const c = current; kill(c.audio); c.done(); }
  let resolveEnded!: () => void;
  const ended = new Promise<void>((r) => { resolveEnded = r; });
  void new Promise<void>((resolve) => {
    const audio = audioFor(item);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (current?.audio === audio) current = null;
      notify();
      resolve();
      resolveEnded();
    };
    current = { item, audio, done, ended };
    audio.onended = done;
    audio.onerror = () => { console.warn('[voice] tts playback failed for', item.id); done(); };
    notify();
    audio.play().catch((e) => { console.warn('[voice] play() refused', e?.message); done(); });
    prefetchNext();
  });
  return ended;
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length && !muted) {
      // A one-off clip (Present narration) is playing: queued speech waits for it instead of overlapping.
      if (current) { await current.ended; continue; }
      await playItem(queue.shift()!);
    }
  } finally {
    pumping = false;
  }
}

export const player = {
  enqueue(item: SpeechItem) {
    if (muted || !item.text?.trim() || suppress?.(item)) return;
    queue.push(item);
    if (current) prefetchNext();
    void pump();
  },
  /** Barge-in / close: stop what is playing and drop everything queued. */
  stop() {
    queue.length = 0;
    if (prefetched) { kill(prefetched.audio); prefetched = null; }
    if (current) { const c = current; kill(c.audio); c.done(); }
  },
  /** One-off clip outside the queue (Present mode). Stops the queue first. */
  say(text: string, voice: SpeakVoice = 'narrator'): Promise<void> {
    player.stop();
    if (muted || !text.trim()) return Promise.resolve();
    return playItem({ id: `say-${Date.now()}`, text, voice });
  },
  /** Drop incoming queued speech matching pred (null = accept all again). */
  setSuppress(pred: ((item: SpeechItem) => boolean) | null) { suppress = pred; },
  setMuted(m: boolean) { muted = m; if (m) player.stop(); notify(); },
  isMuted: () => muted,
  get: state,
  subscribe(cb: (s: PlayerState) => void) { listeners.add(cb); cb(state()); return () => { listeners.delete(cb); }; },
};

// One global subscription: any component importing the player makes speech audible.
bus.on('speak', (e) => player.enqueue({ id: e.id, text: e.text, voice: e.voice, interject: e.interject }));
