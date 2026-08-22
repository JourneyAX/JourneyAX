/**
 * Where a checkout actually becomes a record.
 *
 * Re-verifies the quote server-side with the exact same `verifyQuote` used by
 * /api/quote, rather than trusting the client's earlier "acceptable: true" a
 * second time — the BOM could have been edited in the moment between getting
 * that verdict and clicking Approve. Nothing is persisted on a rejected
 * quote, and the order id is generated here, not accepted from the client.
 *
 * There is no customer account system for the shopper-facing journeys (see
 * CLAUDE.md — `/` and `/shop` are intentionally anonymous), so unlike the
 * staff-side stores in this app there is no session identity to stamp.
 * What *is* enforced server-side is the only thing that matters for money:
 * the total.
 */

import { verifyQuote } from '@/lib/pricing';
import { recordOrder, type OrderSource, type OrderLine } from '@/lib/order-store';
import type { BOMLine } from '@/lib/types';
import { guard, isFailure, errorResponse } from '@/lib/api-guard';
import { COMPUTE_LIMIT } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const log = logger('api/orders/submit');

const MAX_LINES = 200;
const MAX_ADDONS = 20;

interface SubmitRequest {
  source?: unknown;
  title?: unknown;
  jobId?: unknown;
  bom?: unknown;
  selectedAddons?: unknown;
  qty?: unknown;
}

function orderIdFor(source: OrderSource): string {
  const prefix = source === 'shop' ? 'AF' : 'CAR';
  return `${prefix}-${Math.floor(100000 + Math.random() * 899999)}`;
}

export async function POST(req: Request) {
  const guarded = await guard<SubmitRequest>(req, { scope: 'orders-submit', rule: COMPUTE_LIMIT });
  if (isFailure(guarded)) return guarded.response;

  const { source, title, jobId, bom, selectedAddons, qty } = guarded.body;

  if (source !== 'caroma' && source !== 'shop') {
    return errorResponse(400, 'invalid_source', 'source must be caroma or shop.');
  }
  if (!Array.isArray(bom)) {
    return errorResponse(400, 'invalid_bom', '`bom` must be an array of line items.');
  }
  if (bom.length === 0) {
    return errorResponse(400, 'empty_order', 'Cannot submit an order with no lines.');
  }
  if (bom.length > MAX_LINES) {
    return errorResponse(400, 'bom_too_large', `An order may not exceed ${MAX_LINES} lines.`);
  }
  if (bom.some(line => line === null || typeof line !== 'object' || Array.isArray(line))) {
    return errorResponse(400, 'invalid_bom', 'Each order line must be an object.');
  }

  const addons = Array.isArray(selectedAddons)
    ? selectedAddons.filter((a): a is string => typeof a === 'string').slice(0, MAX_ADDONS)
    : [];
  const quantity = typeof qty === 'number' && Number.isInteger(qty) && qty > 0 ? qty : 1;

  try {
    const verdict = verifyQuote(bom as Partial<BOMLine>[], addons, quantity);

    if (!verdict.acceptable) {
      log.warn('order rejected at submit — quote no longer verifies', verdict.issues);
      return Response.json({ acceptable: false, issues: verdict.issues }, { status: 200 });
    }

    const lines: OrderLine[] = (bom as Partial<BOMLine>[]).map((line, i) => ({
      key: line.key || line.sku || `line-${i}`,
      sku: line.sku,
      name: line.name || 'Unnamed item',
      price: typeof line.price === 'number' ? line.price : 0,
      quantity: typeof line.quantity === 'number' ? line.quantity : 1,
      category: line.category,
    }));

    const record = recordOrder({
      id: orderIdFor(source),
      source,
      title: typeof title === 'string' && title ? title : 'Untitled order',
      jobId: typeof jobId === 'string' ? jobId : undefined,
      lines,
      subtotal: verdict.totals.subtotal,
      discount: verdict.totals.discount,
      gst: verdict.totals.gst,
      total: verdict.totals.total,
      createdAt: new Date().toISOString(),
    });

    log.info(`order recorded: ${record.id} (${source}), total ${record.total}`);
    return Response.json({ acceptable: true, id: record.id, totals: verdict.totals });
  } catch (error) {
    log.error('order submission failed', error);
    return errorResponse(500, 'submit_failed', 'Could not record this order.');
  }
}
