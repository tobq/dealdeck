// SSE subscription -> DeckView state. Every event is also re-emitted on lib/bus.
import { useEffect, useRef, useState } from 'react';
import type { DeckEvent, DeckView, Slide } from '../../../shared/types';
import { api } from './api';
import { bus } from './bus';

export interface DeckState {
  view: DeckView | null;
  streaming: string;
  status: string | null;
  statusLog: string[];
  error: string | null;
  connected: boolean;
}

const initial: DeckState = { view: null, streaming: '', status: null, statusLog: [], error: null, connected: false };

function upsertSlide(slides: Slide[], slide: Slide, index: number): Slide[] {
  const next = slides.filter((s) => s.id !== slide.id);
  const i = Math.max(0, Math.min(typeof index === 'number' ? index : next.length, next.length));
  next.splice(i, 0, slide);
  return next;
}

export function applyEvent(st: DeckState, e: DeckEvent): DeckState {
  switch (e.type) {
    case 'snapshot':
      // A reconnect snapshot is authoritative: drop stale streaming/status when no turn is running.
      return e.view.busy ? { ...st, view: e.view, error: null } : { ...st, view: e.view, error: null, streaming: '', status: null };
    case 'deck':
      return st.view ? { ...st, view: { ...st.view, deck: e.deck } } : st;
    case 'slide':
      if (!st.view) return st;
      return { ...st, view: { ...st.view, deck: { ...st.view.deck, slides: upsertSlide(st.view.deck.slides, e.slide, e.index) } } };
    case 'slide_removed':
      if (!st.view) return st;
      return { ...st, view: { ...st.view, deck: { ...st.view.deck, slides: st.view.deck.slides.filter((s) => s.id !== e.id) } } };
    case 'receipt':
      if (!st.view) return st;
      return { ...st, view: { ...st.view, receipts: [...st.view.receipts.filter((r) => r.id !== e.receipt.id), e.receipt] } };
    case 'busy':
      return st.view ? { ...st, view: { ...st.view, busy: e.busy }, status: e.busy ? st.status : null } : st;
    case 'chat': {
      if (!st.view) return st;
      const chat = [...st.view.chat.filter((m) => m.id !== e.message.id), e.message];
      return { ...st, view: { ...st.view, chat }, streaming: e.message.role === 'assistant' ? '' : st.streaming };
    }
    case 'assistant_delta':
      return { ...st, streaming: st.streaming + e.text };
    case 'status':
      return { ...st, status: e.text, statusLog: [...st.statusLog, e.text].slice(-8) };
    case 'error':
      return { ...st, error: e.message };
    default:
      return st;
  }
}

export function useDeck(id: string): DeckState {
  const [state, setState] = useState<DeckState>(initial);
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    setState(initial);
    let closed = false;
    // Fallback fetch in case the SSE snapshot is slow; the snapshot replaces it.
    api.getDeck(id).then((view) => {
      if (!closed) setState((st) => (st.view ? st : { ...st, view }));
    }).catch((err) => {
      if (!closed) setState((st) => (st.view ? st : { ...st, error: String(err.message || err) }));
    });
    const es = new EventSource(api.eventsUrl(id));
    es.onopen = () => !closed && setState((st) => ({ ...st, connected: true }));
    es.onerror = () => !closed && setState((st) => ({ ...st, connected: false }));
    es.onmessage = (msg) => {
      let e: DeckEvent;
      try { e = JSON.parse(msg.data); } catch { return; }
      if (closed) return;
      setState((st) => applyEvent(st, e));
      bus.emit(e);
    };
    return () => { closed = true; es.close(); };
  }, [id]);

  return state;
}
