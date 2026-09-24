import { createTrigger, TriggerStrategy, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth } from '../auth';
import { registerWebhookTrigger, unregisterWebhookTrigger } from '../webhook-lifecycle';

export interface OrderCommittedPayload {
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  orderId: string;
  quoteId?: string;
  totalCents: number;
  currency: string;
  customerEmail?: string;
  items: Array<{
    sku: string;
    quantity: number;
    priceCents: number;
  }>;
  timestamp: string;
}

export const orderCommittedTrigger = createTrigger({
  auth: journeyaxAuth,
  name: 'order_committed',
  displayName: 'Order Committed',
  description: 'Triggers when a customer authorizes an order or checkout session.',
  props: {
    minTotalCents: Property.Number({
      displayName: 'Minimum Total (Cents)',
      required: false,
    }),
  },
  type: TriggerStrategy.WEBHOOK,
  async onEnable(context) {
    await registerWebhookTrigger('order_committed', context);
  },
  async onDisable(context) {
    await unregisterWebhookTrigger('order_committed', context);
  },
  async run(context) {
    const payload = context.payload.body as OrderCommittedPayload;
    if (
      context.propsValue.minTotalCents != null &&
      payload.totalCents < context.propsValue.minTotalCents
    ) {
      return [];
    }
    return [payload];
  },
  sampleData: {
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: 'ws_sample_order',
    orderId: 'ord_sample_123',
    totalCents: 23800,
    currency: 'AUD',
    customerEmail: 'contractor@example.com.au',
    items: [{ sku: 'SKU-001', quantity: 1, priceCents: 23800 }],
    timestamp: new Date().toISOString(),
  },
});
