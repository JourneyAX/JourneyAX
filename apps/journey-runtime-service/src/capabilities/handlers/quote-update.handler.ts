import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_QUOTES } from '@journeyax/database';

export interface QuoteUpdateInput {
  specs?: any[];
  quoteId?: string;
  spaceType?: string;
  finish?: string;
  totalAmountCents?: number;
}

export interface QuoteConnectorAdapter {
  updateQuote(input: QuoteUpdateInput, ctx: ExecutionContext): Promise<any>;
}

export class QuoteUpdateHandler implements NativeCapabilityHandler {
  constructor(
    private readonly connectorAdapter?: QuoteConnectorAdapter,
    private readonly inMemoryQuotes?: Map<string, any>
  ) {}

  async execute(input: QuoteUpdateInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;

    // 1. Explicitly configured tenant-scoped connector adapter
    if (this.connectorAdapter) {
      return this.connectorAdapter.updateQuote(input, ctx);
    }

    // 2. Injected test fixture repository
    if (this.inMemoryQuotes) {
      const qId = input.quoteId || 'default';
      const existing = this.inMemoryQuotes.get(qId);
      if (!existing) {
        throw new Error(`[QuoteUpdateHandler] Quote '${qId}' not found in fixture repository`);
      }
      return { quote: existing, status: 'success' };
    }

    // 3. Durable, authoritative platform repository
    const uri = process.env.MONGODB_URI;
    if (uri && input.quoteId) {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      const existing = await db.collection(COLLECTION_QUOTES).findOne({
        projectId: tenantId,
        quoteId: input.quoteId,
      });

      if (!existing) {
        throw new Error(`[QuoteUpdateHandler] Quote '${input.quoteId}' not found for tenant '${tenantId}'`);
      }

      await db.collection(COLLECTION_QUOTES).updateOne(
        { projectId: tenantId, quoteId: input.quoteId },
        { $set: { updatedAt: new Date().toISOString(), specs: input.specs || existing.specs } }
      );

      return {
        quote: { ...existing, specs: input.specs || existing.specs, updatedAt: new Date().toISOString() },
        status: 'success',
      };
    }

    // 4. Missing bindings must fail closed
    throw new Error(
      `[QuoteUpdateHandler] Missing authoritative quote connector adapter or platform repository for tenant '${tenantId}' - failing closed`
    );
  }
}
