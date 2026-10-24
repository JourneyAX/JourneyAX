/**
 * The last look before payment, asked for by the cart's checkout button.
 *
 * The button does not go straight to payment when the shop has switched the review on: it asks the consultant for a review card
 * (what the quantities cover, what else may be needed, pick-up or delivery, warranty and guides). The card's own button goes on to
 * payment. A cart that has already been reviewed, and has not changed since, goes straight on.
 */
export interface ReviewQuoteLine {
  sku?: string;
  name?: string;
  quantity?: number;
  branchStock?: { status?: string } | null;
}

export interface ReviewEvent {
  type: 'reviewCart';
  payload: {
    title: string;
    items: Array<{ sku: string; title: string; quantity: number; stock?: { status: string } }>;
    branch?: { id?: string; name?: string };
  };
}

/** The order's lines as the consultant needs them; null when the order has no line with a product code. */
export function buildReviewEvent(
  lines: ReviewQuoteLine[] | undefined,
  branch: { id?: string; name?: string } | undefined,
  title = 'my order before I pay',
): ReviewEvent | null {
  const items = (lines || [])
    .filter((line) => typeof line.sku === 'string' && line.sku.trim())
    .map((line) => ({
      sku: String(line.sku).trim(),
      title: String(line.name || line.sku),
      quantity: Math.max(1, Math.floor(Number(line.quantity ?? 1)) || 1),
      ...(line.branchStock?.status ? { stock: { status: String(line.branchStock.status) } } : {}),
    }));
  if (items.length === 0) return null;
  const chosen = branch && (branch.id || branch.name) ? { ...(branch.id ? { id: branch.id } : {}), ...(branch.name ? { name: branch.name } : {}) } : undefined;
  return { type: 'reviewCart', payload: { title, items, ...(chosen ? { branch: chosen } : {}) } };
}

/** Changes whenever a line, a quantity or the chosen branch changes, so a changed order is looked at again. */
export function reviewFingerprint(lines: ReviewQuoteLine[] | undefined, branchId?: string): string {
  return [...(lines || [])].map((line) => `${line.sku}:${line.quantity ?? 1}`).sort().join('|') + `@${branchId || ''}`;
}
