import { useEffect, useRef, useState } from 'react';
import { bus } from '../lib/bus';
import { player } from '../voice/player';
import '../voice/voice.css';

type Line = { id: string; voice: 'bull' | 'bear'; text: string };

export default function BullBear({ deckId }: { deckId: string }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => bus.on('speak', (e) => {
    if (e.voice !== 'bull' && e.voice !== 'bear') return;
    setOpen(true);
    setLines((ls) => (ls.some((l) => l.id === e.id) ? ls : [...ls, { id: e.id, voice: e.voice as 'bull' | 'bear', text: e.text }]));
  }), []);
  useEffect(() => player.subscribe((s) => setActiveId(s.item?.id ?? null)), []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [lines.length]);

  const start = async () => {
    setErr(null);
    setStarting(true);
    setLines([]);
    setOpen(true);
    if (player.isMuted()) player.setMuted(false);
    const r = await fetch('/api/decks/' + deckId + '/bullbear', { method: 'POST' }).catch(() => null);
    setStarting(false);
    if (!r || !r.ok) setErr(`Could not start the debate${r ? ` (${r.status})` : ''}`);
  };

  const close = () => { setOpen(false); player.stop(); };

  return (
    <>
      <button className="vx-btn" onClick={start} disabled={starting}>{starting ? 'Starting...' : 'Bull vs Bear'}</button>
      {open && (
        <div className="vx-bb" role="dialog" aria-label="Bull vs Bear debate">
          <div className="vx-bb-head">
            <h3>Bull vs Bear</h3>
            <button className="vx-btn" onClick={() => player.stop()}>Stop audio</button>
            <button className="vx-btn" onClick={close}>Close</button>
          </div>
          <div className="vx-bb-cols"><span className="vx-bull-h">Bull</span><span className="vx-bear-h">Bear</span></div>
          <div className="vx-bb-log" ref={logRef}>
            {!lines.length && <div className="vx-empty">{err || 'The two analysts are preparing their cases...'}</div>}
            {lines.map((l) => (
              <div key={l.id} className={`vx-bb-line vx-bb-${l.voice}${activeId === l.id ? ' vx-bb-active' : ''}`}>{l.text}</div>
            ))}
            {err && lines.length ? <div className="vx-err">{err}</div> : null}
          </div>
        </div>
      )}
    </>
  );
}

export { BullBear };
