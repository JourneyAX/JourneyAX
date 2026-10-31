/**
 * A product the customer has already added to their cart or quote is not recommended to them again.
 *
 * When the assistant puts recommendations on a card (the picks, the bundle, the accessories), the server removes any product that is already
 * in the cart, or that the customer's own tap added this turn, so "add this one" is not followed by the same product appearing on the next card.
 * A product the customer asked to look at (its detail card, a comparison, the review of the order) is a different thing and is not touched.
 */
type Rec = Record<string, any>;

/** The card types that recommend products. */
export const RECOMMENDATION_CARDS: readonly string[] = ['products', 'bundle', 'accessories'];

const skuOf = (line: any): string => {
  const sku = line?.sku ?? line?.productId ?? line?.variant?.sku;
  return typeof sku === 'string' ? sku.trim() : '';
};

const linesOf = (cart: any): any[] => (Array.isArray(cart?.items) ? cart.items : Array.isArray(cart?.lines) ? cart.lines : Array.isArray(cart?.lineItems) ? cart.lineItems : []);

/** The SKUs in the customer's cart or quote (from every place the runtime keeps it) and those their tap added this turn. */
export function skusInCart(sources: { carts?: any[]; event?: any }): Set<string> {
  const out = new Set<string>();
  for (const cart of sources.carts ?? []) for (const line of linesOf(cart)) { const sku = skuOf(line); if (sku) out.add(sku); }
  const event = sources.event;
  if (event && /add/i.test(String(event.type || '')) && /cart|quote|bag|basket/i.test(String(event.type || ''))) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const named = [payload.sku, ...(Array.isArray(payload.skus) ? payload.skus : []), ...(Array.isArray(payload.items) ? payload.items.map((line: any) => line?.sku) : [])];
    for (const sku of named) if (typeof sku === 'string' && sku.trim()) out.add(sku.trim());
  }
  return out;
}

export interface DropResult { state: Rec; removed: string[]; empty: boolean }

/**
 * The card's products without the ones already added. `empty` says the card has nothing left to recommend, so it should not be shown.
 * The state is copied, never changed.
 */
export function dropAdded(cardType: string, state: Rec, added: Set<string>): DropResult {
  if (!RECOMMENDATION_CARDS.includes(cardType) || added.size === 0 || !state || typeof state !== 'object') return { state, removed: [], empty: false };
  const removed: string[] = [];
  const keep = (list: any): any => (Array.isArray(list) ? list.filter((item) => { const sku = skuOf(item); if (sku && added.has(sku)) { removed.push(sku); return false; } return true; }) : list);
  const next: Rec = { ...state };
  let had = 0;
  let left = 0;
  for (const key of ['products', 'items'] as const) {
    if (Array.isArray(state[key])) { had += state[key].length; next[key] = keep(state[key]); left += next[key].length; }
  }
  if (Array.isArray(state.groups)) {
    const groups = state.groups.map((group: Rec) => ({ ...group, items: keep(group?.items) })).filter((group: Rec) => !Array.isArray(group.items) || group.items.length > 0);
    had += state.groups.reduce((n: number, group: Rec) => n + (Array.isArray(group?.items) ? group.items.length : 0), 0);
    left += groups.reduce((n: number, group: Rec) => n + (Array.isArray(group.items) ? group.items.length : 0), 0);
    next.groups = groups;
  }
  return { state: removed.length ? next : state, removed: [...new Set(removed)], empty: had > 0 && left === 0 };
}
