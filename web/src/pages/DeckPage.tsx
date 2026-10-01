import { useCallback, useEffect, useRef, useState } from 'react';
import type { Deck } from '../../../shared/types';
import SlideView from '../components/SlideView';
import ReceiptPanel from '../components/ReceiptPanel';
import ChatDock, { Md } from '../components/ChatDock';
import { usePlayback } from '../components/PresentMode';
import BullBear from '../components/BullBear';
import ShareButton from '../components/ShareButton';
import { useDeck } from '../lib/useDeck';
import { bus } from '../lib/bus';
import { navigate } from '../lib/api';
import { useVoice } from '../voice/useVoice';

const Ico = {
  prev: <svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  next: <svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  play: <svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>,
  pause: <svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" /></svg>,
  mic: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  full: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>,
  edit: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>,
};

function Skeleton({ statusLog, name, slidesDone = 0 }: { statusLog: string[]; name: string; slidesDone?: number }) {
  // Only the latest few steps: the full log scrolls off a projector.
  const shown = statusLog.slice(-6);
  return (
    <div className="skeleton-stage">
      <div className="slide-box skeleton-box">
        <div className="sk-inner">
          <div className="sk-eyebrow">Building your deck{slidesDone ? ` · ${slidesDone} slide${slidesDone === 1 ? '' : 's'} written` : ''}</div>
          <div className="sk-title">{name}</div>
          <div className="sk-lines"><i /><i /><i /></div>
          <ul className="sk-status">
            {shown.length === 0 && <li className="current"><span className="spinner spinner-xs" />Starting the analyst...</li>}
            {shown.map((s, i) => (
              <li key={i + s} className={i === shown.length - 1 ? 'current' : 'done'}>
                {i === shown.length - 1 ? <span className="spinner spinner-xs" /> : <span className="tick" />}
                {s}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

const toggleFullscreen = () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen?.().catch(() => {});
};

/** Play-first view: the slide, a quiet header and one control bar (play/pause, nav, talk, feedback). */
function Player({ deck, current, setCurrent, playing, setPlaying, busy, building, status, statusLog, streaming, review, onCite, onEdit }: {
  deck: Deck; current: number; setCurrent: (i: number) => void; playing: boolean; setPlaying: (p: boolean) => void;
  busy: boolean; building: boolean; status: string | null; statusLog: string[]; streaming: string; review: string | null;
  onCite: (r: string) => void; onEdit: () => void;
}) {
  const slides = deck.slides;
  const slide = slides[current];
  const v = useVoice(deck.id);
  const [text, setText] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  usePlayback({ deckId: deck.id, slides, index: current, setIndex: setCurrent, playing, setPlaying, building });

  // Agent answers surface as a caption over the player; spoken ones also play via the shared player.
  // Only answers to something the viewer asked become a caption; the build summary stays in Edit view's chat.
  const askedRef = useRef(false);
  askedRef.current = asked || v.micOn;
  useEffect(() => bus.on('chat', (e) => {
    if (e.message.role === 'assistant' && askedRef.current) { setToast(e.message.spoken || e.message.text); setAsked(false); }
  }), []);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 25000); return () => clearTimeout(t); }, [toast]);
  // Talking to the deck pauses the show so the answer can be heard.
  useEffect(() => { if (v.micOn) setPlaying(false); }, [v.micOn, setPlaying]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    setPlaying(false);
    setAsked(true);
    setToast(null);
    const r = await fetch('/api/decks/' + deck.id + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) }).catch(() => null);
    if (!r || !r.ok) { setAsked(false); setText(t); setToast(`Send failed${r ? ` (${r.status})` : ''}`); }
  };

  const caption = (asked && streaming) ? streaming : toast;
  const pending = building || (busy && !!status);

  return (
    <div className="pl-root">
      <header className="pl-top">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}><span className="brand-mark" /></a>
        <span className="pl-title">{deck.title || deck.entity.name}</span>
        {deck.forkOf && <span className="badge badge-fork">Your copy</span>}
        {pending && <span className="pl-pill"><span className="pulse" />{building ? `Building... ${slides.length} slide${slides.length === 1 ? '' : 's'}` : 'Working'}{status ? ` · ${status}` : ''}</span>}
        {review && <span className="pl-review">{review}</span>}
        {deck.status === 'error' && !busy && <span className="tb-status tb-error">Build hit an error</span>}
      </header>

      <main className="pl-stage">
        {/* The reviewer may still rewrite slides, so the player stays on the loading screen until the deck is ready. */}
        {slide && !building ? (
          <div className="pl-slide" key={slide.id}>
            <SlideView slide={slide} deck={deck} onCite={onCite} />
          </div>
        ) : (
          <Skeleton statusLog={review ? [...statusLog, review] : statusLog} name={deck.entity.name} slidesDone={slides.length} />
        )}
        {playing && slide?.narration && !caption && <p className="pl-narration">{slide.narration}</p>}
        {(caption || (asked && busy)) && (
          <div className="pl-toast" role="status">
            <div className="pl-toast-body">{caption ? <Md text={caption} /> : <span className="muted">Thinking...</span>}</div>
            <button className="pl-x" aria-label="Dismiss" onClick={() => { setToast(null); setAsked(false); }}>×</button>
          </div>
        )}
        {v.micOn && <div className="pl-heard">{v.partial ? `"${v.partial}"` : v.state === 'thinking' ? 'Thinking...' : 'Listening...'}</div>}
      </main>

      <footer className="pl-bar">
        <div className="pl-transport">
          <button className="pl-ib" disabled={current === 0} onClick={() => setCurrent(Math.max(0, current - 1))} aria-label="Previous slide">{Ico.prev}</button>
          <button className="pl-play" disabled={!slides.length} onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing}>{playing ? Ico.pause : Ico.play}</button>
          <button className="pl-ib" disabled={current >= slides.length - 1} onClick={() => setCurrent(Math.min(slides.length - 1, current + 1))} aria-label="Next slide">{Ico.next}</button>
          <span className="pl-count">{slides.length ? `${current + 1} / ${slides.length}` : '0 / 0'}</span>
        </div>
        <form className="pl-ask" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <button type="button" className={`pl-talk${v.micOn ? ' on' : ''}`} onClick={v.toggleMic} aria-pressed={v.micOn} title={v.micOn ? 'Stop listening' : 'Talk to the analyst'}>{Ico.mic}<span>{v.micOn ? 'Listening' : 'Talk'}</span></button>
          <input className="pl-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Give feedback or ask..." />
        </form>
        <div className="pl-tools">
          <BullBear deckId={deck.id} />
          <ShareButton deckId={deck.id} />
          <button className="pl-ib" onClick={toggleFullscreen} title="Present fullscreen" aria-label="Present fullscreen">{Ico.full}</button>
          <button className="pl-ib" onClick={onEdit} title="Edit view" aria-label="Edit view">{Ico.edit}</button>
        </div>
      </footer>
      {v.error && <div className="pl-err">{v.error}</div>}
    </div>
  );
}

export default function DeckPage({ id }: { id: string }) {
  const { view, streaming, status, statusLog, error } = useDeck(id);
  const [current, setCurrentRaw] = useState(0);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [mode, setMode] = useState<'play' | 'edit'>('play');
  const [playing, setPlaying] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const deck = view?.deck;
  const slides = deck?.slides || [];
  const busy = !!view?.busy;
  const building = deck?.status === 'building';
  const setCurrent = useCallback((i: number) => setCurrentRaw(i), []);

  useEffect(() => { if (current > slides.length - 1) setCurrentRaw(Math.max(0, slides.length - 1)); }, [slides.length, current]);
  useEffect(() => { if (deck) document.title = `${deck.title || deck.entity.name} - Dealdeck`; return () => { document.title = 'Dealdeck'; }; }, [deck?.title, deck?.entity.name]);
  useEffect(() => bus.on('review', (e) => {
    const note = e.notes[0] ? `: ${e.notes[0]}` : '';
    setReview(e.done ? `Reviewer pass ${e.iteration}: done` : `Reviewer pass ${e.iteration}${note}`.slice(0, 120));
  }), []);

  // Edit view follows the build to each new slide; the player stays put (slide 1) while slides stream in.
  const prevCount = useRef(0);
  useEffect(() => {
    if (mode === 'edit' && building && slides.length > prevCount.current && prevCount.current > 0) setCurrentRaw(slides.length - 1);
    prevCount.current = slides.length;
  }, [slides.length, building, mode]);

  useEffect(() => {
    if (mode === 'edit') railRef.current?.querySelector<HTMLElement>(`[data-idx="${current}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [current, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); setCurrentRaw((c) => Math.min(c + 1, slides.length - 1)); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); setCurrentRaw((c) => Math.max(c - 1, 0)); }
      else if (e.key === ' ' && mode === 'play') { e.preventDefault(); setPlaying((p) => !p); }
    };
    // Space on a focused button would also click it on keyup (double toggle); the keydown handler owns Space.
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === ' ' && mode === 'play' && e.target instanceof HTMLButtonElement) e.preventDefault(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  }, [slides.length, mode]);

  const closeReceipt = useCallback(() => setReceiptId(null), []);
  const present = () => { setMode('play'); setPlaying(true); toggleFullscreen(); };

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

  if (mode === 'play') {
    return (
      <>
        {error && <div className="banner-error">{error}</div>}
        <Player
          deck={deck} current={current} setCurrent={setCurrent} playing={playing} setPlaying={setPlaying}
          busy={busy} building={building} status={status} statusLog={statusLog} streaming={streaming} review={review}
          onCite={setReceiptId} onEdit={() => { setPlaying(false); setMode('edit'); }}
        />
        <ReceiptPanel receiptId={receiptId} deckId={deck.id} onClose={closeReceipt} />
      </>
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
          {review && <span className="tb-status tb-review">{review}</span>}
          {deck.status === 'error' && !busy && <span className="tb-status tb-error">Build hit an error</span>}
        </div>
        <div className="topbar-actions">
          <button className="btn btn-primary" disabled={!slides.length} onClick={present}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
            Present
          </button>
          <button className="btn" onClick={() => setMode('play')}>Player</button>
          <BullBear deckId={deck.id} />
          <ShareButton deckId={deck.id} />
        </div>
      </header>

      {error && <div className="banner-error">{error}</div>}

      <div className="deck-body">
        <nav className="rail" ref={railRef} aria-label="Slides">
          {slides.map((s, i) => (
            <button key={s.id} data-idx={i} className={`rail-item ${i === current ? 'active' : ''}`} onClick={() => setCurrentRaw(i)}>
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
                <button className="icon-btn" disabled={current === 0} onClick={() => setCurrentRaw(current - 1)} aria-label="Previous slide">{Ico.prev}</button>
                <span className="stage-count">{current + 1} / {slides.length}</span>
                <button className="icon-btn" disabled={current >= slides.length - 1} onClick={() => setCurrentRaw(current + 1)} aria-label="Next slide">{Ico.next}</button>
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
    </div>
  );
}
