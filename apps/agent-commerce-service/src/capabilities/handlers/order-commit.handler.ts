import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase } from '@journeyax/database';

export interface OrderCommitInput {
  quoteId?: string;
  items?: Array<{ sku: string; quantity: number; priceCents: number }>;
  customerEmail?: string;
}

export class OrderCommitHandler implements NativeCapabilityHandler {
  async execute(input: OrderCommitInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const items = input.items || [];
    const totalCents = items.reduce((sum, item) => sum + (item.priceCents * (item.quantity || 1)), 0);

    const uri = process.env.MONGODB_URI;
    if (uri) {
      try {
        const { db } = await connectToDatabase(uri, 'journeyx');
        await db.collection('orders').insertOne({
          orderId,
          projectId: tenantId,
          userId: ctx.principalId || null,
          status: 'pending_payment',
          quoteId: input.quoteId || null,
          items,
          totalCents,
          customerEmail: input.customerEmail || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } catch (err: any) {
        console.warn('[OrderCommitHandler] Order persistence error:', err.message);
      }
    }

    return {
      orderId,
      status: 'pending_payment',
      totalCents,
      checkoutUrl: `https://checkout.journeyax.io/${tenantId}/${orderId}`,
      createdAt: new Date().toISOString(),
    };
  }
}
