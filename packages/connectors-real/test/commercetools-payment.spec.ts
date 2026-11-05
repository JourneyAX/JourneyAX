import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { commerceOrderPayment } from '../src/connectors/commercetools-payment';
import { ToolError } from '../src/types';

function fixture() {
  let order: any = { id: 'order-a', orderNumber: 'jax-order-a', version: 1, paymentState: 'Paid', totalPrice: { currencyCode: 'NZD', centAmount: 1234 } };
  let payment: any; let creates = 0; let links = 0; let loseCreate = false; let failLink = false;
  const api = async (method: string, path: string, options?: any) => {
    if (method === 'GET' && path.startsWith('/orders/')) return structuredClone(order);
    if (method === 'GET' && path.startsWith('/payments/key=')) { if (!payment) throw new ToolError('not_found', 'No payment'); return structuredClone(payment); }
    if (method === 'POST' && path === '/payments') {
      assert.equal(payment, undefined, 'the adapter must look up the unique payment before creating'); creates++;
      payment = { ...options.body, id: 'payment-a', version: 1 };
      if (loseCreate) throw new Error('source response lost'); return structuredClone(payment);
    }
    if (method === 'POST' && path === '/orders/order-a') {
      assert.equal(options.body.version, order.version); links++;
      if (failLink) throw new Error('source temporarily unavailable');
      order = { ...order, version: order.version + 1, paymentInfo: { payments: [options.body.actions[0].payment] } };
      return structuredClone(order);
    }
    throw new Error('Unexpected source call');
  };
  const tools = commerceOrderPayment(api);
  const args = { orderNumber: 'jax-order-a', transactionId: 'pi_provider-a', amountMinor: 1234, currency: 'NZD', paymentInterface: 'stripe' };
  return { args, run: () => tools[1].run(args), read: () => tools[0].run(args), stats: () => ({ creates, links }), get order() { return order; }, get payment() { return payment; },
    loseCreate: () => { loseCreate = true; }, failLink: (value: boolean) => { failLink = value; } };
}

test('an actual PSP reference is recorded once and linked to exactly its order', async () => {
  const f = fixture(); assert.equal((await f.read()).record, null);
  const first: any = await f.run(); const again = await f.run();
  assert.deepEqual(first, again); assert.equal(first.record.linked, true); assert.equal(first.record.chargeSucceeded, true);
  assert.deepEqual(f.stats(), { creates: 1, links: 1 });
  assert.equal(f.payment.interfaceId, f.args.transactionId);
});

test('unpaid orders, mismatched amounts and currencies cannot gain a payment receipt', async () => {
  for (const change of [(f: any) => { f.order.paymentState = 'Pending'; }, (f: any) => { f.args.amountMinor++; }, (f: any) => { f.args.currency = 'USD'; }]) {
    const f = fixture(); change(f); await assert.rejects(f.run, /match/); assert.deepEqual(f.stats(), { creates: 0, links: 0 });
  }
});

test('a lost create response is recovered using the same source key without another payment', async () => {
  const f = fixture(); f.loseCreate(); assert.equal((await f.run() as any).record.linked, true); assert.deepEqual(f.stats(), { creates: 1, links: 1 });
});

test('an interrupted order link resumes with the existing payment and rejects altered receipts', async () => {
  const f = fixture(); f.failLink(true); await assert.rejects(f.run, /unavailable/);
  f.failLink(false); assert.equal((await f.run() as any).record.linked, true); assert.equal(f.stats().creates, 1);
  f.payment.transactions[0].state = 'Pending'; await assert.rejects(f.run, /differs/);
});

test('registered ownership is retained on a new payment and a conflicting payment cannot be linked', async () => {
  const f = fixture(); f.order.customerId = 'owned-customer'; f.failLink(true);
  await assert.rejects(f.run, /unavailable/); assert.equal(f.payment.customer.id, 'owned-customer');
  f.payment.customer.id = 'different-customer'; f.failLink(false);
  await assert.rejects(f.run, /different customer/); assert.equal(f.stats().links, 1, 'no second link mutation after finding a conflicting owner');
});
