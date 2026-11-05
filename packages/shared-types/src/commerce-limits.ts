/** Bounds of the paid-order-v1 delivery contract. Reject before collecting payment. */
export const PAID_ORDER_LIMITS = Object.freeze({ maxLines: 50, maxQuantityPerLine: 1000 });

export function validatePaidOrderItems(items: readonly { quantity: number }[]): void {
  if (!Array.isArray(items) || items.length > PAID_ORDER_LIMITS.maxLines) throw new Error(`A checkout supports at most ${PAID_ORDER_LIMITS.maxLines} lines.`);
  if (items.some(item => !Number.isSafeInteger(item?.quantity) || item.quantity < 1 || item.quantity > PAID_ORDER_LIMITS.maxQuantityPerLine)) {
    throw new Error(`Each checkout line requires a whole quantity from 1 to ${PAID_ORDER_LIMITS.maxQuantityPerLine}.`);
  }
}
