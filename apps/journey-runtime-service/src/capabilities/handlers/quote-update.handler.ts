import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface QuoteUpdateInput {
  specs?: any[];
  quoteId?: string;
  spaceType?: string;
  finish?: string;
}

export class QuoteUpdateHandler implements NativeCapabilityHandler {
  async execute(input: QuoteUpdateInput, ctx: ExecutionContext): Promise<any> {
    const specs = input.specs || [
      {
        fixtureId: 'caroma-spec-01',
        spaceType: input.spaceType || 'ensuite',
        finish: input.finish || 'matte black',
        quantity: 1,
      },
    ];

    const quote = {
      quoteId: input.quoteId || `quote-${ctx.workspaceId || Date.now()}`,
      specs,
      totalAmountCents: 125000,
      currency: 'AUD',
      status: 'active',
      updatedAt: new Date().toISOString(),
    };

    return {
      quote,
      status: 'success',
    };
  }
}
