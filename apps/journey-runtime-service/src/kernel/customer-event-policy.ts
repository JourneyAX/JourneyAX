import type { BusinessPackRelease } from '@journeyax/business-pack';

export type CustomerEventAction = 'start_turn' | 'record_only';

/**
 * Resolves whether a customer event starts an agent turn automatically or is recorded only,
 * governed strictly by pack tenant policy (Prompt P3).
 *
 * Tenant policy takes precedence:
 * - autoTurnEvents (e.g. cart.added, quote.approved, addToCart) -> 'start_turn'
 * - recordOnlyEvents (e.g. cart.removed, removeFromCart, like) -> 'record_only'
 *
 * Neutral defaults apply when not configured in the pack:
 * - Primary intent actions (addToCart, addToQuote, cart.added, quote.approved, viewProduct, compareProducts) start a turn.
 * - Secondary actions (removeFromCart, like, dismiss) are recorded only.
 * - Tapping an option on a question card is recorded only: the answers are sent together as one message once every question on the
 *   card is answered, so a turn per tap would answer half a set of answers.
 */
export function resolveCustomerEventAction(
  eventType: string,
  release?: BusinessPackRelease | any
): CustomerEventAction {
  if (!eventType) return 'record_only';

  const policy =
    release?.conversationPolicy?.customerEvents ||
    release?.conversationPolicy?.eventPolicy ||
    release?.extensions?.customerEvents ||
    release?.extensions?.eventPolicy;

  const normalize = (s: string) => s.toLowerCase().replace(/[-_.]/g, '');
  const target = normalize(eventType);

  if (policy) {
    if (Array.isArray(policy.autoTurnEvents)) {
      if (policy.autoTurnEvents.some((e: string) => normalize(e) === target)) {
        return 'start_turn';
      }
    }
    if (Array.isArray(policy.recordOnlyEvents)) {
      if (policy.recordOnlyEvents.some((e: string) => normalize(e) === target)) {
        return 'record_only';
      }
    }
  }

  // Generic neutral fallback if not explicitly declared in pack policy
  const defaultAutoTurn = [
    'addtocart',
    'cartadded',
    'addtoquote',
    'quoteadded',
    'quoteapproved',
    // The customer asked for a last look at their order before paying.
    'reviewcart',
    // The customer opened a product's details or asked to see products side by side: a consultant would explain it.
    'viewproduct',
    'compareproducts',
  ];
  if (defaultAutoTurn.includes(target)) {
    return 'start_turn';
  }

  return 'record_only';
}
