/**
 * Branch-stock proxy — forwards a real stock check to the gateway's
 * commerce/branch-stock endpoint (same BranchStockService the chat's
 * checkBranchStock tool uses). Powers the QuotePanel branch dropdown: picking
 * a branch calls this directly, no chat turn needed.
 */
import { resolveTenant } from '../../../lib/tenant';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: Request) {
  const body = await req.json();
  const tenantId = await resolveTenant(req);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId };

  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/branch-stock`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.text();
    return new Response(data, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ ok: false, results: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
}
