import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS, COLLECTION_QUOTES } from '@journeyax/database';

export interface TradeQuoteCreateInput {
  items?: any[];
  tradeCategory?: string;
  projectDimensions?: string;
  currency?: string;
  accountNumber?: string;
  tradeDiscountPct?: number;
}

export interface TradeQuoteConnectorAdapter {
  createQuote(input: TradeQuoteCreateInput, ctx: ExecutionContext): Promise<any>;
}

export class TradeQuoteCreateHandler implements NativeCapabilityHandler {
  constructor(
    private readonly connectorAdapter?: TradeQuoteConnectorAdapter,
    private readonly inMemoryQuotes?: Record<string, any>,
    private readonly inMemoryProducts?: any[]
  ) {}

  async execute(input: TradeQuoteCreateInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;

    // 1. Explicitly configured tenant-scoped connector adapter
    if (this.connectorAdapter) {
      return this.connectorAdapter.createQuote(input, ctx);
    }

    // 2. Injected test fixture adapter
    if (this.inMemoryQuotes) {
      const qId = input.accountNumber ? `QUO-${input.accountNumber}` : 'QUO-TEST-FIXTURE';
      const quote = this.inMemoryQuotes[qId] || this.inMemoryQuotes['default'];
      if (!quote) {
        throw new Error(`[TradeQuoteCreateHandler] In-memory quote fixture not found for tenant '${tenantId}'`);
      }
      return quote;
    }

    // 3. Authoritative catalog verification (via in-memory test products or durable platform repository)
    const items = Array.isArray(input.items) ? input.items : [];
    if (items.length === 0) {
      throw new Error('[TradeQuoteCreateHandler] Cannot create quote with empty items list');
    }

    const skus = items.map((it: any) => it.sku).filter(Boolean);
    let dbProducts: any[] = [];
    const uri = process.env.MONGODB_URI;

    if (this.inMemoryProducts) {
      dbProducts = this.inMemoryProducts.filter((p) => {
        if (p.projectId && p.projectId !== tenantId) return false;
        return skus.includes(p.sku) || skus.includes(p.parentSku);
      });
    } else if (uri) {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      dbProducts = await db
        .collection(COLLECTION_PRODUCTS)
        .find({ projectId: tenantId, sku: { $in: skus } })
        .toArray();
    } else {
      throw new Error(
        `[TradeQuoteCreateHandler] Missing configured connector adapter or authoritative platform repository for tenant '${tenantId}' - failing closed`
      );
    }

    if (dbProducts.length === 0) {
      throw new Error(`[TradeQuoteCreateHandler] No verified products found in catalog for tenant '${tenantId}'`);
    }

    let subtotalCents = 0;
    const verifiedItems: any[] = [];
    for (const item of items) {
      const prod = dbProducts.find((p) => p.sku === item.sku || p.parentSku === item.sku);
      if (!prod) {
        throw new Error(`[TradeQuoteCreateHandler] Uncatalogued SKU '${item.sku}' cannot be quoted`);
      }
      const unitPriceCents = Number(prod.priceCents || Math.round(Number(prod.price?.amount ?? prod.price ?? 0) * 100));
      const qty = Number(item.quantity) || 1;
      const itemCurrency = (prod.price?.currency || prod.currency || '').toUpperCase() || undefined;
      subtotalCents += unitPriceCents * qty;
      verifiedItems.push({
        sku: item.sku,
        name: prod.name || prod.title || item.name || '',
        quantity: qty,
        unitPriceCents,
        totalPriceCents: unitPriceCents * qty,
        currency: itemCurrency,
      });
    }

    // Currency resolution & strict validation: NEVER default to NZD or USD
    const productCurrencies = Array.from(new Set(verifiedItems.map((it) => it.currency).filter(Boolean)));
    if (productCurrencies.length > 1) {
      throw new Error(
        `[TradeQuoteCreateHandler] Mixed currencies detected across quote items without authoritative FX conversion: ${productCurrencies.join(', ')}`
      );
    }

    const packCurrency = (ctx as any)?.pricing?.currency || (ctx as any)?.currency;
    const authoritativeCurrency =
      productCurrencies[0] ||
      (packCurrency ? String(packCurrency).toUpperCase() : undefined);

    if (!authoritativeCurrency) {
      throw new Error(
        `[TradeQuoteCreateHandler] Missing authoritative currency in Business Pack pricing policy and catalogue records - failing closed (input.currency cannot be sole authority)`
      );
    }

    if (input.currency && input.currency.toUpperCase() !== authoritativeCurrency) {
      throw new Error(
        `[TradeQuoteCreateHandler] Conflicting currency: caller requested '${input.currency.toUpperCase()}' but authoritative catalogue/pack requires '${authoritativeCurrency}'`
      );
    }

    const quoteId = `QUO-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const subtotal = Math.round(subtotalCents) / 100;
    const quoteRecord = {
      quoteId,
      projectId: tenantId,
      tenantId,
      workspaceId: ctx.workspaceId,
      items: verifiedItems.map((it) => ({ ...it, currency: authoritativeCurrency })),
      subtotal,
      totalAmount: subtotal,
      currency: authoritativeCurrency,
      status: 'active',
      confirmed: true,
      createdAt: new Date().toISOString(),
    };

    if (!this.inMemoryProducts && uri) {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      await db.collection(COLLECTION_QUOTES).insertOne(quoteRecord);
    }

    return quoteRecord;
  }
}
