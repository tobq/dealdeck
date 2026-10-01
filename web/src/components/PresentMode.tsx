import { useEffect, useRef } from 'react';
import type { Slide } from '../../../shared/types';
import { player } from '../voice/player';
import '../voice/voice.css';

const NO_NARRATION_HOLD_MS = 7000;
const GAP_MS = 700;
const MS_PER_WORD = 280; // floor on dwell time, so a failed or blocked TTS clip never races through the deck

/**
 * Narrated auto-play for the deck player. One effect run per (playing, slide): pausing or moving
 * slides runs the cleanup, which cancels the advance timer and stops the audio immediately; resume
 * restarts the current slide narration from the start. Slide content churn (streamed edits, deck
 * replaces) does NOT restart narration, because the effect keys on the slide id, not the object.
 */
export function usePlayback({ deckId, slides, index, setIndex, playing, setPlaying, building }: {
  deckId: string;
  slides: Slide[];
  index: number;
  setIndex: (i: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  building: boolean;
}) {
  const slideId = slides[index]?.id;
  const live = useRef({ slides, building, setIndex, setPlaying });
  live.current = { slides, building, setIndex, setPlaying };

  // Ask the agent to write narration once if the finished deck has slides without it.
  const asked = useRef(false);
  useEffect(() => {
    if (!playing || building || asked.current || !slides.length || slides.every((s) => s.narration?.trim())) return;
    asked.current = true;
    void fetch('/api/decks/' + deckId + '/narrate', { method: 'POST' }).catch(() => {});
  }, [playing, building, slides, deckId]);

  useEffect(() => {
    if (!playing || !slideId) return;
    let cancelled = false;
    let timer: number | undefined;
    const text = live.current.slides[index]?.narration?.trim() || '';
    const started = Date.now();
    const words = text ? text.split(/\s+/).length : 0;
    const minDwell = text ? Math.max(3000, words * MS_PER_WORD) : NO_NARRATION_HOLD_MS;

    const tryAdvance = () => {
      if (cancelled) return;
      const { slides: cur, building: stillBuilding } = live.current;
      if (index < cur.length - 1) live.current.setIndex(index + 1);
      else if (stillBuilding) timer = window.setTimeout(tryAdvance, 1000); // wait for the next slide to stream in
      else live.current.setPlaying(false);
    };
    const afterSpeech = () => {
      if (cancelled) return;
      timer = window.setTimeout(tryAdvance, Math.max(GAP_MS, minDwell - (Date.now() - started)));
    };
    if (text && !player.isMuted()) void player.say(text, 'narrator').then(afterSpeech);
    else afterSpeech();
    return () => { cancelled = true; clearTimeout(timer); player.stop(); };
  }, [playing, index, slideId]);
}

export default usePlayback;
