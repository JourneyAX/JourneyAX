import type { ServerQuote } from './types';

export type CartChange = { kind: 'add' | 'set'; sku: string; quantity: number } | { kind: 'remove'; sku: string } | { kind: 'refresh' };
export interface CartSnapshot { cart: { version: number; items: Array<{ sku: string; quantity: number }>; status: string }; quote?: ServerQuote }

export async function readOwnedCart(tenantId: string, sessionId: string): Promise<CartSnapshot> {
  const response = await fetch(`/api/cart?project=${encodeURIComponent(tenantId)}&sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Your saved cart could not be read.');
  const snapshot = await response.json();
  if (!Number.isSafeInteger(snapshot?.cart?.version) || !Array.isArray(snapshot.cart.items)) throw new Error('Your saved cart is unavailable.');
  return snapshot;
}

/** Read current server state before applying a click; never reconstruct prices or merge from a stale local quote. No blind retry after conflicts. */
export async function changeOwnedCart(tenantId: string, sessionId: string, change: CartChange): Promise<CartSnapshot> {
  if (change.kind !== 'refresh' && (!change.sku || (change.kind !== 'remove' && (!Number.isSafeInteger(change.quantity) || change.quantity < 0 || change.quantity > 1_000_000 || (change.kind === 'add' && change.quantity === 0))))) throw new Error('Enter a valid whole quantity.');
  const current = await readOwnedCart(tenantId, sessionId);
  const items = current.cart.items.map(line => ({ sku: line.sku, quantity: line.quantity }));
  if (change.kind !== 'refresh') {
    const index = items.findIndex(line => line.sku === change.sku);
    if (change.kind === 'remove' || (change.kind === 'set' && change.quantity === 0)) {
      if (index >= 0) items.splice(index, 1);
    } else if (index >= 0) {
      items[index].quantity = change.kind === 'add' ? items[index].quantity + change.quantity : change.quantity;
    } else if (change.kind === 'add') items.push({ sku: change.sku, quantity: change.quantity });
    else throw new Error('Refresh the cart before changing this item.');
  }
  const response = await fetch(`/api/cart?project=${encodeURIComponent(tenantId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, items, expectedVersion: current.cart.version, idempotencyKey: crypto.randomUUID() }) });
  const result = await response.json();
  if (!response.ok || !result?.cart) throw new Error(response.status === 409 ? 'The cart changed in another action. Refresh it before trying again.' : 'The cart could not be updated.');
  return result;
}
