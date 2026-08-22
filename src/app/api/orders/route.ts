/**
 * The staff order queue.
 *
 * Staff-gated: this is the first place anyone but the customer's own browser
 * tab can see a completed order.
 */

import { requireStaff, isUnauthorised } from '@/lib/auth/guard';
import { listOrders } from '@/lib/order-store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = requireStaff(req);
  if (isUnauthorised(auth)) return auth.response;

  return Response.json({ orders: listOrders() });
}
