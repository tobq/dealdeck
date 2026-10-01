import { useCallback, useEffect, useRef, useState } from 'react';
import type { Deck } from '../../../shared/types';
import { bus } from '../lib/bus';
import { player } from '../voice/player';

type Line = { id: string; side: 'bull' | 'bear'; text: string };

/** Bull vs Bear transcript as a chat of bubbles, with replay (Play/Pause, Prev/Next, click-to-play). */
export default function ArgumentsView({ deck }: { deck: Deck }) {
  // deck.debate (new server) is the source of truth; speak events fill in on an older server.
  const [live, setLive] = useState<Line[]>([]);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [replayIdx, setReplayIdx] = useState<number | null>(null);
  const [liveId, setLiveId] = useState<string | null>(null);
  const token = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  const stored = deck.debate || [];
  const lines: Line[] = stored.length >= live.length ? stored : live;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const replaying = replayIdx !== null;

  useEffect(() => bus.on('speak', (e) => {
    if (e.voice !== 'bull' && e.voice !== 'bear') return;
    setStarting(false);
    setLive((ls) => (ls.some((l) => l.id === e.id) ? ls : [...ls, { id: e.id, side: e.voice as 'bull' | 'bear', text: e.text }]));
  }), []);
  useEffect(() => { if (stored.length) setStarting(false); }, [stored.length]);
  useEffect(() => player.subscribe((s) => setLiveId(s.item?.id ?? null)), []);
  useEffect(() => { if (!replaying) logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [lines.length, replaying]);
  useEffect(() => {
    if (replayIdx === null) return;
    logRef.current?.querySelector<HTMLElement>(`[data-line="${replayIdx}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [replayIdx]);

  const stopReplay = useCallback(() => {
    token.current++;
    player.setSuppress(null);
    player.stop();
    setReplayIdx(null);
  }, []);
  // Leaving the tab stops a replay (and never leaves live speech suppressed).
  useEffect(() => () => { token.current++; player.setSuppress(null); }, []);

  const playFrom = useCallback(async (start: number) => {
    const my = ++token.current;
    // Replay owns the audio: drop live debate speech while it runs so the two never overlap.
    player.setSuppress((it) => it.voice === 'bull' || it.voice === 'bear');
    if (player.isMuted()) player.setMuted(false);
    for (let i = Math.max(0, start); i < linesRef.current.length; i++) {
      if (token.current !== my) return;
      setReplayIdx(i);
      const l = linesRef.current[i];
      await player.say(l.text, l.side);
      if (token.current !== my) return;
    }
    if (token.current === my) { player.setSuppress(null); setReplayIdx(null); }
  }, []);

  const start = async () => {
    stopReplay();
    setErr(null);
    setStarting(true);
    setLive([]);
    if (player.isMuted()) player.setMuted(false);
    const r = await fetch('/api/decks/' + deck.id + '/bullbear', { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { setStarting(false); setErr(`Could not start the debate${r ? ` (${r.status})` : ''}`); }
  };

  const activeIdx = replaying ? replayIdx : lines.findIndex((l) => l.id === liveId);
  const cur = activeIdx ?? -1;
  const showStarting = starting && !live.length;

  return (
    <div className="av-root">
      {lines.length > 0 && <div className="av-head">
        <div className="av-legend"><span className="av-dot av-dot-bull" />Bull<span className="av-dot av-dot-bear" />Bear</div>
        <div className="av-ctrls">
          <button className="pl-ib" disabled={!lines.length || cur <= 0} onClick={() => void playFrom(Math.max(0, cur - 1))} aria-label="Previous line">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button className="av-play" disabled={!lines.length} onClick={() => (replaying ? stopReplay() : void playFrom(cur >= 0 && cur < lines.length - 1 ? cur : 0))} aria-pressed={replaying}>
            {replaying ? 'Pause' : 'Play all'}
          </button>
          <button className="pl-ib" disabled={!lines.length || cur >= lines.length - 1} onClick={() => void playFrom(cur + 1)} aria-label="Next line">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button className="btn" onClick={() => void start()} disabled={showStarting}>{showStarting ? 'Starting...' : lines.length ? 'Re-run debate' : 'Start debate'}</button>
        </div>
      </div>}
      <div className="av-log" ref={logRef}>
        {!lines.length && (
          <div className="av-empty">
            {showStarting ? <><span className="spinner spinner-xs" /> The two analysts are preparing their cases...</> : err || (
              <>
                <p className="av-empty-title">Bull vs Bear</p>
                <p className="muted">Two analysts argue the investment case from the same receipts.</p>
                <button className="btn btn-primary" onClick={() => void start()}>Start debate</button>
              </>
            )}
          </div>
        )}
        {lines.map((l, i) => (
          <button key={l.id} data-line={i} className={`av-line av-${l.side}${i === cur ? ' av-active' : ''}`} onClick={() => void playFrom(i)} title="Play from here">
            <span className="av-who">{l.side === 'bull' ? 'Bull' : 'Bear'}</span>
            <span className="av-text">{l.text}</span>
          </button>
        ))}
        {err && lines.length ? <div className="vx-err">{err}</div> : null}
      </div>
    </div>
  );
}
