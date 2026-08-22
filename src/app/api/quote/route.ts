/**
 * Authoritative quote totals.
 *
 * The browser computes totals too, for instant feedback as the shopper edits
 * quantities. That client figure is a *preview*. This route is the number of
 * record: it recomputes from the line items, ignores any arithmetic the client
 * supplied, and reports whether the quote is fit to be acted on.
 *
 * Nothing may be ordered, emailed or charged on a total that did not come
 * from here with `acceptable: true`.
 */

import { verifyQuote } from '@/lib/pricing';
import type { BOMLine } from '@/lib/types';
import { guard, isFailure, errorResponse } from '@/lib/api-guard';
import { COMPUTE_LIMIT } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const log = logger('api/quote');

/** Guard against a caller pasting in a thousand-line BOM to burn CPU. */
const MAX_LINES = 200;
const MAX_ADDONS = 20;

interface QuoteRequest {
  bom?: unknown;
  selectedAddons?: unknown;
  qty?: unknown;
}

export async function POST(req: Request) {
  const guarded = await guard<QuoteRequest>(req, { scope: 'quote', rule: COMPUTE_LIMIT });
  if (isFailure(guarded)) return guarded.response;

  const { bom, selectedAddons, qty } = guarded.body;

  if (!Array.isArray(bom)) {
    return errorResponse(400, 'invalid_bom', '`bom` must be an array of line items.');
  }
  if (bom.length > MAX_LINES) {
    return errorResponse(400, 'bom_too_large', `A quote may not exceed ${MAX_LINES} lines.`);
  }
  if (bom.some(line => line === null || typeof line !== 'object' || Array.isArray(line))) {
    return errorResponse(400, 'invalid_bom', 'Each BOM line must be an object.');
  }

  const addons = Array.isArray(selectedAddons)
    ? selectedAddons.filter((a): a is string => typeof a === 'string').slice(0, MAX_ADDONS)
    : [];

  const quantity = typeof qty === 'number' && Number.isInteger(qty) && qty > 0 ? qty : 1;

  try {
    const verdict = verifyQuote(bom as Partial<BOMLine>[], addons, quantity);

    // A rejected quote is a signal worth keeping: it means either a client bug
    // or someone editing prices. Log the reasons, never the whole payload.
    if (!verdict.acceptable) {
      log.warn('quote rejected', verdict.issues);
    }

    return Response.json(verdict);
  } catch (error) {
    log.error('quote verification failed', error);
    return errorResponse(500, 'quote_failed', 'Could not price this quote.');
  }
}
