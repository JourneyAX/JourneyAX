/**
 * Order proxy (P0-04) — forwards an order-commit request to the gateway's
 * authoritative commerce endpoint, which opens a real Stripe Checkout Session.
 * The browser sends only { quoteId, idempotencyKey }; the server owns pricing,
 * validation and payment. Tenant is resolved per request (multi-storefront).
 */
import { resolveTenant } from '../../../lib/tenant';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: Request) {
  const body = await req.json();
  const tenantId = await resolveTenant(req);
  const authHeader = req.headers.get('authorization');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId };
  if (authHeader) headers['Authorization'] = authHeader;

  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/order`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.text();
    return new Response(data, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: 'Could not reach the order service.' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** Order status — the storefront polls this after returning from Stripe. */
export async function GET(req: Request) {
  const tenantId = await resolveTenant(req);
  const orderId = new URL(req.url).searchParams.get('orderId') || '';
  if (!orderId) return json({ found: false });
  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/order/${encodeURIComponent(orderId)}`, {
      headers: { 'X-Tenant-ID': tenantId },
      cache: 'no-store',
    });
    return json(await res.json());
  } catch {
    return json({ found: false });
  }
}

function json(data: any) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}
