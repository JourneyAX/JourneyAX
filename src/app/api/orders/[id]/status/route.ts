/**
 * Move an order through the CSR queue: new → in-review → processed.
 */

import { requireStaff, isUnauthorised } from '@/lib/auth/guard';
import { setOrderStatus, type OrderStatus } from '@/lib/order-store';
import { guard, isFailure, errorResponse } from '@/lib/api-guard';
import { COMPUTE_LIMIT } from '@/lib/rate-limit';

const VALID: OrderStatus[] = ['new', 'in-review', 'processed'];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireStaff(req);
  if (isUnauthorised(auth)) return auth.response;

  const guarded = await guard<{ status?: unknown }>(req, { scope: 'order-status', rule: COMPUTE_LIMIT });
  if (isFailure(guarded)) return guarded.response;

  const { status } = guarded.body;
  if (typeof status !== 'string' || !VALID.includes(status as OrderStatus)) {
    return errorResponse(400, 'invalid_status', `status must be one of ${VALID.join(', ')}.`);
  }

  const { id } = await params;
  const updated = setOrderStatus(id, status as OrderStatus, auth.session.sub);
  if (!updated) return errorResponse(404, 'not_found', 'No such order.');

  return Response.json({ order: updated });
}
