import { useCallback, useEffect, useRef, useState } from 'react';
import type { Deck } from '../../../shared/types';
import SlideView from './SlideView';
import { player } from '../voice/player';
import '../voice/voice.css';

const NO_NARRATION_HOLD_MS = 7000;
const GAP_MS = 700;

export default function PresentMode({ deck, startIndex, onClose }: { deck: Deck; startIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(Math.max(0, Math.min(startIndex || 0, deck.slides.length - 1)));
  const [paused, setPaused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const slide = deck.slides[index];
  const narration = slide?.narration?.trim() || '';
  const last = index >= deck.slides.length - 1;
  const hasSlide = !!slide;

  const go = useCallback((d: number) => setIndex((i) => Math.max(0, Math.min(deck.slides.length - 1, i + d))), [deck.slides.length]);

  // Ask the agent to write narration if any slide lacks it (it streams in as slide events).
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || deck.slides.every((s) => s.narration?.trim())) return;
    asked.current = true;
    void fetch('/api/decks/' + deck.id + '/narrate', { method: 'POST' }).catch(() => {});
  }, [deck]);

  // Fullscreen on open, stop audio + exit fullscreen on close.
  useEffect(() => {
    rootRef.current?.requestFullscreen?.().catch(() => {});
    return () => {
      player.stop();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Narrate the current slide, then auto-advance.
  useEffect(() => {
    if (paused || !hasSlide) return;
    let cancelled = false;
    let timer: number | undefined;
    const next = () => { if (!cancelled && !last) timer = window.setTimeout(() => go(1), GAP_MS); };
    if (narration && !player.isMuted()) {
      void player.say(narration, 'narrator').then(next);
    } else {
      timer = window.setTimeout(() => { if (!cancelled && !last) go(1); }, NO_NARRATION_HOLD_MS);
    }
    return () => { cancelled = true; clearTimeout(timer); player.stop(); };
  }, [index, narration, paused, last, go, hasSlide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
      else if (e.key === ' ') { e.preventDefault(); setPaused((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  // Esc while in browser fullscreen exits fullscreen first; treat that as close too.
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) onClose(); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [onClose]);

  if (!slide) return null;
  return (
    <div className="vx-present" ref={rootRef}>
      <div className="vx-progress"><div style={{ width: `${((index + 1) / deck.slides.length) * 100}%` }} /></div>
      <div className="vx-present-stage" onClick={() => go(1)}>
        <SlideView slide={slide} deck={deck} />
      </div>
      <div className="vx-caption">{narration}</div>
      <div className="vx-present-bar">
        <button className="vx-btn" onClick={() => go(-1)} disabled={index === 0}>Prev</button>
        <button className="vx-btn" onClick={() => setPaused((p) => !p)}>{paused ? 'Play' : 'Pause'}</button>
        <button className="vx-btn" onClick={() => go(1)} disabled={last}>Next</button>
        <span className="vx-grow">{deck.title}</span>
        <span>{index + 1} / {deck.slides.length}</span>
        <button className="vx-btn" onClick={onClose}>Exit</button>
      </div>
    </div>
  );
}

export { PresentMode };
