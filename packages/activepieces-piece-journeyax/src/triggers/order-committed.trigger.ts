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

export const orderCommittedTrigger = {
  name: 'order_committed',
  displayName: 'Order Committed',
  description: 'Triggers when a customer authorizes an order or checkout session.',
  sampleData: {
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: 'ws_wwg_apprentice_1727136000000',
    orderId: 'ord_1727136000000_abc12',
    totalCents: 23800,
    currency: 'AUD',
    customerEmail: 'apprentice@example.com.au',
    items: [
      { sku: 'K13820-NAV-92S', quantity: 1, priceCents: 7900 },
      { sku: 'WWG-HARDYAKKA-Y60363', quantity: 1, priceCents: 15900 },
    ],
    timestamp: '2026-09-23T22:00:00.000Z',
  },
};
