import { createHash } from 'node:crypto';
import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_QUOTES } from '@journeyax/database';
import { catalogueCommerceLines, commerceItems, priceCommerceQuote } from './catalogue-commerce';
import type { CommerceQuote } from '@journeyax/shared-types';
import { getVerifiedBusinessPackMetadata } from '@journeyax/business-pack';

export interface TradeQuoteCreateInput {
  items?: any[]; tradeCategory?: string; projectDimensions?: string; currency?: string; accountNumber?: string; tradeDiscountPct?: number;
}
export interface TradeQuoteConnectorAdapter { createQuote(input: TradeQuoteCreateInput, ctx: ExecutionContext): Promise<any> }

/** The model supplies SKUs and quantities only. One catalogue mapping and one persisted quote contract lead all the way to checkout. */
export class TradeQuoteCreateHandler implements NativeCapabilityHandler {
  get reversibleDraft() { return !this.connectorAdapter; }
  constructor(private readonly connectorAdapter?: TradeQuoteConnectorAdapter, private readonly inMemoryQuotes?: Record<string, any>, private readonly inMemoryProducts?: any[], private readonly database?: () => Promise<any>) {}
  /** Price before opening a transaction; the caller decides which atomic write owns this snapshot. */
  async buildQuote(input: TradeQuoteCreateInput, ctx: ExecutionContext, cart?: { cartId: string; version: number }) {
    if (!ctx.principalId || !ctx.environmentId || !ctx.workspaceId || !ctx.idempotencyKey) throw new Error('A verified owner, environment, workspace and idempotency key are required.');
    const items = commerceItems(input.items);
    const db = this.database ? await this.database() : this.inMemoryProducts ? undefined : process.env.MONGODB_URI ? (await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx')).db : undefined;
    if (!db && !this.inMemoryProducts) throw new Error('Authoritative catalogue and durable quote storage are unavailable.');
    const lines = await catalogueCommerceLines(items, ctx, this.inMemoryProducts ?? db!);
    const priced = priceCommerceQuote(lines, ctx, input.currency);
    const inputHash = createHash('sha256').update(JSON.stringify({ items: items.map(item => [item.sku, item.quantity]), ...(cart ? { cart } : {}) })).digest('hex');
    const key = createHash('sha256').update(JSON.stringify([ctx.tenantId, ctx.environmentId, ctx.principalId, ctx.workspaceId, cart ? 'cart.update' : 'quote.create', ctx.idempotencyKey])).digest('hex');
    const at = new Date();
    const verified = getVerifiedBusinessPackMetadata(ctx.release);
    if (verified && (verified.tenantId !== ctx.tenantId || verified.environmentId !== ctx.environmentId)) throw new Error('The quote configuration belongs to another scope.');
    const quote: CommerceQuote & { inputHash: string } = { quoteId: `quo_${key}`, tenantId: ctx.tenantId, environmentId: ctx.environmentId, principalId: ctx.principalId, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, idempotencyKey: ctx.idempotencyKey, inputHash,
      ...(verified ? { release: { version: verified.version, checksum: verified.checksum } } : {}),
      ...(cart ? { cartId: cart.cartId, cartVersion: cart.version } : {}),
      version: 1, title: ctx.release?.extensions?.commerce?.quoteTitle ?? 'Quote', ...priced, status: 'draft', createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + 7 * 86400000).toISOString() };
    return { quote, record: { _id: key, ...quote }, db };
  }
  async execute(input: TradeQuoteCreateInput, ctx: ExecutionContext): Promise<any> {
    if (this.connectorAdapter) return this.connectorAdapter.createQuote(input, ctx);
    if (this.inMemoryQuotes) {
      const fixture = this.inMemoryQuotes[input.accountNumber ? `QUO-${input.accountNumber}` : 'QUO-TEST-FIXTURE'] ?? this.inMemoryQuotes.default;
      if (!fixture) throw new Error('The injected quote fixture is unavailable.');
      return fixture;
    }
    const { db, quote, record } = await this.buildQuote(input, ctx);
    if (db) {
      const collection = db.collection(COLLECTION_QUOTES);
      try { await collection.insertOne(record); }
      catch (error: any) {
        if (error?.code !== 11000) throw error;
        const existing = await collection.findOne({ _id: record._id as any, tenantId: ctx.tenantId, environmentId: ctx.environmentId, principalId: ctx.principalId });
        if (!existing || existing.inputHash !== quote.inputHash) throw new Error('Quote idempotency key conflicts with another request.');
        return existing;
      }
    }
    return quote;
  }
}
export const QuoteCreateHandler = TradeQuoteCreateHandler;
export type QuoteCreateInput = TradeQuoteCreateInput;
