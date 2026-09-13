/**
 * Live `uiAction` SSE frame → CardInstance[] (v3 Card CMS).
 *
 * Two sources feed the card stack:
 *  1. The legacy tool names (showItems, updateQuote, showGuide, …) still just
 *     dispatch the SAME legacy actions they always have (SET_RECOMMENDED_PRODUCTS,
 *     SET_SERVER_QUOTE, …) — JourneyProvider's card-sync effects (see
 *     JourneyContext.tsx) mirror those into cards automatically, cfg-aware.
 *     ChatPanel needs no change for those tools to render as cards.
 *  2. A forward-looking `card` field the server MAY attach to a `uiAction`
 *     frame once the agent's presentation layer emits enriched cards directly
 *     (docs/v3-card-cms-architecture.md §5, not yet built) — `{ name, arguments,
 *     card: { cardType, state, streamId } }`. This function is the one place
 *     that reads it, so wiring it up later needs no ChatPanel changes either.
 */
import type { CardInstance } from '@/lib/types';

export interface UiActionFrame {
  name: string;
  arguments?: unknown;
  card?: { cardType: CardInstance['cardType']; state: Record<string, unknown>; streamId?: string; variant?: string };
}

export function uiActionToCards(frame: UiActionFrame): CardInstance[] {
  if (!frame.card) return [];
  const { cardType, state, streamId, variant } = frame.card;
  return [{
    id: streamId || `${cardType}-${Date.now()}`,
    cardType,
    state,
    variant,
    streamId,
    createdAt: new Date().toISOString(),
  }];
}
