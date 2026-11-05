import type { CommerceQuote, QuoteLine } from './commerce';
import { commerceFractionDigits, commerceMinorAmount, commerceRateAmount } from './commerce-money';
export interface CommercePricingPolicy { currency: string; symbol?: string; taxRate: number; discountRate: number }

/** Tax, discounts and checkout validity come from the immutable merchant policy, never from tool input. */
export function priceCommerceLines(lines: Array<QuoteLine & { currency?: string }>, pricing: CommercePricingPolicy | undefined, requestedCurrency?: string): Pick<CommerceQuote, 'lines' | 'currency' | 'symbol' | 'subtotal' | 'discountRate' | 'discount' | 'taxRate' | 'tax' | 'total' | 'validation'> {
  const currencies = [...new Set(lines.map(line => (line as any).currency).filter(Boolean))];
  if (currencies.length > 1) throw new Error('Mixed currencies detected across quote items.');
  const currency = currencies[0] ?? pricing?.currency;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new Error('Missing authoritative currency (requestedCurrency cannot be sole authority).');
  if ((requestedCurrency && requestedCurrency.toUpperCase() !== currency) || (pricing?.currency && pricing.currency !== currency)) throw new Error('Conflicting currency in catalogue and quote policy.');
  const hasTaxPolicy = !!pricing && Number.isFinite(pricing.taxRate) && pricing.taxRate >= 0 && pricing.taxRate <= 1 && Number.isFinite(pricing.discountRate) && pricing.discountRate >= 0 && pricing.discountRate <= 1;
  const factor = 10 ** commerceFractionDigits(currency);
  const pricedLines = lines.map(line => ({ ...line, lineTotal: line.unitPrice == null ? 0 : commerceMinorAmount(line.unitPrice, currency, line.quantity) / factor }));
  const subtotalMinor = pricedLines.reduce((sum, line) => sum + commerceMinorAmount(line.lineTotal, currency), 0);
  if (!Number.isSafeInteger(subtotalMinor)) throw new Error('Quote total is outside the supported range.');
  const subtotal = subtotalMinor / factor;
  const discountRate = hasTaxPolicy && pricing ? pricing.discountRate : 0;
  const taxRate = hasTaxPolicy && pricing ? pricing.taxRate : 0;
  const discountMinor = commerceRateAmount(subtotalMinor, discountRate), taxMinor = commerceRateAmount(subtotalMinor - discountMinor, taxRate);
  const discount = discountMinor / factor, tax = taxMinor / factor;
  const errors = [...(lines.some(line => line.unitPrice == null) ? ['One or more products require a confirmed price.'] : []), ...(!hasTaxPolicy ? ['The merchant tax and discount policy must be configured before checkout.'] : [])];
  const totalMinor = subtotalMinor - discountMinor + taxMinor;
  if (!Number.isSafeInteger(totalMinor)) throw new Error('Quote total is outside the supported range.');
  return { lines: pricedLines, currency, symbol: pricing?.symbol ?? currency, subtotal, discountRate, discount, taxRate, tax, total: totalMinor / factor, validation: { ok: errors.length === 0, errors, warnings: lines.some(line => line.inStock === false) ? ['Some products are not currently available.'] : [] } };
}
