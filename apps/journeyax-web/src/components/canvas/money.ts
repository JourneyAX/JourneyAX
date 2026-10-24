/** Money as the server states it: the order's or quote's own symbol and currency, never a guess. */
export function formatMoney(amount: number | null | undefined, symbol?: string, currency?: string, zeroIsUnknown = false): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return 'Price on request';
  if (amount === 0 && zeroIsUnknown) return 'Price on request';
  const figure = amount.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 });
  return `${symbol || '$'}${figure}${currency ? ` ${currency}` : ''}`;
}

/** A short order reference for people ("A1B2C3D4") from the long order id. */
export function orderRef(orderId: string | undefined | null): string {
  const id = String(orderId || '').replace(/^ord_/, '');
  return id ? id.slice(-8).toUpperCase() : '';
}

/** Order numbers people have seen in this tab, so "#A1B2C3D4" in a message can open the order it names. */
const knownOrders = new Map<string, string>();
export function rememberOrder(orderId: string | undefined | null): void {
  const ref = orderRef(orderId);
  if (ref && orderId) knownOrders.set(ref, orderId);
}
export function orderIdForRef(ref: string): string | undefined {
  return knownOrders.get(String(ref).toUpperCase());
}
