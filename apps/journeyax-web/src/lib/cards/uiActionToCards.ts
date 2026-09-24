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
import type { CardInstance } from '../types';

export interface UiActionFrame {
  name: string;
  arguments?: unknown;
  card?: { cardType: CardInstance['cardType']; state: Record<string, unknown>; streamId?: string; variant?: string };
}

export function uiActionToCards(frame: UiActionFrame): CardInstance[] {
  let cardObj: any = null;

  if (frame.name === 'presentCard') {
    const args = frame.arguments as any;
    if (args?.card) {
      cardObj = args.card;
    } else if (args?.cardType) {
      cardObj = args;
    }
  }

  if (!cardObj && frame.card) {
    cardObj = frame.card;
  }

  if (!cardObj) return [];

  return [{
    id: cardObj.id || cardObj.streamId || `${cardObj.cardType}-${Date.now()}`,
    cardType: cardObj.cardType,
    state: cardObj.state || {},
    variant: cardObj.variant,
    streamId: cardObj.streamId,
    createdAt: cardObj.createdAt || new Date().toISOString(),
  }];
}
