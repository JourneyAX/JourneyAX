import type { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_QUOTES, CartQuoteRepository } from '@journeyax/database';
import { commerceItems, commerceOwner, scopedCommerceId } from './catalogue-commerce';
import { TradeQuoteCreateHandler } from './trade-quote-create.handler';
import { createHash } from 'node:crypto';

export interface CartUpdateInput { items?: unknown[]; cartId?: string; expectedVersion?: number }
export interface CartConnectorAdapter { updateCart(input: CartUpdateInput, ctx: ExecutionContext): Promise<any> }

export class CartUpdateHandler implements NativeCapabilityHandler {
  get reversibleDraft() { return !this.connectorAdapter; }
  constructor(private readonly connectorAdapter?: CartConnectorAdapter, private readonly inMemoryCarts?: Map<string, any>, private readonly inMemoryProducts?: readonly unknown[], private readonly database?: () => Promise<any>) {}

  private id(input: { cartId?: string }, ctx: ExecutionContext) {
    commerceOwner(ctx);
    const cartId = input.cartId ?? `cart-${ctx.workspaceId}`;
    if (typeof cartId !== 'string' || !cartId.trim() || cartId.length > 200 || /[\u0000-\u001f\u007f]/.test(cartId)) throw new Error('A bounded cart identifier is required.');
    return { cartId, key: scopedCommerceId(ctx, cartId) };
  }
  private async db() {
    if (this.database) return this.database();
    if (!process.env.MONGODB_URI) throw new Error('Authoritative cart storage is unavailable.');
    return (await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx')).db;
  }

  private cart(pointer: any, quote: any) {
    return { cartId: pointer.cartId, ...Object.fromEntries(['tenantId', 'environmentId', 'principalId', 'workspaceId'].map(key => [key, pointer[key]])), version: pointer.version, items: quote?.lines ?? [], totalItems: (quote?.lines ?? []).reduce((sum: number, line: any) => sum + line.quantity, 0), subtotal: quote?.subtotal ?? 0, ...(quote?.currency ? { currency: quote.currency } : {}), pricesComplete: !!quote && quote.lines.every((line: any) => line.unitPrice !== null), status: quote?.lines?.length ? 'active' : 'empty', quoteId: quote?.quoteId, updatedAt: pointer.updatedAt };
  }

  async read(input: { cartId?: string }, ctx: ExecutionContext): Promise<{ cart: any; quote?: any } | null> {
    const { key } = this.id(input, ctx);
    const db = this.inMemoryCarts ? undefined : await this.db();
    const pointer = this.inMemoryCarts ? this.inMemoryCarts.get(key) : await db!.collection('customer_carts').findOne({ _id: key as any, ...commerceOwner(ctx) });
    if (!pointer) return null;
    if (Object.entries(commerceOwner(ctx)).some(([field, value]) => pointer[field] !== value)) throw new Error('Cart owner does not match this conversation.');
    let quote = pointer.quoteId ? (this.inMemoryCarts ? pointer.quote : await db!.collection(COLLECTION_QUOTES).findOne({ quoteId: pointer.quoteId, ...commerceOwner(ctx) })) : undefined;
    if (pointer.quoteId && !quote) throw new Error('The cart price snapshot is unavailable.');
    if (quote?.status === 'ordered') quote = undefined;
    const { _id, ...publicQuote } = quote ?? {};
    return { cart: this.cart(pointer, quote), ...(quote ? { quote: { ...publicQuote, cartId: pointer.cartId, cartVersion: pointer.version } } : {}) };
  }

  async get(input: { cartId?: string }, ctx: ExecutionContext): Promise<any | null> {
    return (await this.read(input, ctx))?.cart ?? null;
  }

  async execute(input: CartUpdateInput, ctx: ExecutionContext): Promise<any> {
    const { cartId, key } = this.id(input, ctx);
    const owner = commerceOwner(ctx);
    const items = commerceItems(input.items, true);
    if (!ctx.idempotencyKey) throw new Error('A cart mutation requires an idempotency key.');
    if (this.connectorAdapter) return this.connectorAdapter.updateCart({ cartId, items, expectedVersion: input.expectedVersion }, ctx);
    if (this.inMemoryCarts && !this.inMemoryProducts) throw new Error('The isolated cart fixture requires an explicit catalogue.');
    const db = this.inMemoryCarts ? undefined : await this.db();
    const collection = db?.collection('customer_carts');
    const existing = this.inMemoryCarts ? this.inMemoryCarts.get(key) : await collection!.findOne({ _id: key as any, ...owner });
    const inputHash = createHash('sha256').update(JSON.stringify({ items, expectedVersion: input.expectedVersion })).digest('hex');
    if (existing?.lastMutation?.key === ctx.idempotencyKey) {
      if (existing.lastMutation.inputHash !== inputHash) throw new Error('Cart idempotency key conflicts with another request.');
      return { ...await this.read({ cartId }, ctx), status: 'success', idempotentReplay: true };
    }
    const version = existing?.version ?? 0;
    if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== version)) throw new Error('Cart revision changed. Read it again before updating.');
    // The mutable cart holds a pointer, never a second copy of prices. Checkout and both UIs read the same authoritative quote snapshot.
    const built = items.length ? await new TradeQuoteCreateHandler(undefined, undefined, this.inMemoryProducts ? [...this.inMemoryProducts] : undefined, db ? async () => db : undefined).buildQuote({ items }, ctx, { cartId, version: version + 1 }) : undefined;
    const quote = built?.quote;
    const pointer = { cartId, ...owner, version: version + 1, ...(quote ? { quoteId: quote.quoteId } : {}), lastMutation: { key: ctx.idempotencyKey, inputHash }, updatedAt: new Date().toISOString() };
    if (this.inMemoryCarts) {
      if ((this.inMemoryCarts.get(key)?.version ?? 0) !== version) throw new Error('Cart revision changed. Read it again before updating.');
      this.inMemoryCarts.set(key, structuredClone({ ...pointer, ...(quote ? { quote } : {}) }));
    } else {
      await new CartQuoteRepository(db).commit({ key, cartId, owner, expectedVersion: version, idempotencyKey: ctx.idempotencyKey, inputHash, quote: built?.record });
      return { ...await this.read({ cartId }, ctx), status: 'success' };
    }
    return { cart: this.cart(pointer, quote), ...(quote ? { quote: { ...quote, cartId, cartVersion: pointer.version } } : {}), status: 'success' };
  }
}
