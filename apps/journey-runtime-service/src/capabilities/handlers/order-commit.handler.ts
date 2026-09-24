import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, ensureDatabaseIndices } from '@journeyax/database';

export interface OrderCommitInput {
  quoteId?: string;
  idempotencyKey?: string;
  items?: Array<{ sku: string; quantity: number; priceCents?: number; name?: string }>;
  customerEmail?: string;
  currency?: string;
}

export class OrderCommitHandler implements NativeCapabilityHandler {
  constructor(
    private readonly inMemoryOrders?: any[],
    private readonly catalogSnapshot?: any[],
    private readonly quotesSnapshot?: any[]
  ) {}

  async execute(input: OrderCommitInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;
    const items = input.items || [];
    const idempotencyKey = input.idempotencyKey || ctx.idempotencyKey;

    if (!idempotencyKey) {
      throw new Error('[OrderCommitHandler] idempotencyKey is required for order commitment');
    }

    if (items.length === 0) {
      throw new Error('Cannot commit order with empty cart');
    }

    for (const item of items) {
      if ((item.quantity || 0) <= 0) {
        throw new Error(`Invalid item quantity for SKU: ${item.sku}`);
      }
    }

    // 1. In-Memory Idempotency Replay Check (for test / fast-path)
    if (this.inMemoryOrders) {
      const existing = this.inMemoryOrders.find(
        (o) => o.idempotencyKey === idempotencyKey && o.projectId === tenantId
      );
      if (existing) {
        return {
          orderId: existing.orderId,
          status: existing.status,
          currency: existing.currency,
          totalCents: existing.totalCents,
          itemsCount: existing.items.length,
          createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : existing.createdAt.toISOString(),
          replayed: true,
        };
      }
    }

    // 2. Authoritative Evidence Resolution
    let dbInstance: any = null;
    let mongoClient: any = null;

    if (!this.inMemoryOrders) {
      const uri = process.env.MONGODB_URI;
      if (!uri) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error(
            '[OrderCommitHandler] Durable persistence failure: MONGODB_URI is required in production'
          );
        }
        throw new Error(
          '[OrderCommitHandler] Durable persistence failure: database connection required for order commitment'
        );
      }
      const { db, client } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      dbInstance = db;
      mongoClient = client;

      // Check DB idempotency before computation
      const existingDbOrder = await dbInstance.collection('orders').findOne({ idempotencyKey, projectId: tenantId });
      if (existingDbOrder) {
        return {
          orderId: existingDbOrder.orderId,
          status: existingDbOrder.status,
          currency: existingDbOrder.currency,
          totalCents: existingDbOrder.totalCents,
          itemsCount: existingDbOrder.items?.length || 0,
          createdAt:
            existingDbOrder.createdAt instanceof Date
              ? existingDbOrder.createdAt.toISOString()
              : existingDbOrder.createdAt,
          replayed: true,
        };
      }
    }

    // Look up quote if quoteId provided
    let verifiedQuote: any = null;
    if (input.quoteId) {
      if (this.quotesSnapshot) {
        verifiedQuote = this.quotesSnapshot.find(
          (q) => q.quoteId === input.quoteId && (q.projectId === tenantId || q.tenantId === tenantId)
        );
      } else if (dbInstance) {
        verifiedQuote = await dbInstance.collection('quotes').findOne({
          quoteId: input.quoteId,
          $or: [{ projectId: tenantId }, { tenantId }],
        });
      }
    }

    // Look up product catalog records for items
    let dbProducts: any[] = [];
    if (!this.catalogSnapshot && dbInstance) {
      const skus = items.map((i) => i.sku);
      dbProducts = await dbInstance
        .collection('products')
        .find({
          $and: [
            { $or: [{ projectId: tenantId }, { tenantId }] },
            { $or: [{ sku: { $in: skus } }, { parentSku: { $in: skus } }] },
          ],
        })
        .toArray();
    }

    let computedCurrency = '';
    const verifiedItems: Array<{ sku: string; quantity: number; priceCents: number; name: string }> = [];

    for (const item of items) {
      if ((item.quantity || 0) <= 0) {
        throw new Error(`Invalid item quantity for SKU: ${item.sku}`);
      }

      // Check quote first
      let authoritativePriceCents: number | null = null;
      let authoritativeCurrency: string | null = null;
      let authoritativeInStock = true;
      let evidenceFound = false;

      if (verifiedQuote && Array.isArray(verifiedQuote.items)) {
        const quoteItem = verifiedQuote.items.find((qi: any) => qi.sku === item.sku);
        if (quoteItem) {
          evidenceFound = true;
          authoritativePriceCents = quoteItem.priceCents;
          authoritativeCurrency = verifiedQuote.currency || quoteItem.currency;
        }
      }

      // Check catalog snapshot or dbProducts
      if (!evidenceFound) {
        const catalogList = this.catalogSnapshot || dbProducts;
        const product = catalogList.find(
          (p: any) => p.sku === item.sku || p.parentSku === item.sku
        );

        if (product) {
          evidenceFound = true;
          if (product.priceCents != null && product.priceCents > 0) {
            authoritativePriceCents = product.priceCents;
          } else if (product.price?.amount != null && product.price.amount > 0) {
            authoritativePriceCents = Math.round(product.price.amount * 100);
          }
          authoritativeCurrency = (product.price?.currency || product.currency || '').toUpperCase();
          if (product.stock?.inStock === false || product.inStock === false) {
            authoritativeInStock = false;
          }
        }
      }

      // If no authoritative evidence in quote or catalog: FAIL CLOSED!
      if (!evidenceFound || authoritativePriceCents == null) {
        throw new Error(
          `[OrderCommitHandler] Missing authoritative catalog evidence for SKU '${item.sku}' in tenant '${tenantId}' - cannot commit order with unverified pricing`
        );
      }

      if (!authoritativeInStock) {
        throw new Error(`Product '${item.sku}' is out of stock`);
      }

      // Reject caller price tampering
      if (item.priceCents != null && item.priceCents !== authoritativePriceCents) {
        throw new Error(
          `Authoritative price mismatch for SKU '${item.sku}': catalog price is ${authoritativePriceCents}, but caller supplied ${item.priceCents}`
        );
      }
      item.priceCents = authoritativePriceCents;

      // Authoritative currency enforcement
      if (!authoritativeCurrency) {
        throw new Error(`[OrderCommitHandler] Missing authoritative currency for SKU '${item.sku}'`);
      }
      if (computedCurrency && computedCurrency !== authoritativeCurrency) {
        throw new Error(
          `[OrderCommitHandler] Multi-currency cart is not supported: SKU '${item.sku}' uses ${authoritativeCurrency}, but cart uses ${computedCurrency}`
        );
      }
      computedCurrency = authoritativeCurrency;

      verifiedItems.push({
        sku: item.sku,
        quantity: item.quantity,
        priceCents: item.priceCents,
        name: item.name || item.sku,
      });
    }

    if (!computedCurrency) {
      throw new Error(
        '[OrderCommitHandler] Currency could not be determined from authoritative records - defaulting is prohibited'
      );
    }

    if (input.currency && input.currency.toUpperCase() !== computedCurrency) {
      throw new Error(
        `[OrderCommitHandler] Currency mismatch: authoritative records require ${computedCurrency}, but caller requested ${input.currency.toUpperCase()}`
      );
    }

    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const totalCents = verifiedItems.reduce(
      (sum, item) => sum + item.priceCents * item.quantity,
      0
    );

    const orderRecord = {
      orderId,
      idempotencyKey,
      projectId: tenantId,
      userId: ctx.principalId || null,
      status: 'pending_payment' as const,
      quoteId: input.quoteId || null,
      items: verifiedItems,
      totalCents,
      currency: computedCurrency,
      customerEmail: input.customerEmail || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const outboxRecord = {
      eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      tenantId,
      environmentId: ctx.environmentId,
      eventType: 'order.committed',
      payload: {
        orderId,
        totalCents,
        currency: computedCurrency,
        itemsCount: verifiedItems.length,
      },
      status: 'pending' as const,
      attempts: 0,
      createdAt: new Date(),
    };

    // 3. Durable Atomic Persistence
    if (this.inMemoryOrders) {
      this.inMemoryOrders.push(orderRecord);
    } else if (dbInstance && mongoClient) {
      // Ensure unique index
      try {
        await dbInstance.collection('orders').createIndex(
          { projectId: 1, idempotencyKey: 1 },
          { unique: true }
        );
      } catch {
        // Index may already exist
      }

      if (mongoClient.startSession) {
        const session = mongoClient.startSession();
        try {
          await session.withTransaction(async () => {
            await dbInstance.collection('orders').insertOne(orderRecord, { session });
            await dbInstance.collection('outbox_events').insertOne(outboxRecord, { session });
          });
        } catch (txErr: any) {
          if (txErr.code === 11000) {
            // Unique index duplicate key: return existing order replay
            const existing = await dbInstance.collection('orders').findOne({ idempotencyKey, projectId: tenantId });
            if (existing) {
              return {
                orderId: existing.orderId,
                status: existing.status,
                currency: existing.currency,
                totalCents: existing.totalCents,
                itemsCount: existing.items?.length || 0,
                createdAt:
                  existing.createdAt instanceof Date
                    ? existing.createdAt.toISOString()
                    : existing.createdAt,
                replayed: true,
              };
            }
          }

          if (process.env.NODE_ENV === 'production') {
            throw new Error(`[OrderCommitHandler] Durable order persistence failed in production: ${txErr.message}`);
          }

          if (/replica set|standalone/i.test(txErr.message || '')) {
            // Dev standalone MongoDB fallback: write BOTH order and outbox
            await dbInstance.collection('orders').insertOne(orderRecord);
            await dbInstance.collection('outbox_events').insertOne(outboxRecord);
          } else {
            throw new Error(`[OrderCommitHandler] Durable order persistence failed: ${txErr.message}`);
          }
        } finally {
          await session.endSession();
        }
      } else {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('[OrderCommitHandler] MongoDB sessions required in production');
        }
        await dbInstance.collection('orders').insertOne(orderRecord);
        await dbInstance.collection('outbox_events').insertOne(outboxRecord);
      }
    }

    return {
      orderId,
      status: 'pending_payment',
      currency: computedCurrency,
      totalCents,
      itemsCount: verifiedItems.length,
      createdAt: orderRecord.createdAt.toISOString(),
    };
  }
}
