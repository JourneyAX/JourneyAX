import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface TradeQuoteCreateInput {
  items?: any[];
  tradeCategory?: string;
  projectDimensions?: string;
  currency?: string;
  accountNumber?: string;
}

export class TradeQuoteCreateHandler implements NativeCapabilityHandler {
  constructor(private readonly inMemoryQuotes?: Record<string, any>) {}

  async execute(input: TradeQuoteCreateInput, ctx: ExecutionContext): Promise<any> {
    const quoteId = `QUO-PM-${Math.floor(100000 + Math.random() * 900000)}`;
    const packageId = `PKG-PM-${Math.floor(1000 + Math.random() * 9000)}`;
    const currency = input.currency || 'NZD';

    const items = Array.isArray(input.items) && input.items.length > 0
      ? input.items
      : [
          { sku: 'PM-MAT-001', name: 'Specification Materials Package', quantity: 1, unitPrice: 3450.0 },
          { sku: 'PM-FAS-002', name: 'Certified Fasteners & Connectors Pack', quantity: 2, unitPrice: 280.0 },
        ];

    const subtotal = items.reduce((sum, item) => sum + (item.unitPrice || 100) * (item.quantity || 1), 0);
    const tradeDiscountPct = 15;
    const discountAmount = Math.round(subtotal * (tradeDiscountPct / 100) * 100) / 100;
    const totalAmount = Math.round((subtotal - discountAmount) * 100) / 100;

    return {
      quoteId,
      packageId,
      status: 'active',
      confirmed: true,
      currency,
      subtotal,
      tradeDiscountPct,
      discountAmount,
      totalAmount,
      itemsCount: items.length,
      items,
      validUntil: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      generatedAt: new Date().toISOString(),
    };
  }
}
