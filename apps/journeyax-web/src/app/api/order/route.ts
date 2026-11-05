/**
 * Order proxy (P0-04) — forwards an order-commit request to the gateway's
 * authoritative commerce endpoint, which opens a real Stripe Checkout Session.
 * The browser sends only { quoteId, idempotencyKey }; the server owns pricing,
 * validation and payment. Tenant is resolved per request (multi-storefront).
 */
import { resolveTenant } from '../../../lib/tenant';
import { upstreamAuthHeaders, unauthorized } from '../../../lib/bff-auth';
import { isSameOriginRequest } from '../../../lib/request-origin';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid order request.' }, 400);
  if (!isSameOriginRequest(req)) return json({ error: 'Invalid origin.' }, 403);
  const tenantId = await resolveTenant(req);
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, ...auth };

  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/order`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    const data = await res.text();
    return new Response(data, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: 'Could not reach the order service.' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** Order status — the storefront polls this after returning from Stripe. */
export async function GET(req: Request) {
  const tenantId = await resolveTenant(req);
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  const orderId = new URL(req.url).searchParams.get('orderId') || '';
  if (!orderId) return json({ found: false });
  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/order/${encodeURIComponent(orderId)}`, {
      headers: { 'X-Tenant-ID': tenantId, ...auth },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    return json(await res.json(), res.status);
  } catch {
    return json({ found: false });
  }
}

/** This cancels a provider session, never deletes an order record. */
export async function DELETE(req: Request) {
  if (!isSameOriginRequest(req)) return json({ error: 'Invalid origin.' }, 403);
  const tenantId = await resolveTenant(req);
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  const body = await req.json().catch(() => null);
  if (typeof body?.orderId !== 'string' || !body.orderId || body.orderId.length > 200) return json({ error: 'An order is required.' }, 400);
  try {
    const response = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/order/${encodeURIComponent(body.orderId)}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, ...auth },
      body: '{}', redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    return json(await response.json(), response.status);
  } catch { return json({ error: 'Could not confirm cancellation. Please check this order before paying again.' }, 502); }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
