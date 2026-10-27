/**
 * Cards that are never folded into an earlier card of the same type. A new product card replaces the last one (the thread shows the latest
 * answer's products), but a lookup can show several record cards in one turn (the customer, then their cases): each is its own card, and each
 * keeps its own place under the reply.
 */
const OWN_PLACE = new Set(['records']);

export function keepsOwnPlace(card: { cardType: string; variant?: string }): boolean {
  return card.variant === 'append' || OWN_PLACE.has(card.cardType);
}
