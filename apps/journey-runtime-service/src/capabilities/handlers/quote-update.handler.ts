import { createHash } from 'node:crypto';
import type { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_QUOTES } from '@journeyax/database';
import { catalogueCommerceLines, commerceItems, commerceOwner, priceCommerceQuote } from './catalogue-commerce';
import { CartUpdateHandler } from './cart-update.handler';
import { getVerifiedBusinessPackMetadata } from '@journeyax/business-pack';

export interface QuoteUpdateInput {
  quoteId?: string;
  items?: unknown[];
  expectedVersion?: number;
  mode?: 'replace' | 'add';
}
export interface QuoteConnectorAdapter { updateQuote(input: QuoteUpdateInput, ctx: ExecutionContext): Promise<any> }

/** Updates are owner-scoped, reprice every line, and compare the previous revision before saving. */
export class QuoteUpdateHandler implements NativeCapabilityHandler {
  get reversibleDraft() { return !this.connectorAdapter; }
  constructor(private readonly connectorAdapter?: QuoteConnectorAdapter, private readonly inMemoryQuotes?: Map<string, any>, private readonly inMemoryProducts?: readonly unknown[], private readonly database?: () => Promise<any>) {}
  async execute(input: QuoteUpdateInput, ctx: ExecutionContext): Promise<any> {
    const owner = commerceOwner(ctx);
    if (!ctx.idempotencyKey || typeof input.quoteId !== 'string' || !input.quoteId.trim() || input.quoteId.length > 200) throw new Error('A quote and scoped idempotency key are required.');
    const requested = commerceItems(input.items);
    if (input.mode && !['replace', 'add'].includes(input.mode)) throw new Error('Unsupported quote update mode.');
    if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) throw new Error('Invalid quote version.');
    if (this.connectorAdapter) return this.connectorAdapter.updateQuote({ ...input, items: requested }, ctx);
    const db = this.database ? await this.database() : this.inMemoryQuotes ? undefined : process.env.MONGODB_URI ? (await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx')).db : undefined;
    if (!this.inMemoryQuotes && !db) throw new Error('Authoritative quote storage is unavailable.');
    const collection = db?.collection(COLLECTION_QUOTES);
    const existing = this.inMemoryQuotes ? this.inMemoryQuotes.get(input.quoteId) : await collection!.findOne({ ...owner, quoteId: input.quoteId });
    if (!existing || Object.entries(owner).some(([field, value]) => existing[field] !== value)) throw new Error('Quote is unavailable to this conversation.');
    const requestHash = createHash('sha256').update(JSON.stringify([requested, input.mode ?? 'replace', input.expectedVersion])).digest('hex');
    if (existing.lastMutation?.key === ctx.idempotencyKey) {
      if (existing.lastMutation.hash !== requestHash) throw new Error('Quote update idempotency key conflicts with another request.');
      const { _id, ...quote } = existing;
      return { quote, status: 'success', idempotentReplay: true };
    }
    if (!Number.isSafeInteger(existing.version) || existing.version < 1 || (input.expectedVersion !== undefined && input.expectedVersion !== existing.version)) throw new Error('Quote revision changed. Read it again before updating.');
    let items = requested;
    if (input.mode === 'add') {
      const merged = new Map(commerceItems(existing.lines).map(item => [item.sku, item.quantity]));
      for (const item of requested) merged.set(item.sku, (merged.get(item.sku) ?? 0) + item.quantity);
      items = commerceItems([...merged].map(([sku, quantity]) => ({ sku, quantity })));
    }
    if (existing.cartId) {
      if (!db || !Number.isSafeInteger(existing.cartVersion)) throw new Error('The authoritative cart revision is unavailable.');
      return new CartUpdateHandler(undefined, undefined, this.inMemoryProducts, async () => db).execute({ cartId: existing.cartId, expectedVersion: existing.cartVersion, items }, ctx);
    }
    if (existing.status !== 'draft' || existing.checkoutOrderId || !Number.isFinite(Date.parse(existing.expiresAt)) || Date.parse(existing.expiresAt) <= Date.now()) throw new Error('Only an unexpired draft quote outside checkout can be changed.');
    if (this.inMemoryQuotes && !this.inMemoryProducts) throw new Error('An isolated quote fixture requires an explicit catalogue.');
    const lines = await catalogueCommerceLines(items, ctx, this.inMemoryProducts ?? db!);
    const priced = priceCommerceQuote(lines, ctx, existing.currency);
    const verified = getVerifiedBusinessPackMetadata(ctx.release);
    if ((existing.release && !verified) || (verified && (verified.tenantId !== ctx.tenantId || verified.environmentId !== ctx.environmentId))) throw new Error('Quote editing requires verified configuration for this scope.');
    const updated = { ...existing, ...priced, ...(verified ? { release: { version: verified.version, checksum: verified.checksum } } : {}), version: existing.version + 1, updatedAt: new Date().toISOString(), lastMutation: { key: ctx.idempotencyKey, hash: requestHash } };
    if (this.inMemoryQuotes) {
      if (this.inMemoryQuotes.get(input.quoteId)?.version !== existing.version) throw new Error('Quote revision changed. Read it again before updating.');
      this.inMemoryQuotes.set(input.quoteId, structuredClone(updated));
    } else {
      const { _id, ...fields } = updated;
      const result = await collection!.updateOne({ ...owner, quoteId: input.quoteId, version: existing.version, status: 'draft', checkoutOrderId: { $exists: false } }, { $set: fields });
      if (result.modifiedCount !== 1) throw new Error('Quote revision changed. Read it again before updating.');
    }
    const { _id, ...quote } = updated;
    return { quote, status: 'success' };
  }
}
