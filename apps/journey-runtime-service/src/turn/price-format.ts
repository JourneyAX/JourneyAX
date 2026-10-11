/**
 * Formats a catalog price for customer-facing text. The currency is the one the product declared (or the
 * pack's primary currency); no symbol is ever assumed. Without a price the caller-supplied wording is used.
 */
export function formatCatalogPrice(
  price: unknown,
  currency: string | undefined,
  onRequest: string,
): string {
  const raw = price as any;
  let amount: number | undefined;
  if (raw && typeof raw === 'object') {
    if (raw.amountCents !== undefined && raw.amountCents !== null) amount = Number(raw.amountCents) / 100;
    else if (raw.amount !== undefined && raw.amount !== null) amount = Number(raw.amount);
  } else if (typeof raw === 'number') {
    amount = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    amount = Number(raw);
  }
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return onRequest;
  const code = currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : undefined;
  if (!code) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}
