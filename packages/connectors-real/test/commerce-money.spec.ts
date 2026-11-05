import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateCommerceMinor, commerceMinorAmount, commerceRateAmount, priceCommerceLines } from '@journeyax/shared-types';
import { commerceOrderMoney, preparePaidCommerceCart } from '../src/connectors/commercetools-money';
import { ToolError } from '../src/types';

test('currency precision and decimal half-up rules are shared by quote and delivery', () => {
  assert.equal(commerceMinorAmount(1.005, 'NZD'), 101);
  assert.equal(commerceMinorAmount(10.5, 'JPY'), 11);
  assert.equal(commerceMinorAmount(1.2345, 'KWD'), 1235);
  assert.equal(commerceRateAmount(335, 0.1), 34);
  assert.deepEqual(allocateCommerceMinor(2, [1, 1, 1]), [1, 1, 0]);
  assert.throws(() => commerceMinorAmount(Infinity, 'NZD'));
  assert.throws(() => allocateCommerceMinor(1, [0, 0]));
});

test('mixed quantities preserve every discount and tax minor unit across currencies', () => {
  for (const currency of ['NZD', 'JPY', 'KWD']) for (const discountRate of [0, 0.03, 0.17, 1]) {
    const lines: any[] = [{ sku: 'A', name: 'One', unitPrice: 1.005, quantity: 3, lineTotal: 999 }, { sku: 'B', name: 'Two', unitPrice: 0.22, quantity: 7, lineTotal: 999 }, { sku: 'C', name: 'Three', unitPrice: 42.13, quantity: 13, lineTotal: 999 }];
    const quote = priceCommerceLines(lines, { currency, discountRate, taxRate: 0.15 });
    const plan = commerceOrderMoney(lines, currency, quote.discount, quote.taxRate, quote.total);
    assert.equal(plan.lineNet.reduce((a, b) => a + b, 0), plan.net);
    assert.equal(plan.lineTax.reduce((a, b) => a + b, 0), plan.tax);
    assert.equal(plan.gross, commerceMinorAmount(quote.total, currency));
    assert.deepEqual(plan, commerceOrderMoney(lines, currency, quote.discount, quote.taxRate, quote.total));
  }
});

function source() {
  let cart: any; let lostCreate = false, lostTax = false; let creates = 0, taxWrites = 0;
  const clone = (v: any) => structuredClone(v);
  const api: any = async (method: string, path: string, request: any) => {
    if (method === 'GET') { if (!cart) throw new ToolError('not_found', 'No cart'); return clone(cart); }
    if (path === '/carts') {
      assert.equal(cart, undefined); creates++; const draft = request.body;
      const fraction = 10n ** 6n;
      const customLineItems = draft.customLineItems.map((row: any) => {
        const quantity = BigInt(row.quantity);
        const net = row.money.type === 'highPrecision' ? Number((BigInt(row.money.preciseAmount) * quantity * 2n + fraction) / (fraction * 2n)) : row.money.centAmount * row.quantity;
        return { ...row, id: row.key, totalPrice: { currencyCode: draft.currency, centAmount: net } };
      });
      cart = { ...draft, id: 'source-cart', cartState: 'Active', version: 1, customLineItems, totalPrice: { currencyCode: draft.currency, centAmount: customLineItems.reduce((n: number, l: any) => n + l.totalPrice.centAmount, 0) } };
      if (lostCreate) throw new Error('response lost after create'); return clone(cart);
    }
    assert.equal(path, '/carts/source-cart'); taxWrites++; assert.equal(request.body.version, cart.version);
    for (const action of request.body.actions) {
      if (action.action === 'setCustomLineItemTaxAmount') { const row = cart.customLineItems.find((l: any) => l.key === action.customLineItemKey); row.taxedPrice = { totalNet: clone(row.totalPrice), totalGross: action.externalTaxAmount.totalGross }; }
      else { assert.equal(action.action, 'setCartTotalTax'); cart.taxedPrice = { totalNet: clone(cart.totalPrice), totalTax: action.externalTaxPortions[0].amount, totalGross: action.externalTotalGross }; }
    }
    cart.version++; if (lostTax) throw new Error('response lost after tax commit'); return clone(cart);
  };
  return { api, stats: () => ({ creates, taxWrites }), get cart() { return cart; }, loseResponses() { lostCreate = true; lostTax = true; } };
}
const input = { orderNumber: 'owned-multi-line', currency: 'NZD', locale: 'en', discount: 0.01, taxRate: 0.15, taxName: 'Configured tax', taxCountry: 'NZ', expectedTotal: 3.46, lines: [{ sku: 'A', name: 'One', unitPrice: 1, quantity: 3 }, { sku: 'B', name: 'Two', unitPrice: 0.02, quantity: 1 }] };
test('a cent that cannot divide by quantity survives vendor pricing, tax and replay', async () => {
  const f = source(); const { cart, plan } = await preparePaidCommerceCart(f.api, input);
  assert.equal(cart.taxedPrice.totalGross.centAmount, 346); assert.deepEqual(plan.lineNet, [299, 2]);
  assert.equal(cart.customLineItems[0].money.type, 'highPrecision');
  await preparePaidCommerceCart(f.api, input); assert.deepEqual(f.stats(), { creates: 1, taxWrites: 1 });
});
test('lost cart/tax responses reconcile by the stable cart key, without creating a second cart', async () => {
  const f = source(); f.loseResponses(); await preparePaidCommerceCart(f.api, input);
  await preparePaidCommerceCart(f.api, input); assert.deepEqual(f.stats(), { creates: 1, taxWrites: 1 });
});
test('wrong totals, conflicting ownership and altered source net amounts cannot produce an order-ready cart', async () => {
  const f = source(); await assert.rejects(() => preparePaidCommerceCart(f.api, { ...input, expectedTotal: 3.47 }), /paid total/); assert.equal(f.stats().creates, 0);
  await preparePaidCommerceCart(f.api, input); f.cart.totalPrice.centAmount++;
  await assert.rejects(() => preparePaidCommerceCart(f.api, input), /source cart differs/);
  f.cart.totalPrice.centAmount--; f.cart.customerEmail = 'different@example.test';
  await assert.rejects(() => preparePaidCommerceCart(f.api, { ...input, customerEmail: 'owned@example.test' }), /source cart differs/);
});
test('tax update responses cannot swap the owner or quantities while preserving totals', async () => {
  for (const mutate of [(cart: any) => { cart.customerId = 'another-customer'; }, (cart: any) => { cart.customLineItems[0].quantity++; }]) {
    const f = source();
    const api: any = async (method: string, path: string, request: any) => { const result = await f.api(method, path, request); if (path === '/carts/source-cart') mutate(result); return result; };
    await assert.rejects(() => preparePaidCommerceCart(api, { ...input, customerId: 'owned-customer' }), /cart tax and total/);
  }
});
