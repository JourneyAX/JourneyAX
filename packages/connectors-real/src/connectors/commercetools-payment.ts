import { ToolError, type Rec, type ToolSpec } from '../types';
import { createHash } from 'node:crypto';

type Api = (method: string, path: string, request?: { body?: unknown; query?: Rec }) => Promise<Rec>;
const keyOf = (orderNumber: string, transactionId: string) => `jax_${createHash('sha256').update(JSON.stringify([orderNumber, transactionId])).digest('hex')}`;

/** Records an already confirmed PSP transaction. This adapter never charges a card. */
export function commerceOrderPayment(api: Api): ToolSpec[] {
  const read = async (orderNumber: string, transactionId: string) => {
    const order = await api('GET', `/orders/order-number=${encodeURIComponent(orderNumber)}`);
    let payment: any;
    try { payment = await api('GET', `/payments/key=${keyOf(orderNumber, transactionId)}`); }
    catch (error) { if (!(error instanceof ToolError && error.code === 'not_found')) throw error; }
    return { order, payment };
  };
  const record = (order: any, payment: any) => ({ orderId: order.id, orderNumber: order.orderNumber, paymentId: payment.id,
    transactionId: payment.interfaceId, currency: payment.amountPlanned?.currencyCode, amountMinor: payment.amountPlanned?.centAmount,
    linked: order.paymentInfo?.payments?.some((p: any) => p.id === payment.id) === true,
    chargeSucceeded: payment.transactions?.some((t: any) => t.type === 'Charge' && t.state === 'Success' && t.interactionId === payment.interfaceId && t.amount?.centAmount === payment.amountPlanned?.centAmount && t.amount?.currencyCode === payment.amountPlanned?.currencyCode) === true });
  const properties = { orderNumber: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$', maxLength: 64 }, transactionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,200}$', maxLength: 200 } };
  return [{
    name: 'get_order_payment_receipt', readOnly: true,
    description: 'Read the exact external payment reference linked to one commerce order. Never returns payment credentials.',
    inputSchema: { type: 'object', required: ['orderNumber', 'transactionId'], properties },
    async run(args) { const found = await read(String(args.orderNumber), String(args.transactionId)); return { record: found.payment ? record(found.order, found.payment) : null }; },
  }, {
    name: 'record_order_payment', readOnly: false, requiresPaymentReceipt: true,
    description: 'Link an independently confirmed provider transaction to its exact paid commerce order. Records a receipt only; never creates a charge.',
    inputSchema: { type: 'object', required: ['orderNumber', 'transactionId', 'amountMinor', 'currency', 'paymentInterface'], properties: {
      ...properties, amountMinor: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, currency: { type: 'string', pattern: '^[A-Z]{3}$' }, paymentInterface: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' },
    } },
    async run(args) {
      if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor < 1 || !/^[A-Z]{3}$/.test(String(args.currency))) throw new ToolError('invalid_arguments', 'A confirmed monetary receipt is required.');
      let { order, payment } = await read(String(args.orderNumber), String(args.transactionId));
      const gross = order.taxedPrice?.totalGross ?? order.totalPrice;
      if (order.paymentState !== 'Paid' || gross?.centAmount !== args.amountMinor || gross?.currencyCode !== args.currency) throw new ToolError('receipt_mismatch', 'The provider amount and currency do not match the paid order.');
      if (order.customerId && payment?.customer?.id && order.customerId !== payment.customer.id) throw new ToolError('identity_conflict', 'The stored payment belongs to a different customer from the order.');
      const matches = (p: any) => p.interfaceId === args.transactionId && p.paymentMethodInfo?.paymentInterface === args.paymentInterface && p.amountPlanned?.centAmount === args.amountMinor && p.amountPlanned?.currencyCode === args.currency && record(order, p).chargeSucceeded;
      if (!payment) {
        const amount = { currencyCode: args.currency, centAmount: args.amountMinor };
        try { payment = await api('POST', '/payments', { body: { key: keyOf(String(args.orderNumber), String(args.transactionId)), interfaceId: args.transactionId, amountPlanned: amount, ...(order.customerId ? { customer: { typeId: 'customer', id: order.customerId } } : {}),
          paymentMethodInfo: { paymentInterface: args.paymentInterface }, transactions: [{ type: 'Charge', amount, state: 'Success', interactionId: args.transactionId }] } }); }
        catch (error) {
          // A concurrent create or lost response is resolved by the unique stable key.
          const found = await read(String(args.orderNumber), String(args.transactionId));
          if (!found.payment) throw error; payment = found.payment; order = found.order;
        }
      }
      if (!matches(payment)) throw new ToolError('receipt_mismatch', 'The stored commerce payment differs from the confirmed provider receipt.');
      if (!record(order, payment).linked) {
        try { order = await api('POST', `/orders/${order.id}`, { body: { version: order.version, actions: [{ action: 'addPayment', payment: { typeId: 'payment', id: payment.id } }] } }); }
        catch (error) {
          const found = await read(String(args.orderNumber), String(args.transactionId));
          if (!found.payment || !matches(found.payment) || !record(found.order, found.payment).linked) throw error;
          order = found.order; payment = found.payment;
        }
      }
      const result = record(order, payment);
      if (!result.linked || !result.chargeSucceeded) throw new ToolError('receipt_mismatch', 'The source did not confirm the linked payment.');
      return { record: result };
    },
  }];
}
