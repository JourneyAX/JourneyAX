import type Stripe from 'stripe';
import type { OrderDoc } from './order.service';

/** Provider currency protocol rules, independent of merchant pricing. */
export function currencyMinorAmount(amount: number, currency: string): number {
  const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
  const wholeOnly = currency === 'ISK' || currency === 'UGX';
  if (wholeOnly && !Number.isInteger(amount)) throw new Error('This currency cannot charge fractional amounts.');
  const digits = zeroDecimal.has(currency) ? 0 : new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  const stripeDigits = wholeOnly ? 2 : digits;
  if (stripeDigits === undefined || stripeDigits > 2 || !Number.isFinite(amount)) throw new Error('Unsupported payment amount or currency.');
  const scaled = amount * 10 ** stripeDigits; const minor = Math.round(scaled);
  if (!Number.isSafeInteger(minor) || minor <= 0 || Math.abs(scaled - minor) > 0.000001) throw new Error('Invalid payment amount.');
  return minor;
}

export function sessionMatchesOrder(session: Stripe.Checkout.Session, order: OrderDoc): boolean {
  try { return session.livemode === false && session.id === order.stripeSessionId && session.metadata?.orderId === order.orderId &&
    session.metadata?.tenantId === order.tenantId && session.metadata?.quoteId === order.quoteId &&
    (order.quoteVersion === undefined || session.metadata?.quoteVersion === String(order.quoteVersion)) &&
    (!order.environmentId || session.metadata?.environmentId === order.environmentId) && (!order.principalId || session.metadata?.principalId === order.principalId) &&
    session.amount_total === currencyMinorAmount(order.total, order.currency) && session.currency?.toUpperCase() === order.currency.toUpperCase();
  } catch { return false; }
}

export function paymentMatchesOrder(session: Stripe.Checkout.Session, order: OrderDoc): boolean {
  return session.payment_status === 'paid' && session.status === 'complete' && sessionMatchesOrder(session, order);
}
