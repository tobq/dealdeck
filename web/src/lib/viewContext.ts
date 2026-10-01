// Where the viewer is right now (page + what they last focused). Every chat message carries it, so the
// one analyst thread can resolve "this", "that point" or "explain that" across Presentation, Arguments and FAQ.
import type { DeckPageName } from '../../../shared/types';
export type ViewPage = DeckPageName;

export const viewContext: { page: ViewPage; focus: string } = { page: 'presentation', focus: '' };

export function setViewPage(page: ViewPage) {
  if (viewContext.page !== page) viewContext.focus = '';
  viewContext.page = page;
}

export function setViewFocus(focus: string) {
  viewContext.focus = focus.slice(0, 400);
}

/** Fields merged into every POST /api/decks/:id/chat body. */
export const viewFields = () => ({ view: viewContext.page, ...(viewContext.focus ? { focus: viewContext.focus } : {}) });
