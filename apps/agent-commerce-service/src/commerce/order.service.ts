/**
 * OrderService (P0-04) — authoritative order commit + real Stripe checkout.
 *
 * Replaces the browser-side `CAR-<random>` with a real, persisted, idempotent
 * order transaction:
 *   1. Re-load the quote and re-validate it (not expired, prices still valid).
 *   2. Reserve the current quote and persist its pending order transactionally.
 *      Inventory is not reserved by this service.
 *   4. Open a REAL Stripe Checkout Session (hosted page — no card data touches us)
 *      using the scoped test connection, priced from the quote.
 *   5. Provider confirmation commits order, quote and delivery outbox together.
 */
import { Injectable, Inject, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Collection, Db } from 'mongodb';
import Stripe from 'stripe';
import { EnvSecretResolver, type SecretResolver } from '@journeyax/capability-sdk';
import { connectToDatabase, CheckoutQuoteRepository } from '@journeyax/database';
import { Quote } from './quote.types';
import { validatePaidOrderItems } from '@journeyax/shared-types';
import { currencyMinorAmount, paymentMatchesOrder, sessionMatchesOrder } from './payment-receipt';
import { PublishedCheckoutCatalogueAuthority, type CheckoutCatalogueAuthority } from './checkout-catalogue-authority';
export { currencyMinorAmount, paymentMatchesOrder, sessionMatchesOrder } from './payment-receipt';

const ORDERS = 'orders';


export type OrderStatus = 'pending_payment' | 'paid' | 'failed' | 'cancelled';

export interface OrderDoc {
  orderId: string;
  tenantId: string;
  environmentId?: string;
  principalId?: string;
  quoteId: string;
  quoteVersion?: number;
  release?: { version: string; checksum: string };
  workspaceId?: string;
  paymentSecretRef?: string;
  idempotencyKey: string;
  status: OrderStatus;
  currency: string;
  total: number;
  customer?: { email?: string; name?: string };
  customerProfile?: { canonicalId: string; email: string; references: Record<string, Record<string, string>> };
  checkoutUrl?: string;
  stripeSessionId?: string;
  paymentMode?: 'test';
  paymentReceipt?: { provider: 'stripe'; mode: 'test'; transactionId: string; amountMinor: number; currency: string };
  externalPayment?: { system: string; paymentId: string; transactionId: string; at: string };
  /** Durable delivery marker: cleared only after the commerce system returns a receipt. */
  commerceSync?: { status: 'pending' | 'ready'; eventId: string };
  /** What was bought, as the quote priced it when the order was made (the order is the record of it, not the browser). */
  title?: string;
  symbol?: string;
  lines?: Array<{ sku: string; name: string; quantity: number; unitPrice: number | null; lineTotal: number; imageUrl?: string }>;
  subtotal?: number;
  discount?: number;
  tax?: number;
  taxRate?: number;
  /** Who is billed and where it goes, as the payment page collected them (set once the payment is confirmed). */
  billing?: OrderParty;
  shipping?: OrderParty;
  paidAt?: string;
  /** The same order recorded in the business's commerce system (commercetools), under the same number, once it is paid. */
  externalOrder?: { system: string; orderNumber: string; orderId: string; at: string };
  /** Why the last attempt to record it failed (empty when it worked), and when it was last tried. */
  mirrorError?: string;
  mirrorTriedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderParty {
  name?: string;
  email?: string;
  phone?: string;
  address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string };
}

export interface CreateOrderArgs {
  tenantId: string;
  environmentId: string;
  principalId: string;
  quote: Quote;
  idempotencyKey: string;
  customer?: { email?: string; name?: string };
  successUrl: string;
  cancelUrl: string;
  stripe?: { secretKey?: string; publishableKey?: string; secretRef?: string; publishableKeyRef?: string };
  /** Take the payment inside the storefront (Stripe's embedded form) instead of sending the customer to Stripe's own page. */
  embedded?: boolean;
  /** What the payment page asks for besides the card: a delivery address, and the countries it may be in. */
  collect?: { shipping?: boolean; countries?: string[] };
}

export interface CreateOrderResult {
  orderId: string;
  status: OrderStatus;
  checkoutUrl?: string;
  /** Embedded payment: what the storefront's payment form needs to open (the key is the public one). */
  clientSecret?: string;
  publishableKey?: string;
  total: number;
  currency: string;
  error?: string;
}

@Injectable()
export class OrderService {
  private col: Collection<OrderDoc> | null = null;
  constructor(@Optional() @Inject('COMMERCE_DATABASE') private readonly database?: () => Promise<any>,
    @Optional() @Inject('COMMERCE_SECRET_RESOLVER') private readonly secrets: SecretResolver = new EnvSecretResolver(),
    @Optional() @Inject('COMMERCE_CATALOGUE_AUTHORITY') private readonly catalogueAuthority: CheckoutCatalogueAuthority = new PublishedCheckoutCatalogueAuthority()) {}

  private async db(): Promise<any> {
    if (this.database) return this.database();
    if (!process.env.MONGODB_URI) throw new Error('Durable order storage is unavailable.');
    return (await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx')).db;
  }

  private async getCol(): Promise<Collection<OrderDoc> | null> {
    if (this.col) return this.col;
    if (!this.database && !process.env.MONGODB_URI) return null;
    const db: Db = await this.db();
    this.col = db.collection<OrderDoc>(ORDERS);
    await Promise.all([
      this.col.createIndex({ orderId: 1 }, { unique: true }),
      // Idempotency: one order per (tenant, key) — a retried "approve" returns the same order.
      this.col.createIndex({ tenantId: 1, environmentId: 1, principalId: 1, idempotencyKey: 1 }, { unique: true }),
      this.col.createIndex({ stripeSessionId: 1 }),
      this.col.createIndex({ tenantId: 1, environmentId: 1, principalId: 1, quoteId: 1, quoteVersion: 1 }, { unique: true, partialFilterExpression: { quoteVersion: { $type: 'number' } } }),
    ]);
    return this.col;
  }

  /** Resolve a test Stripe client only from the caller's scoped payment settings. */
  private stripeClient(tenantKey?: string): Stripe | null {
    const key = tenantKey?.trim() || '';
    // This V5 build is authorised for test payments only. A missing/live key cannot become an offline payment.
    if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) return null;
    // Embedded Checkout Page and the browser's Endive SDK share this contract.
    // Older API versions reject ui_mode=embedded_page before a form can mount.
    return new Stripe(key, { apiVersion: '2026-03-25.dahlia' as any });
  }

  async create(args: CreateOrderArgs): Promise<CreateOrderResult> {
    const { tenantId, quote, idempotencyKey } = args;
    if (!args.environmentId || !args.principalId || quote.environmentId !== args.environmentId || quote.principalId !== args.principalId) return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'Checkout requires the verified quote owner and environment.' };
    const scope = { tenantId, environmentId: args.environmentId, principalId: args.principalId };
    const col = await this.getCol();

    // ── Idempotency: return the existing order for a repeated key ──────────
    if (col) {
      const existing = await col.findOne({ ...scope, idempotencyKey }) || await col.findOne({ ...scope, quoteId: quote.quoteId, quoteVersion: quote.version });
      if (existing) {
        if (existing.quoteId !== quote.quoteId || (existing.quoteVersion !== undefined && existing.quoteVersion !== quote.version) || existing.total !== quote.total || existing.currency !== quote.currency) return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'Idempotency key belongs to a different checkout.' };
        const again: CreateOrderResult = { orderId: existing.orderId, status: existing.status, checkoutUrl: existing.checkoutUrl, total: existing.total, currency: existing.currency };
        if (existing.status === 'pending_payment' && existing.stripeSessionId) {
          const stripeAgain = this.stripeClient(args.stripe?.secretKey);
          if (stripeAgain) {
            try {
              const open = await stripeAgain.checkout.sessions.retrieve(existing.stripeSessionId);
              if (!sessionMatchesOrder(open, existing)) throw new Error('Mismatched session');
              if (paymentMatchesOrder(open, existing) || (open.status === 'expired' && open.payment_status === 'unpaid')) {
                const settled = await new CheckoutQuoteRepository(await this.db()).settle(existing, paymentMatchesOrder(open, existing) ? 'paid' : 'failed', partiesFromSession(open));
                return { ...again, status: settled.status as OrderStatus, ...(settled.status === 'failed' ? { error: 'This payment session ended. Update your cart to start a new checkout.' } : {}) };
              }
              if (open.status === 'open') {
                try { await this.catalogueAuthority.validate({ tenantId, environmentId: args.environmentId, quote }, await this.db()); }
                catch { return { ...again, checkoutUrl: undefined, error: 'The catalogue source record requires review before payment can continue. Please refresh the cart.' }; }
              }
              if (args.embedded && open.status === 'open' && open.client_secret) return { ...again, clientSecret: open.client_secret, publishableKey: args.stripe?.publishableKey };
              return { ...again, ...(open.status !== 'open' ? { error: 'Payment is processing. Please check this order before paying again.' } : {}) };
            } catch { return { ...again, error: 'Could not confirm this payment session. Please retry checking this order before paying again.' }; }
          }
          return { ...again, error: 'The scoped test payment connection is unavailable.' };
        }
        if (existing.status !== 'pending_payment') return { ...again, ...(['failed', 'cancelled'].includes(existing.status) ? { error: 'This payment session ended. Update your cart to start a new checkout.' } : {}) };
      }
    }

    // ── Re-validate the quote server-side (never trust a stale/invalid quote) ──
    if (quote.status !== 'draft' || new Date(quote.expiresAt).getTime() < Date.now()) {
      return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'This quote has expired — please regenerate it.' };
    }
    if (quote.tenantId !== tenantId || !Array.isArray(quote.lines) || !quote.validation?.ok || !Number.isFinite(Date.parse(quote.expiresAt))) {
      return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: `Quote has unresolved issues: ${quote.validation?.errors?.join('; ') || 'Invalid quote contract'}` };
    }
    try { validatePaidOrderItems(quote.lines); }
    catch (error: any) { return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: error.message }; }
    try { await this.catalogueAuthority.validate({ tenantId, environmentId: args.environmentId, quote }, await this.db()); }
    catch { return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'The catalogue source identity could not be confirmed. Review the cart before starting payment.' }; }
    const payableLines = quote.lines.filter((l) => l.unitPrice !== null && l.lineTotal > 0);
    if (payableLines.length !== quote.lines.length || payableLines.length === 0 || !Number.isFinite(quote.total) || quote.total <= 0 || !/^[A-Z]{3}$/.test(quote.currency) || payableLines.some(line => !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unitPrice) || line.unitPrice! <= 0 || !Number.isFinite(line.lineTotal))) {
      return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'Nothing payable on this quote.' };
    }
    let payableMinor: number;
    try { payableMinor = currencyMinorAmount(quote.total, quote.currency); }
    catch { return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'This quote cannot be charged with the configured currency precision.' }; }

    const now = new Date().toISOString();
    const registered = col ? await (await this.db()).collection('customer_profile_links').findOne({ ...scope, status: 'ready' }) : null;
    const order: OrderDoc = {
      orderId: (col ? (await col.findOne({ ...scope, idempotencyKey }))?.orderId : undefined) || 'ord_' + randomUUID().replace(/-/g, ''),
      ...scope,
      quoteId: quote.quoteId,
      quoteVersion: quote.version,
      ...(quote.release ? { release: { ...quote.release } } : {}),
      workspaceId: quote.workspaceId,
      ...(args.stripe?.secretRef ? { paymentSecretRef: args.stripe.secretRef } : {}),
      idempotencyKey,
      status: 'pending_payment',
      currency: quote.currency,
      total: quote.total,
      customer: args.customer,
      ...(registered?.canonicalId && typeof registered.email === 'string' ? { customerProfile: { canonicalId: registered.canonicalId, email: registered.email, references: registered.references } } : {}),
      title: quote.title,
      symbol: quote.symbol,
      lines: payableLines.map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, ...(l.imageUrl ? { imageUrl: l.imageUrl } : {}) })),
      subtotal: quote.subtotal,
      discount: quote.discount,
      tax: quote.tax,
      taxRate: quote.taxRate,
      createdAt: now,
      updatedAt: now,
    };

    // ── Real Stripe Checkout Session (hosted; PCI stays with Stripe) ───────
    const stripe = this.stripeClient(args.stripe?.secretKey);
    if (!stripe || !col) {
      return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: !stripe ? 'Test payment provider is not configured.' : 'Durable order storage is unavailable.' };
    }
    order.paymentMode = 'test';
    // Reserve the idempotency key BEFORE creating a payment session. Concurrent requests use the same order and Stripe key.
    try { Object.assign(order, await new CheckoutQuoteRepository(await this.db()).reserveOrder(quote, order)); }
    catch (error: any) {
      if (error?.code !== 11000) return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'The stored quote could not be reserved for checkout. Refresh your cart and try again.' };
      const winner = await col.findOne({ ...scope, idempotencyKey }) || await col.findOne({ ...scope, quoteId: quote.quoteId, quoteVersion: quote.version });
      if (!winner) return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'Order retry could not be resolved.' };
      if (winner.quoteId !== quote.quoteId || (winner.quoteVersion !== undefined && winner.quoteVersion !== quote.version) || winner.total !== quote.total || winner.currency !== quote.currency) return { orderId: '', status: 'failed', total: quote.total, currency: quote.currency, error: 'Idempotency key belongs to a different checkout.' };
      Object.assign(order, winner);
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
              unit_amount: payableMinor,
            },
          }],
          ...(args.embedded
            // Stripe owns the form; only payment methods that require a redirect use the approved return URL.
            ? { ui_mode: 'embedded_page', redirect_on_completion: 'if_required', return_url: args.successUrl.replace('{ORDER_ID}', order.orderId) }
            // Carry OUR order id on the return URL so the storefront can poll status.
            : { success_url: args.successUrl.replace('{ORDER_ID}', order.orderId), cancel_url: args.cancelUrl }),
          billing_address_collection: 'required',
          phone_number_collection: { enabled: true },
          ...(args.collect?.shipping && args.collect.countries && args.collect.countries.length > 0
            ? { shipping_address_collection: { allowed_countries: args.collect.countries } }
            : {}),
          client_reference_id: order.orderId,
          ...(args.customer?.email ? { customer_email: args.customer.email } : {}),
          metadata: { orderId: order.orderId, quoteId: quote.quoteId, quoteVersion: String(quote.version), ...scope },
          payment_intent_data: { metadata: { orderId: order.orderId, quoteTotal: String(quote.total) } },
        } as unknown as Stripe.Checkout.SessionCreateParams,
        { idempotencyKey: `checkout_${order.orderId}` },
      );

      order.checkoutUrl = session.url || undefined;
      order.stripeSessionId = session.id;
      const attached = await col.updateOne({ orderId: order.orderId, ...scope, idempotencyKey: order.idempotencyKey, status: 'pending_payment' }, { $set: { stripeSessionId: session.id, checkoutUrl: session.url || undefined, updatedAt: new Date().toISOString() } });
      if (attached.matchedCount !== 1) throw new Error('The payment session could not be attached to its reserved order.');

      return {
        orderId: order.orderId, status: order.status, checkoutUrl: order.checkoutUrl, total: quote.total, currency: quote.currency,
        ...(args.embedded && (session as any).client_secret ? { clientSecret: (session as any).client_secret as string, publishableKey: args.stripe?.publishableKey } : {}),
      };
    } catch (e: any) {
      console.error('[OrderService] Stripe checkout failed', e?.message || e);
      // A validation rejection definitively created no payment session. Unlock the
      // quote transactionally, but never apply this to timeouts, rate limits or
      // idempotency conflicts, whose remote outcome may still be uncertain.
      if (e?.type === 'StripeInvalidRequestError' && e?.statusCode === 400 && !order.stripeSessionId) {
        try { await new CheckoutQuoteRepository(await this.db()).rejectCheckout(order); }
        catch { /* Keep the reservation if another attempt changed it. */ }
      }
      // Keep the persisted pending order recoverable. A retry uses the same Stripe idempotency key.
      if (col) await col.updateOne({ orderId: order.orderId, tenantId, status: 'pending_payment' }, { $set: { updatedAt: new Date().toISOString() } }).catch(() => {});
      return { orderId: order.orderId, status: 'failed', total: quote.total, currency: quote.currency, error: 'Could not start checkout. Please try again.' };
    }
  }

  /** Stripe webhook: flip the order to paid/failed once Stripe confirms. */
  async handleWebhook(rawBody: string, signature: string, tenantKey?: string, tenantId?: string, webhook?: { environmentId: string; secret: string }): Promise<{ ok: boolean; handled?: string }> {
    const stripe = this.stripeClient(tenantKey);
    const secret = webhook?.secret || '';
    if (!stripe || !secret || !tenantId || !webhook?.environmentId) return { ok: false };
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
        const order = await col.findOne({ orderId, tenantId, environmentId: webhook.environmentId });
        if (!order || !paymentMatchesOrder(s, order)) return { ok: false };
        if (order.status === 'paid') return { ok: true, handled: 'paid:' + orderId };
        const settled = await new CheckoutQuoteRepository(await this.db()).settle(order, 'paid', partiesFromSession(s));
        return { ok: settled.status === 'paid', handled: 'paid:' + orderId };
      }
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const s = event.data.object as Stripe.Checkout.Session;
      const orderId = (s.metadata?.orderId as string) || (s.client_reference_id as string);
      if (orderId) {
        const order = await col.findOne({ orderId, tenantId, environmentId: webhook.environmentId });
        if (!order || !sessionMatchesOrder(s, order)) return { ok: false };
        // Failure events can arrive late: read the current provider state before unlocking.
        const latest = await stripe.checkout.sessions.retrieve(s.id);
        if (!sessionMatchesOrder(latest, order)) return { ok: false };
        if (paymentMatchesOrder(latest, order)) await new CheckoutQuoteRepository(await this.db()).settle(order, 'paid', partiesFromSession(latest));
        else if ((event.type === 'checkout.session.expired' && latest.status === 'expired' && latest.payment_status === 'unpaid') || (event.type === 'checkout.session.async_payment_failed' && latest.status === 'complete' && latest.payment_status === 'unpaid')) await new CheckoutQuoteRepository(await this.db()).settle(order, 'failed');
        else return { ok: false };
      }
    }
    return { ok: true, handled: event.type };
  }

  /** Internal routing hint only: the webhook signature is still verified before any mutation. */
  async webhookRelease(orderId: string, tenantId: string, environmentId: string) {
    const order = await (await this.getCol())?.findOne({ orderId, tenantId, environmentId });
    return order?.release;
  }

  async get(orderId: string, tenantId?: string, owner?: { environmentId: string; principalId: string }, tenantKey?: string): Promise<OrderDoc | null> {
    const col = await this.getCol();
    if (!col || !tenantId) return null;
    const filter: any = { orderId };
    if (tenantId) filter.tenantId = tenantId;
    if (owner) Object.assign(filter, { environmentId: owner.environmentId, principalId: owner.principalId });
    const order = await col.findOne(filter);
    if (!order || order.status !== 'pending_payment') return order;
    return (await this.confirmWithStripe(order, tenantKey)) || order;
  }

  /** Browser-independent recovery. A lease bounds provider reads; only the signed provider receipt can settle an order. */
  async reconcilePending(tenantId: string, environmentId: string, limit = 10): Promise<number> {
    if (!tenantId || !['dev', 'test', 'staging', 'production'].includes(environmentId)) throw new Error('Explicit payment recovery scope is required.');
    const col = await this.getCol(); if (!col) throw new Error('Durable payment recovery storage is unavailable.');
    let checked = 0;
    for (let index = 0; index < Math.min(Math.max(limit, 0), 10); index++) {
      const at = new Date(), token = randomUUID();
      const order = await col.findOneAndUpdate({ tenantId, environmentId, status: 'pending_payment', paymentMode: 'test', stripeSessionId: { $exists: true, $nin: [null, ''] }, paymentSecretRef: { $exists: true, $nin: [null, ''] }, $and: [
        { $or: [{ 'reconciliation.nextAt': { $exists: false } }, { 'reconciliation.nextAt': { $lte: at } }] },
        { $or: [{ 'reconciliation.leaseUntil': { $exists: false } }, { 'reconciliation.leaseUntil': { $lt: at } }] },
      ] } as any, { $set: { 'reconciliation.lease': token, 'reconciliation.leaseUntil': new Date(at.getTime() + 120_000) }, $inc: { 'reconciliation.attempts': 1 } } as any, { returnDocument: 'after', sort: { createdAt: 1 } });
      if (!order) break;
      const renew = setInterval(() => { void col.updateOne({ orderId: order.orderId, tenantId, environmentId, 'reconciliation.lease': token } as any, { $set: { 'reconciliation.leaseUntil': new Date(Date.now() + 120_000) } } as any).catch(() => {}); }, 30_000);
      try { await this.confirmWithStripe(order); checked++; }
      finally {
        clearInterval(renew);
        const attempts = (order as any).reconciliation?.attempts ?? 1;
        await col.updateOne({ orderId: order.orderId, tenantId, environmentId, 'reconciliation.lease': token } as any, { $set: { 'reconciliation.checkedAt': new Date(), 'reconciliation.nextAt': new Date(Date.now() + Math.min(900, 30 * 2 ** Math.min(5, attempts - 1)) * 1000) }, $unset: { 'reconciliation.lease': '', 'reconciliation.leaseUntil': '' } } as any);
      }
    }
    return checked;
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
    if (typeof sessionId !== 'string' || !sessionId) return null;
    let key = tenantKey;
    if (order.paymentSecretRef) {
      if (typeof order.paymentSecretRef !== 'string') return null;
      try { key = await this.secrets.resolve(order.paymentSecretRef, { tenantId: order.tenantId, environmentId: order.environmentId! }); }
      catch { return null; }
    }
    const stripe = this.stripeClient(key);
    if (!stripe) return null;
    try {
      const s = await stripe.checkout.sessions.retrieve(String(sessionId));
      if (!sessionMatchesOrder(s, order)) return null;
      if (paymentMatchesOrder(s, order)) return await new CheckoutQuoteRepository(await this.db()).settle(order, 'paid', partiesFromSession(s)) as OrderDoc;
      if (s.status === 'expired' && s.payment_status === 'unpaid') return await new CheckoutQuoteRepository(await this.db()).settle(order, 'failed') as OrderDoc;
      return null;
    } catch (e: any) {
      console.warn('[OrderService] Stripe confirmation failed:', e?.message);
      return null;
    }
  }

  /** Cancel only after Stripe confirms that the exact session can no longer be paid. */
  async cancel(orderId: string, tenantId: string, owner: { environmentId: string; principalId: string }): Promise<OrderDoc | null> {
    const col = await this.getCol();
    const order = col && await col.findOne({ orderId, tenantId, environmentId: owner.environmentId, principalId: owner.principalId });
    if (!order || order.status !== 'pending_payment') return order || null;
    if (!order.stripeSessionId || !order.paymentSecretRef) throw new Error('Payment state is uncertain. Retry opening checkout before cancelling.');
    const key = await this.secrets.resolve(order.paymentSecretRef, { tenantId, environmentId: owner.environmentId });
    const stripe = this.stripeClient(key);
    if (!stripe) throw new Error('The test payment connection is unavailable.');
    let receipt = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
    if (!sessionMatchesOrder(receipt, order)) throw new Error('The payment receipt does not match this order.');
    if (receipt.status === 'open') {
      try { receipt = await stripe.checkout.sessions.expire(receipt.id); }
      catch { receipt = await stripe.checkout.sessions.retrieve(receipt.id); }
    }
    if (paymentMatchesOrder(receipt, order)) return await new CheckoutQuoteRepository(await this.db()).settle(order, 'paid', partiesFromSession(receipt)) as OrderDoc;
    if (!sessionMatchesOrder(receipt, order) || receipt.status !== 'expired' || receipt.payment_status !== 'unpaid') throw new Error('Payment is processing and cannot safely be cancelled yet.');
    return await new CheckoutQuoteRepository(await this.db()).settle(order, 'cancelled') as OrderDoc;
  }
}

/** Who pays and where it goes, as Stripe's payment page collected them. Only what was collected is returned. */
function partiesFromSession(session: Stripe.Checkout.Session): { billing?: OrderParty; shipping?: OrderParty; paymentReceipt?: OrderDoc['paymentReceipt'] } {
  const s: any = session;
  const address = (raw: any): OrderParty['address'] | undefined => (raw && typeof raw === 'object'
    ? { line1: raw.line1 || undefined, line2: raw.line2 || undefined, city: raw.city || undefined, state: raw.state || undefined, postalCode: raw.postal_code || undefined, country: raw.country || undefined }
    : undefined);
  const details = s.customer_details;
  const shipping = s.shipping_details || s.collected_information?.shipping_details;
  return {
    ...(session.payment_status === 'paid' && session.livemode === false && session.payment_intent && session.amount_total != null && session.currency ? {
      paymentReceipt: { provider: 'stripe' as const, mode: 'test' as const, transactionId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id, amountMinor: session.amount_total, currency: session.currency.toUpperCase() },
    } : {}),
    ...(details ? { billing: { name: details.name || undefined, email: details.email || undefined, phone: details.phone || undefined, address: address(details.address) } } : {}),
    ...(shipping ? { shipping: { name: shipping.name || undefined, address: address(shipping.address) } } : {}),
  };
}
