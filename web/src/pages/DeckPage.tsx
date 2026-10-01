import { useCallback, useEffect, useRef, useState } from 'react';
import SlideView from '../components/SlideView';
import ReceiptPanel from '../components/ReceiptPanel';
import ChatDock from '../components/ChatDock';
import PresentMode from '../components/PresentMode';
import BullBear from '../components/BullBear';
import ShareButton from '../components/ShareButton';
import { useDeck } from '../lib/useDeck';
import { navigate } from '../lib/api';

function Skeleton({ statusLog, name }: { statusLog: string[]; name: string }) {
  return (
    <div className="skeleton-stage">
      <div className="slide-box skeleton-box">
        <div className="sk-inner">
          <div className="sk-eyebrow">Building your deck</div>
          <div className="sk-title">{name}</div>
          <div className="sk-lines"><i /><i /><i /></div>
          <ul className="sk-status">
            {statusLog.length === 0 && <li className="current"><span className="spinner spinner-xs" />Starting the analyst...</li>}
            {statusLog.map((s, i) => (
              <li key={i + s} className={i === statusLog.length - 1 ? 'current' : 'done'}>
                {i === statusLog.length - 1 ? <span className="spinner spinner-xs" /> : <span className="tick" />}
                {s}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function DeckPage({ id }: { id: string }) {
  const { view, streaming, status, statusLog, error } = useDeck(id);
  const [current, setCurrent] = useState(0);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);

  const deck = view?.deck;
  const slides = deck?.slides || [];
  const busy = !!view?.busy;
  const building = deck?.status === 'building';

  useEffect(() => { if (current > slides.length - 1) setCurrent(Math.max(0, slides.length - 1)); }, [slides.length, current]);
  useEffect(() => { if (deck) document.title = `${deck.title || deck.entity.name} - Dealdeck`; return () => { document.title = 'Dealdeck'; }; }, [deck?.title, deck?.entity.name]);

  // Follow the build: jump to newly added slides while the deck is still being written.
  const prevCount = useRef(0);
  useEffect(() => {
    if (building && slides.length > prevCount.current && prevCount.current > 0) setCurrent(slides.length - 1);
    prevCount.current = slides.length;
  }, [slides.length, building]);

  useEffect(() => {
    railRef.current?.querySelector<HTMLElement>(`[data-idx="${current}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (presenting || t.closest('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); setCurrent((c) => Math.min(c + 1, slides.length - 1)); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); setCurrent((c) => Math.max(c - 1, 0)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slides.length, presenting]);

  const closeReceipt = useCallback(() => setReceiptId(null), []);

  if (!view || !deck) {
    return (
      <div className="center-screen">
        {error ? (
          <>
            <p className="import-title">Deck not available</p>
            <p className="muted import-sub">{error}</p>
            <button className="btn btn-primary" onClick={() => navigate('/')}>New deck</button>
          </>
        ) : (
          <><div className="spinner" /><p className="muted">Opening deck...</p></>
        )}
      </div>
    );
  }

  const slide = slides[current];

  return (
    <div className="deck-page">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}><span className="brand-mark" />Dealdeck</a>
        <div className="topbar-title">
          <span className="tb-name">{deck.title || deck.entity.name}</span>
          {deck.forkOf && <span className="badge badge-fork">Your copy</span>}
          {(busy || building) && status && <span className="tb-status"><span className="pulse" />{status}</span>}
          {deck.status === 'error' && !busy && <span className="tb-status tb-error">Build hit an error</span>}
        </div>
        <div className="topbar-actions">
          <button className="btn btn-primary" disabled={!slides.length} onClick={() => setPresenting(true)}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
            Present
          </button>
          <BullBear deckId={deck.id} />
          <ShareButton deckId={deck.id} />
        </div>
      </header>

      {error && <div className="banner-error">{error}</div>}

      <div className="deck-body">
        <nav className="rail" ref={railRef} aria-label="Slides">
          {slides.map((s, i) => (
            <button key={s.id} data-idx={i} className={`rail-item ${i === current ? 'active' : ''}`} onClick={() => setCurrent(i)}>
              <span className="rail-num">{i + 1}</span>
              <span className="rail-thumb"><SlideView slide={s} deck={deck} thumb /></span>
            </button>
          ))}
          {(building || busy) && slides.length > 0 && (
            <div className="rail-item rail-pending"><span className="rail-num">{slides.length + 1}</span><span className="rail-thumb sk-thumb" /></div>
          )}
        </nav>

        <main className="stage">
          {slide ? (
            <>
              <div className="stage-slide" key={slide.id}>
                <SlideView slide={slide} deck={deck} onCite={setReceiptId} />
              </div>
              <div className="stage-nav">
                <button className="icon-btn" disabled={current === 0} onClick={() => setCurrent(current - 1)} aria-label="Previous slide">
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <span className="stage-count">{current + 1} / {slides.length}</span>
                <button className="icon-btn" disabled={current >= slides.length - 1} onClick={() => setCurrent(current + 1)} aria-label="Next slide">
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
              {slide.narration && <p className="stage-notes"><span>Speaker notes</span>{slide.narration}</p>}
            </>
          ) : (
            <Skeleton statusLog={statusLog} name={deck.entity.name} />
          )}
        </main>

        <aside className="chat-col">
          <ChatDock deckId={deck.id} chat={view.chat} streaming={streaming} busy={busy} />
        </aside>
      </div>

      <ReceiptPanel receiptId={receiptId} deckId={deck.id} onClose={closeReceipt} />
      {presenting && <PresentMode deck={deck} startIndex={current} onClose={() => setPresenting(false)} />}
    </div>
  );
}
