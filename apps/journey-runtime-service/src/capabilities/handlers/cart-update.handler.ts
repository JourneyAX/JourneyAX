import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface CartUpdateInput {
  items?: any[];
  cartId?: string;
  category?: string;
  quantity?: number;
}

export class CartUpdateHandler implements NativeCapabilityHandler {
  async execute(input: CartUpdateInput, ctx: ExecutionContext): Promise<any> {
    const items = input.items || [
      {
        sku: 'SKU-STD-001',
        category: input.category || 'standard',
        quantity: input.quantity ?? 2,
        priceCents: 4500,
      },
    ];

    const cart = {
      cartId: input.cartId || `cart-${ctx.workspaceId || Date.now()}`,
      items,
      totalItems: items.reduce((acc, it) => acc + (it.quantity || 1), 0),
      currency: 'USD',
      status: 'active',
      updatedAt: new Date().toISOString(),
    };

    return {
      cart,
      status: 'success',
    };
  }
}
