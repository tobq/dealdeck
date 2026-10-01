// Tiny in-page event bus: lib/useDeck re-dispatches every server DeckEvent here so voice/present/
// bull-bear components can react without prop drilling.
import type { DeckEvent } from '../../../shared/types';

type Handler = (e: any) => void;
const handlers = new Map<string, Set<Handler>>();

export const bus = {
  on<T extends DeckEvent['type']>(type: T, cb: (e: Extract<DeckEvent, { type: T }>) => void): () => void {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type)!.add(cb as Handler);
    return () => handlers.get(type)?.delete(cb as Handler);
  },
  emit(e: DeckEvent) {
    handlers.get(e.type)?.forEach((cb) => cb(e));
  },
};
