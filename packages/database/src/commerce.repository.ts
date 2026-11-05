import type { ClientSession } from 'mongodb';
import type { CommerceQuote } from '@journeyax/shared-types';
import { OutboxRepository } from './outbox';

export interface CommerceOwner {
  tenantId: string; environmentId: string; principalId: string; workspaceId: string;
}

/** No memory fallback: snapshot and pointer must commit or roll back together. */
export async function commerceTransaction<T>(db: any, work: (session: ClientSession) => Promise<T>): Promise<T> {
  if (!db?.client?.startSession) throw new Error('Transactional commerce storage is unavailable.');
  const session = db.client.startSession();
  try {
    return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }) as T;
  } finally { await session.endSession(); }
}

/** Existing quotes and customer_carts collections remain the only cart/price authorities. */
export class CartQuoteRepository {
  constructor(private readonly db: any) {}

  async commit(input: { key: string; cartId: string; owner: CommerceOwner; expectedVersion: number; idempotencyKey: string; inputHash: string; quote?: CommerceQuote & { _id?: string } }): Promise<any> {
    return commerceTransaction(this.db, async session => {
      const carts = this.db.collection('customer_carts');
      const quotes = this.db.collection('quotes');
      const filter = { _id: input.key, ...input.owner };
      const existing = await carts.findOne(filter, { session });
      const version = existing?.version ?? 0;
      if (existing?.lastMutation?.key === input.idempotencyKey) {
        if (existing.lastMutation.inputHash !== input.inputHash) throw new Error('Cart idempotency key conflicts with another request.');
        return existing;
      }
      if (version !== input.expectedVersion) throw new Error('Cart revision changed. Read it again before updating.');
      if (existing?.quoteId) {
        const previous = await quotes.findOne({ quoteId: existing.quoteId, ...input.owner }, { session });
        if (!previous) throw new Error('The cart price snapshot is unavailable.');
        if (previous.checkoutOrderId && previous.status !== 'ordered') throw new Error('Checkout is already in progress. Finish or cancel it before changing this cart.');
        if (previous.status === 'draft') {
          const expired = await quotes.updateOne({ quoteId: previous.quoteId, ...input.owner, version: previous.version, status: 'draft', checkoutOrderId: { $exists: false } }, { $set: { status: 'expired', supersededAt: new Date().toISOString() } }, { session });
          if (expired.modifiedCount !== 1) throw new Error('Quote revision changed. Read it again before updating.');
        }
      }
      const next = { cartId: input.cartId, ...input.owner, version: version + 1,
        ...(input.quote ? { quoteId: input.quote.quoteId } : {}),
        lastMutation: { key: input.idempotencyKey, inputHash: input.inputHash }, updatedAt: new Date().toISOString() };
      if (input.quote) {
        if (input.quote.cartId !== input.cartId || input.quote.cartVersion !== next.version) throw new Error('The cart quote revision does not match its pointer.');
        await quotes.insertOne({ ...input.quote }, { session });
      }
      if (existing) {
        const saved = await carts.replaceOne({ ...filter, version }, { _id: input.key, ...next }, { session });
        if (saved.modifiedCount !== 1) throw new Error('Cart revision changed. Read it again before updating.');
      } else await carts.insertOne({ _id: input.key, ...next }, { session });
      return next;
    });
  }
}

export class CheckoutQuoteRepository {
  constructor(private readonly db: any) {}
  /** Reserve the stored revision before Stripe is contacted; cart edits contend on the same quote row. */
  async reserveOrder<T extends { orderId: string; tenantId: string; environmentId?: string; principalId?: string; quoteId: string; quoteVersion?: number; idempotencyKey: string; currency: string; total: number }>(quote: CommerceQuote, order: T): Promise<T> {
    if (!order.environmentId || !order.principalId) throw new Error('A verified checkout owner is required.');
    const owner = { tenantId: order.tenantId, environmentId: order.environmentId, principalId: order.principalId };
    return commerceTransaction(this.db, async session => {
      const orders = this.db.collection('orders'); const quotes = this.db.collection('quotes');
      const prior = await orders.findOne({ ...owner, idempotencyKey: order.idempotencyKey }, { session }) ?? await orders.findOne({ ...owner, quoteId: quote.quoteId, quoteVersion: quote.version }, { session });
      if (prior) {
        if (prior.quoteId !== quote.quoteId || prior.quoteVersion !== quote.version || prior.total !== quote.total || prior.currency !== quote.currency) throw new Error('Idempotency key belongs to a different checkout.');
        return prior;
      }
      const saved = await quotes.findOne({ ...owner, quoteId: quote.quoteId }, { session });
      if (!saved || saved.version !== quote.version || saved.status !== 'draft' || saved.checkoutOrderId || !saved.validation?.ok || !Number.isFinite(Date.parse(saved.expiresAt)) || Date.parse(saved.expiresAt) <= Date.now()) throw new Error('The stored quote changed or is no longer payable. Read it again before checkout.');
      if (JSON.stringify(saved.release) !== JSON.stringify(quote.release) || JSON.stringify(saved.release) !== JSON.stringify((order as any).release)) throw new Error('Checkout does not match the quote configuration.');
      for (const key of ['currency', 'subtotal', 'discountRate', 'discount', 'taxRate', 'tax', 'total'] as const) if (saved[key] !== quote[key]) throw new Error('Checkout does not match the stored quote.');
      const lines = (value: CommerceQuote) => value.lines.map(line => [line.sku, line.quantity, line.unitPrice, line.lineTotal]);
      if (JSON.stringify(lines(saved)) !== JSON.stringify(lines(quote))) throw new Error('Checkout lines do not match the stored quote.');
      if (saved.cartId) {
        const pointer = await this.db.collection('customer_carts').findOne({ ...owner, workspaceId: saved.workspaceId, cartId: saved.cartId }, { session });
        if (!pointer || pointer.quoteId !== saved.quoteId || pointer.version !== saved.cartVersion) throw new Error('This cart quote has been replaced. Open the current cart before checkout.');
      }
      const locked = await quotes.updateOne({ ...owner, quoteId: saved.quoteId, version: saved.version, status: 'draft', checkoutOrderId: { $exists: false } }, { $set: { checkoutOrderId: order.orderId } }, { session });
      if (locked.modifiedCount !== 1) throw new Error('The quote changed while checkout was opening.');
      await orders.insertOne({ ...order }, { session });
      return order;
    });
  }

  /** Release only a session-less reservation after a definitive provider validation rejection.
   * Network failures and timeouts must keep their reservation: a session may exist.
   */
  async rejectCheckout(expected: { orderId: string; tenantId: string; environmentId?: string; principalId?: string; quoteId: string; quoteVersion?: number; total: number; currency: string }): Promise<void> {
    if (!expected.environmentId || !expected.principalId || !Number.isSafeInteger(expected.quoteVersion)) throw new Error('A scoped checkout reservation is required.');
    const owner = { tenantId: expected.tenantId, environmentId: expected.environmentId, principalId: expected.principalId };
    await commerceTransaction(this.db, async session => {
      const orders = this.db.collection('orders');
      const filter = { ...owner, orderId: expected.orderId, quoteId: expected.quoteId, quoteVersion: expected.quoteVersion, total: expected.total, currency: expected.currency };
      const order = await orders.findOne(filter, { session });
      if (!order || order.stripeSessionId) throw new Error('A provider session may already exist; reconciliation is required.');
      if (order.status === 'failed') return;
      if (order.status !== 'pending_payment') throw new Error('The checkout is no longer pending.');
      const unlocked = await this.db.collection('quotes').updateOne({ ...owner, quoteId: expected.quoteId, version: expected.quoteVersion, status: 'draft', checkoutOrderId: expected.orderId }, { $unset: { checkoutOrderId: '' } }, { session });
      if (unlocked.modifiedCount !== 1) throw new Error('The checkout reservation changed.');
      const saved = await orders.updateOne({ ...filter, status: 'pending_payment', stripeSessionId: { $exists: false } }, { $set: { status: 'failed', updatedAt: new Date().toISOString(), failureReason: 'provider_validation_rejected' } }, { session });
      if (saved.modifiedCount !== 1) throw new Error('The checkout changed while releasing its reservation.');
    });
  }

  /** A provider-confirmed outcome and its delivery event share one commit boundary. */
  async settle<T extends { orderId: string; tenantId: string; environmentId?: string; principalId?: string; quoteId: string; quoteVersion?: number; stripeSessionId?: string; total: number; currency: string }>(
    expected: T, outcome: 'paid' | 'failed' | 'cancelled', details: { billing?: unknown; shipping?: unknown; paymentReceipt?: unknown } = {},
  ): Promise<T & { status: string }> {
    if (!expected.environmentId || !expected.principalId || !expected.stripeSessionId || !Number.isSafeInteger(expected.quoteVersion)) throw new Error('A scoped payment reservation is required.');
    const owner = { tenantId: expected.tenantId, environmentId: expected.environmentId, principalId: expected.principalId };
    return commerceTransaction(this.db, async session => {
      const orders = this.db.collection('orders'); const quotes = this.db.collection('quotes');
      const filter = { ...owner, orderId: expected.orderId, stripeSessionId: expected.stripeSessionId };
      const order = await orders.findOne(filter, { session });
      if (!order || order.quoteId !== expected.quoteId || order.quoteVersion !== expected.quoteVersion || order.total !== expected.total || order.currency !== expected.currency) throw new Error('The payment reservation changed.');
      // Paid is terminal. A late failure must never release a paid quote.
      if (order.status === 'paid' || order.status === outcome) return order;
      if (order.status !== 'pending_payment') throw new Error('The payment outcome conflicts with a terminal order; reconciliation is required.');
      const quoteFilter = { ...owner, quoteId: order.quoteId, version: order.quoteVersion, status: 'draft', checkoutOrderId: order.orderId };
      const at = new Date().toISOString();
      const quote = await quotes.updateOne(quoteFilter, outcome === 'paid' ? { $set: { status: 'ordered' } } : { $unset: { checkoutOrderId: '' } }, { session });
      if (quote.modifiedCount !== 1) throw new Error('The payment quote reservation is unavailable; reconciliation is required.');
      const eventId = `commerce.order-paid:${owner.tenantId}:${owner.environmentId}:${order.orderId}`;
      const patch = { status: outcome, updatedAt: at, ...(outcome === 'paid' ? { paidAt: at, ...details, commerceSync: { status: 'pending', eventId } } : {}) };
      const saved = await orders.updateOne({ ...filter, status: 'pending_payment' }, { $set: patch }, { session });
      if (saved.modifiedCount !== 1) throw new Error('The payment changed while it was being confirmed.');
      if (outcome === 'paid') await new OutboxRepository(this.db).enqueue({
        ...owner, environmentId: owner.environmentId as any, eventId, eventType: 'commerce.order_paid',
        workspaceId: order.workspaceId, packVersionId: order.release?.version,
        payload: { orderId: order.orderId },
      }, session);
      return { ...order, ...patch };
    });
  }
}
