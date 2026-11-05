import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { currencyMinorAmount, paymentMatchesOrder, OrderService } from '../src/commerce/order.service';
const suite = createSuite('commerce payment receipts');
const order: any = { orderId: 'order-1', tenantId: 'tenant-a', quoteId: 'quote-1', stripeSessionId: 'session-1', total: 123.45, currency: 'NZD', status: 'pending_payment' };
const receipt: any = { id: 'session-1', payment_status: 'paid', status: 'complete', livemode: false, amount_total: 12345, currency: 'nzd', metadata: { orderId: 'order-1', quoteId: 'quote-1', tenantId: 'tenant-a' } };
async function main() {
  await suite.test('paid requires a matching test-mode receipt, not completed UI', () => {
    assert.equal(paymentMatchesOrder(receipt, order), true);
    for (const patch of [{ payment_status: 'unpaid' }, { amount_total: 12344 }, { currency: 'usd' }, { id: 'another-session' }, { livemode: true }, { metadata: { ...receipt.metadata, tenantId: 'tenant-b' } }, { metadata: { ...receipt.metadata, quoteId: 'another-quote' } }]) assert.equal(paymentMatchesOrder({ ...receipt, ...patch }, order), false, JSON.stringify(patch));
  });
  await suite.test('currency minor units preserve provider precision and refuse silent rounding', () => {
    assert.equal(currencyMinorAmount(12.34, 'NZD'), 1234);
    assert.equal(currencyMinorAmount(500, 'JPY'), 500);
    assert.equal(currencyMinorAmount(500, 'MGA'), 500);
    assert.equal(currencyMinorAmount(5, 'ISK'), 500);
    assert.equal(currencyMinorAmount(5, 'UGX'), 500);
    for (const [amount, currency] of [[1.234, 'NZD'], [1.5, 'JPY'], [1.5, 'ISK'], [-1, 'NZD'], [NaN, 'NZD']] as const) assert.throws(() => currencyMinorAmount(amount, currency));
  });
  await suite.test('a completed session awaiting asynchronous payment stays pending', async () => {
    let writes = 0;
    const orders = new OrderService();
    (orders as any).getCol = async () => ({ findOne: async () => order, updateOne: async () => { writes++; } });
    (orders as any).stripeClient = () => ({ checkout: { sessions: { retrieve: async () => ({ ...receipt, payment_status: 'unpaid' }) } } });
    assert.equal((await orders.get(order.orderId, order.tenantId))?.status, 'pending_payment');
    assert.equal(writes, 0);
    assert.equal(await orders.get(order.orderId), null, 'unscoped public order reads are refused');
  });
  await suite.test('a signed completion event with mismatched amount cannot pay an order', async () => {
    const previous = process.env.STRIPE_WEBHOOK_SECRET; process.env.STRIPE_WEBHOOK_SECRET = 'fixture-only-webhook';
    let writes = 0;
    const orders = new OrderService();
    (orders as any).getCol = async () => ({ findOne: async () => order, updateOne: async () => { writes++; } });
    (orders as any).stripeClient = () => ({ webhooks: { constructEvent: () => ({ id: 'evt-1', type: 'checkout.session.completed', data: { object: { ...receipt, amount_total: 1 } } }) } });
    try { assert.equal((await orders.handleWebhook('{}', 'fixture', undefined, 'tenant-a', { environmentId: 'test', secret: 'whsec_fixture' })).ok, false); assert.equal(writes, 0); }
    finally { if (previous === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = previous; }
  });
  suite.finish();
}
main().catch(error => { console.error(error); process.exit(1); });
