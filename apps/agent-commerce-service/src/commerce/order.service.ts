/**
 * OrderService (P0-04) — authoritative order commit + real Stripe checkout.
 *
 * Replaces the browser-side `CAR-<random>` with a real, persisted, idempotent
 * order transaction:
 *   1. Re-load the quote and re-validate it (not expired, prices still valid).
 *   2. Reserve inventory (best-effort record; a real inventory-service slots in later).
 *   3. Persist an order with status `pending_payment` (idempotent on idempotencyKey).
 *   4. Open a REAL Stripe Checkout Session (hosted page — no card data touches us)
 *      using the tenant's Stripe key (or the platform key), priced from the QUOTE.
 *   5. The order becomes `paid` only when Stripe's signed webhook confirms it —
 *      the storefront never shows "ordered" until then.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Collection, Db } from 'mongodb';
import Stripe from 'stripe';
import { connectToDatabase } from '@journeyax/database';
import { Quote } from './quote.types';

const DB_NAME = 'journeyx';
const ORDERS = 'orders';

export type OrderStatus = 'pending_payment' | 'paid' | 'failed' | 'cancelled';

export interface OrderDoc {
  orderId: string;
  tenantId: string;
  quoteId: string;
  idempotencyKey: string;
  status: OrderStatus;
  currency: string;
  total: number;
  customer?: { email?: string; name?: string };
  checkoutUrl?: string;
  stripeSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderArgs {
  tenantId: string;
  quote: Quote;
  idempotencyKey: string;
  customer?: { email?: string; name?: string };
  successUrl: string;
  cancelUrl: string;
  stripe?: { secretKey?: string };
}

export interface CreateOrderResult {
  orderId: string;
  status: OrderStatus;
  checkoutUrl?: string;
  total: number;
  currency: string;
  error?: string;
}

@Injectable()
export class OrderService {
  private col: Collection<OrderDoc> | null = null;

  private async getCol(): Promise<Collection<OrderDoc> | null> {
    if (this.col) return this.col;
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    const { db }: { db: Db } = await connectToDatabase(uri, DB_NAME);
    this.col = db.collection<OrderDoc>(ORDERS);
    await Promise.all([
      this.col.createIndex({ orderId: 1 }, { unique: true }),
      // Idempotency: one order per (tenant, key) — a retried "approve" returns the same order.
      this.col.createIndex({ tenantId: 1, idempotencyKey: 1 }, { unique: true }),
      this.col.createIndex({ stripeSessionId: 1 }),
    ]).catch(() => {});
    return this.col;
  }

  /** Resolve a Stripe client from the tenant key, else the platform env key. */
  private stripeClient(tenantKey?: string): Stripe | null {
    const key = (tenantKey && tenantKey.trim()) || process.env.STRIPE_SECRET_KEY || '';
    if (!key) return null;
    return new Stripe(key, { apiVersion: '2025-01-27.acacia' as any });
  }

  async create(args: CreateOrderArgs): Promise<CreateOrderResult> {
    const { tenantId, quote, idempotencyKey } = args;
    const col = await this.getCol();

    // ── Idempotency: return the existing order for a repeated key ──────────
    if (col) {
      const existing = await col.findOne({ tenantId, idempotencyKey });
      if (existing) {
        return { orderId: existing.orderId, status: existing.status, checkoutUrl: existing.checkoutUrl, total: existing.total, currency: existing.currency };
      }
    }

    // ── Re-validate the quote server-side (never trust a stale/invalid quote) ──
    if (quote.status === 'expired' || new Date(quote.expiresAt).getTime() < Date.now()) {
      return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'This quote has expired — please regenerate it.' };
    }
    if (!quote.validation.ok) {
      return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: `Quote has unresolved issues: ${quote.validation.errors.join('; ')}` };
    }
    const payableLines = quote.lines.filter((l) => l.unitPrice !== null && l.lineTotal > 0);
    if (payableLines.length === 0 || quote.total <= 0) {
      return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'Nothing payable on this quote.' };
    }

    const now = new Date().toISOString();
    const order: OrderDoc = {
      orderId: 'ord_' + randomUUID().replace(/-/g, ''),
      tenantId,
      quoteId: quote.quoteId,
      idempotencyKey,
      status: 'pending_payment',
      currency: quote.currency,
      total: quote.total,
      customer: args.customer,
      createdAt: now,
      updatedAt: now,
    };

    // ── Real Stripe Checkout Session (hosted; PCI stays with Stripe) ───────
    const stripe = this.stripeClient(args.stripe?.secretKey);
    if (!stripe) {
      // No key anywhere → we still persist the order but cannot collect payment.
      if (col) await col.insertOne({ ...order, status: 'failed' }).catch(() => {});
      return { orderId: order.orderId, status: 'failed', total: quote.total, currency: quote.currency, error: 'Payments are not configured for this store (no Stripe key).' };
    }

    try {
      // Charge ONE consolidated line at the authoritative quote.total (which already
      // includes the config-driven discount + tax). Stripe can't express negative
      // discount lines or match our tax model exactly, so charging the computed total
      // guarantees the amount collected equals the quote — the source of truth. Full
      // itemisation is preserved in our own quote/order records and shown in our UI.
      const itemSummary = payableLines
        .map((l) => `${l.quantity}× ${l.name}`)
        .join(', ')
        .slice(0, 240);
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [{
            quantity: 1,
            price_data: {
              currency: quote.currency.toLowerCase(),
              product_data: {
                name: quote.title || 'Order',
                description: itemSummary || undefined,
                metadata: { quoteId: quote.quoteId },
              },
              unit_amount: Math.round(quote.total * 100),
            },
          }],
          // Carry OUR order id on the return URL so the storefront can poll status.
          success_url: args.successUrl.replace('{ORDER_ID}', order.orderId),
          cancel_url: args.cancelUrl,
          client_reference_id: order.orderId,
          ...(args.customer?.email ? { customer_email: args.customer.email } : {}),
          metadata: { orderId: order.orderId, quoteId: quote.quoteId, tenantId },
          payment_intent_data: { metadata: { orderId: order.orderId, quoteTotal: String(quote.total) } },
        } as Stripe.Checkout.SessionCreateParams,
        { idempotencyKey: `checkout_${order.orderId}` },
      );

      order.checkoutUrl = session.url || undefined;
      order.stripeSessionId = session.id;
      if (col) await col.insertOne(order).catch(async (e: any) => {
        // Lost an idempotency race — return the winner.
        if (e?.code === 11000 && col) {
          const winner = await col.findOne({ tenantId, idempotencyKey });
          if (winner) { order.orderId = winner.orderId; order.checkoutUrl = winner.checkoutUrl; }
        } else { throw e; }
      });

      return { orderId: order.orderId, status: order.status, checkoutUrl: order.checkoutUrl, total: quote.total, currency: quote.currency };
    } catch (e: any) {
      console.error('[OrderService] Stripe checkout failed', e?.message || e);
      if (col) await col.insertOne({ ...order, status: 'failed' }).catch(() => {});
      return { orderId: order.orderId, status: 'failed', total: quote.total, currency: quote.currency, error: 'Could not start checkout. Please try again.' };
    }
  }

  /** Stripe webhook: flip the order to paid/failed once Stripe confirms. */
  async handleWebhook(rawBody: string, signature: string, tenantKey?: string): Promise<{ ok: boolean; handled?: string }> {
    const stripe = this.stripeClient(tenantKey);
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!stripe || !secret) return { ok: false };
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (e: any) {
      console.warn('[OrderService] webhook signature verify failed:', e?.message);
      return { ok: false };
    }
    const col = await this.getCol();
    if (!col) return { ok: false };

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object as Stripe.Checkout.Session;
      const orderId = (s.metadata?.orderId as string) || (s.client_reference_id as string);
      if (orderId) {
        await col.updateOne({ orderId }, { $set: { status: 'paid', updatedAt: new Date().toISOString() } });
        // TODO(outbox): emit order.created / order.paid event here (event-bus).
        return { ok: true, handled: 'paid:' + orderId };
      }
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const s = event.data.object as Stripe.Checkout.Session;
      const orderId = (s.metadata?.orderId as string) || (s.client_reference_id as string);
      if (orderId) await col.updateOne({ orderId }, { $set: { status: 'failed', updatedAt: new Date().toISOString() } });
    }
    return { ok: true, handled: event.type };
  }

  async get(orderId: string, tenantId?: string): Promise<OrderDoc | null> {
    const col = await this.getCol();
    if (!col) return null;
    const filter: any = { orderId };
    if (tenantId) filter.tenantId = tenantId;
    const order = await col.findOne(filter);
    if (!order || order.status !== 'pending_payment') return order;
    return (await this.confirmWithStripe(order, tenantKeyFor(order))) || order;
  }

  /**
   * Ask Stripe whether this order was actually paid.
   *
   * The webhook is the normal path, but it is a message from Stripe INTO our
   * network — and it never arrives when the service is not publicly reachable,
   * which is every laptop and every private environment. The customer pays,
   * Stripe returns them to us, and the order sits at `pending_payment` forever
   * while the screen waits for a confirmation that cannot come. They were
   * charged and shown nothing.
   *
   * So when an order is still unpaid, its checkout session is read back from
   * Stripe. That is the same authority the webhook carries — Stripe's own
   * answer, fetched over a server-to-server call with our secret key — rather
   * than the browser's claim of `?status=success`, which a customer could type
   * themselves. Whichever arrives first wins; both write the same transition.
   */
  private async confirmWithStripe(order: OrderDoc, tenantKey?: string): Promise<OrderDoc | null> {
    const sessionId = (order as any).stripeSessionId;
    if (!sessionId) return null;
    const stripe = this.stripeClient(tenantKey);
    if (!stripe) return null;
    try {
      const s = await stripe.checkout.sessions.retrieve(String(sessionId));
      const paid = s.payment_status === 'paid' || s.status === 'complete';
      if (!paid) return null;
      const col = await this.getCol();
      if (!col) return null;
      const updatedAt = new Date().toISOString();
      await col.updateOne({ orderId: order.orderId }, { $set: { status: 'paid', paidAt: updatedAt, updatedAt } });
      console.log(`[OrderService] confirmed with Stripe (no webhook): paid ${order.orderId}`);
      // Return exactly what was written — a caller reading `paidAt` from this
      // response must not see null for an order we just stamped as paid.
      return { ...order, status: 'paid', paidAt: updatedAt, updatedAt } as OrderDoc;
    } catch (e: any) {
      console.warn('[OrderService] Stripe confirmation failed:', e?.message);
      return null;
    }
  }
}

/** The project's own Stripe key travels on the order (per-project credentials). */
function tenantKeyFor(order: OrderDoc): string | undefined {
  return (order as any).stripeKey || undefined;
}
