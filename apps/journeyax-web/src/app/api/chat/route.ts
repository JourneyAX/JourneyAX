/**
 * Chat API Route — Thin Proxy to Agent Commerce via API Gateway
 *
 * ALL traffic from the UI goes through the API Gateway to Agent Commerce.
 * JourneyCoordinator & TenantRuntimeActivationRouter serve as the single
 * routing authority to select legacy vs canonical runtime execution.
 */

import { resolveTenant } from '../../../lib/tenant';
import { upstreamAuthHeaders, unauthorized } from '../../../lib/bff-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const tenantId = await resolveTenant(req);
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();

  const correlationId =
    body.correlationId ||
    req.headers.get('x-correlation-id') ||
    `corr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const turnId =
    body.turnId ||
    `turn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const sessionId = body.sessionId || body.workspaceId || `ws_${Date.now()}`;
  const workspaceId = body.workspaceId || body.sessionId || sessionId;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-ID': tenantId,
    'X-Correlation-ID': correlationId,
    ...auth,
  };

  const payload = {
    ...body,
    tenantId,
    turnId,
    correlationId,
    sessionId,
    workspaceId,
    idempotencyKey: body.idempotencyKey,
  };

  try {
    const resp = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));
    return new Response(JSON.stringify(data), {
      status: resp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: 'COMMERCE_SERVICE_UNAVAILABLE',
        message: err.message || 'Commerce service unreachable',
        status: 503,
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
