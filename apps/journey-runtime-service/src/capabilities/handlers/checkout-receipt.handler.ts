import type { ExecutionContext, NativeCapabilityHandler } from '@journeyax/capability-sdk';
import { connectToDatabase } from '@journeyax/database';

/** The committed checkout receipt is conversation context, not a live fulfilment/ERP assertion. */
export class CheckoutReceiptHandler implements NativeCapabilityHandler {
  constructor(private readonly database?: () => Promise<any>) {}
  async execute(input: Record<string, unknown>, ctx: ExecutionContext) {
    if (!ctx.tenantId || !ctx.environmentId || !ctx.principalId || ctx.principalId === 'anonymous') throw new Error('A verified checkout owner is required.');
    if (typeof input.orderId !== 'string' || !/^ord_[a-f0-9]{32}$/.test(input.orderId)) throw new Error('The complete order reference is required.');
    const db = this.database ? await this.database() : process.env.MONGODB_URI ? (await connectToDatabase(process.env.MONGODB_URI, process.env.RUNTIME_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx')).db : undefined;
    if (!db) throw new Error('Checkout receipt storage is unavailable.');
    const owner = { tenantId: ctx.tenantId, environmentId: ctx.environmentId, principalId: ctx.principalId };
    const order = await db.collection('orders').findOne({ ...owner, orderId: input.orderId });
    if (!order) return { found: false };
    const quote = await db.collection('quotes').findOne({ ...owner, quoteId: order.quoteId, version: order.quoteVersion, checkoutOrderId: order.orderId });
    if (!quote || quote.total !== order.total || quote.currency !== order.currency || JSON.stringify(quote.release) !== JSON.stringify(order.release)) throw new Error('The saved order and checkout quote disagree.');
    if (order.status === 'paid' && (!order.stripeSessionId || !order.paidAt || quote.status !== 'ordered' || order.commerceSync?.eventId !== `commerce.order-paid:${ctx.tenantId}:${ctx.environmentId}:${order.orderId}`)) throw new Error('A committed payment receipt is unavailable.');
    const timestamp = (value: unknown): string | undefined => value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : undefined;
    return { found: true, receipt: {
      orderId: order.orderId, status: order.status, createdAt: timestamp(order.createdAt), paidAt: timestamp(order.paidAt),
      currency: order.currency, subtotal: order.subtotal, discount: order.discount, tax: order.tax, taxRate: order.taxRate, taxPercent: Number.isFinite(order.taxRate) ? order.taxRate * 100 : undefined, total: order.total,
      lines: (order.lines ?? []).map((line: any) => ({ sku: line.sku, title: line.name, quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal })),
      commerceDelivery: { status: order.commerceSync?.status ?? 'not_ready', ...(order.externalOrder?.orderNumber ? { system: order.externalOrder.system, orderNumber: order.externalOrder.orderNumber } : {}) },
      authority: 'committed_checkout_receipt', liveFulfilmentVerified: false,
    } };
  }
}
