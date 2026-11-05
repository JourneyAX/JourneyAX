import { createHash } from 'node:crypto';
import { allocateCommerceMinor, commerceFractionDigits, commerceMinorAmount, commerceRateAmount, roundCommerceRatio } from '@journeyax/shared-types';
import { ToolError, type Rec } from '../types';

type Api = (method: string, path: string, request?: { body?: unknown; query?: Rec }) => Promise<Rec>;
export interface PricedCommerceLine { sku: string; name: string; quantity: number; unitPrice: number }

/** The same minor-unit totals as the quote, allocated without per-unit penny loss. */
export function commerceOrderMoney(lines: PricedCommerceLine[], currency: string, discount: number, taxRate: number, expectedTotal?: number) {
  try {
    if (lines.length < 1 || lines.length > 50 || new Set(lines.map(l => l.sku)).size !== lines.length || lines.some(l => !Number.isSafeInteger(l.quantity) || l.quantity < 1 || l.quantity > 1000 || !Number.isFinite(l.unitPrice) || l.unitPrice < 0 || l.unitPrice > 1_000_000)) throw new Error('Invalid paid order lines.');
    const digits = commerceFractionDigits(currency), weights = lines.map(l => commerceMinorAmount(l.unitPrice, currency, l.quantity));
    const subtotal = weights.reduce((sum, amount) => sum + amount, 0), reduction = commerceMinorAmount(discount, currency);
    if (!Number.isSafeInteger(subtotal) || !Number.isFinite(discount) || discount < 0 || reduction > subtotal) throw new Error('Invalid order discount.');
    const net = subtotal - reduction, tax = commerceRateAmount(net, taxRate), gross = net + tax;
    if (!Number.isSafeInteger(gross)) throw new Error('Order total exceeds the supported range.');
    if (expectedTotal !== undefined && (commerceMinorAmount(expectedTotal, currency) !== gross || Math.abs(expectedTotal - gross / 10 ** digits) > 1e-8)) throw new ToolError('price_mismatch', 'The paid total does not match its configured lines, discount and tax.');
    const lineNet = allocateCommerceMinor(net, weights), lineTax = allocateCommerceMinor(tax, lineNet);
    return { digits, subtotal, discount: reduction, net, tax, gross, lineNet, lineTax };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('invalid_arguments', 'The order has invalid monetary lines, currency, discount or tax.');
  }
}

/** Prepare the existing vendor cart contract for paid-order delivery. No order is
 * created and no payment is charged here. External tax amounts preserve the
 * already-authoritative quote total instead of recalculating tax per unit. */
export async function preparePaidCommerceCart(api: Api, input: { orderNumber: string; currency: string; locale: string; lines: PricedCommerceLine[]; discount: number; taxRate: number; taxCountry: string; taxName: string; expectedTotal?: number; customerEmail?: string; customerId?: string; shippingAddress?: Rec }) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.orderNumber) || !/^[A-Z]{2}$/.test(input.taxCountry) || !input.taxName.trim() || input.taxName.length > 80) throw new ToolError('invalid_arguments', 'A stable order number and configured tax jurisdiction/label are required.');
  const { lines, currency } = input;
  const plan = commerceOrderMoney(lines, currency, input.discount, input.taxRate, input.expectedTotal);
  const money = (centAmount: number) => ({ type: 'centPrecision', currencyCode: currency, centAmount, fractionDigits: plan.digits });
  const keys = lines.map(line => `jax_${Buffer.from(line.sku).toString('base64url')}`);
  if (keys.some(key => key.length > 256)) throw new ToolError('invalid_arguments', 'An item identifier is too long for the commerce system.');
  const key = `jax_paid_${createHash('sha256').update(input.orderNumber).digest('hex')}`;
  let cart: any;
  try { cart = await api('GET', `/carts/key=${key}`); }
  catch (error) { if (!(error instanceof ToolError && error.code === 'not_found')) throw error; }
  const rows = lines.map((line, index) => {
    const net = plan.lineNet[index], quantity = line.quantity;
    const unitMoney = net % quantity === 0 ? money(net / quantity) : {
      type: 'highPrecision', currencyCode: currency, fractionDigits: plan.digits + 6,
      preciseAmount: roundCommerceRatio(BigInt(net) * 1_000_000n, BigInt(quantity)),
    };
    return { key: keys[index], name: { [input.locale]: line.name }, quantity, slug: keys[index], money: unitMoney, priceMode: 'External' };
  });
  if (!cart) {
    const body = { key, currency, country: input.taxCountry, locale: input.locale, taxMode: 'ExternalAmount', priceRoundingMode: 'HalfUp', taxRoundingMode: 'HalfUp', taxCalculationMode: 'LineItemLevel',
      ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}), ...(input.customerId ? { customerId: input.customerId } : {}), ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}), customLineItems: rows };
    try { cart = await api('POST', '/carts', { body }); }
    catch (error) { try { cart = await api('GET', `/carts/key=${key}`); } catch { throw error; } }
  }
  const cents = (value: any, expected: number) => value?.currencyCode === currency && value.centAmount === expected;
  const sourceMatches = (value: any) => {
    const byKey = new Map<string, any>((value?.customLineItems || []).map((l: any) => [l.key, l]));
    return Boolean(value?.id && Array.isArray(value.customLineItems) && value.key === key && Number.isSafeInteger(value.version) && value.cartState === 'Active' && value.taxMode === 'ExternalAmount' &&
      (!input.customerId || value.customerId === input.customerId) && (!input.customerEmail || value.customerEmail === input.customerEmail) &&
      (!input.shippingAddress || Object.entries(input.shippingAddress).every(([field, fieldValue]) => value.shippingAddress?.[field] === fieldValue)) &&
      value.customLineItems.length === lines.length && byKey.size === lines.length && cents(value.totalPrice, plan.net) && lines.every((line, i) => { const actual = byKey.get(keys[i]); return actual?.quantity === line.quantity && cents(actual.totalPrice, plan.lineNet[i]); }));
  };
  if (!sourceMatches(cart)) throw new ToolError('price_mismatch', 'The source cart differs from the authoritative order lines, identity or net amount; no order was created.');
  const taxesMatch = (value: any) => sourceMatches(value) && cents(value?.taxedPrice?.totalNet, plan.net) && cents(value?.taxedPrice?.totalTax, plan.tax) && cents(value?.taxedPrice?.totalGross, plan.gross) &&
    lines.every((_, i) => { const row = value.customLineItems?.find((l: any) => l.key === keys[i]); return cents(row?.taxedPrice?.totalNet, plan.lineNet[i]) && cents(row?.taxedPrice?.totalGross, plan.lineNet[i] + plan.lineTax[i]); });
  if (!taxesMatch(cart)) {
    const taxRate = { name: input.taxName, amount: input.taxRate, country: input.taxCountry, includedInPrice: false };
    const actions: Rec[] = lines.map((_, i) => ({ action: 'setCustomLineItemTaxAmount', customLineItemKey: keys[i], externalTaxAmount: { totalGross: money(plan.lineNet[i] + plan.lineTax[i]), taxRate } }));
    actions.push({ action: 'setCartTotalTax', externalTotalGross: money(plan.gross), externalTaxPortions: [{ name: input.taxName, rate: input.taxRate, amount: money(plan.tax) }] });
    try { cart = await api('POST', `/carts/${encodeURIComponent(cart.id)}`, { body: { version: cart.version, actions } }); }
    catch (error) { const confirmed = await api('GET', `/carts/key=${key}`); if (!taxesMatch(confirmed)) throw error; cart = confirmed; }
  }
  if (!taxesMatch(cart)) throw new ToolError('price_mismatch', 'The commerce cart tax and total do not match the paid quote; no order was created.');
  return { cart, plan };
}
