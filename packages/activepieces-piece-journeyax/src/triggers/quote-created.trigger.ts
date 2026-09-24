import { createTrigger, TriggerStrategy, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth } from '../auth';
import { registerWebhookTrigger, unregisterWebhookTrigger } from '../webhook-lifecycle';

export interface QuoteCreatedPayload {
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  quoteId: string;
  items: Array<{
    sku: string;
    name: string;
    quantity: number;
    priceCents: number;
  }>;
  totalCents: number;
  currency: string;
  timestamp: string;
}

export const quoteCreatedTrigger = createTrigger({
  auth: journeyaxAuth,
  name: 'quote_created',
  displayName: 'Quote Created',
  description: 'Triggers when a formal commercial or service quote is generated in the workspace.',
  props: {
    minAmountCents: Property.Number({
      displayName: 'Minimum Quote Amount (Cents)',
      description: 'Optional filter: trigger only for quotes with total greater than or equal to this amount',
      required: false,
    }),
  },
  type: TriggerStrategy.WEBHOOK,
  async onEnable(context) {
    await registerWebhookTrigger('quote_created', context);
  },
  async onDisable(context) {
    await unregisterWebhookTrigger('quote_created', context);
  },
  async run(context) {
    const payload = context.payload.body as QuoteCreatedPayload;
    if (
      context.propsValue.minAmountCents != null &&
      payload.totalCents < context.propsValue.minAmountCents
    ) {
      return [];
    }
    return [payload];
  },
  sampleData: {
    tenantId: 'royalcyber',
    environmentId: 'production',
    workspaceId: 'ws_sample_quote',
    quoteId: 'quote_rc_2026_0911',
    items: [
      {
        sku: 'RC-CONSULTING-PHASE1',
        name: 'Architecture Scoping & LLM Agent Design',
        quantity: 1,
        priceCents: 8000000,
      },
    ],
    totalCents: 8000000,
    currency: 'USD',
    timestamp: new Date().toISOString(),
  },
});
