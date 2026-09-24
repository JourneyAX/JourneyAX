/**
 * Streaming Chat proxy — forwards the browser's request to the gateway's SSE endpoint
 * with server-owned cutover routing from the active tenant/environment release/cutover state.
 *
 * Rules:
 * - 'migrated': Routed exclusively to canonical journey-runtime-service stream.
 *   Any runtime failure fails closed with a typed observable error (never falls back to legacy).
 * - 'unmigrated' / 'rollback': Routed to legacy commerce stream.
 */
import { resolveTenant } from '../../../../lib/tenant';
import { upstreamAuthHeaders, unauthorized } from '../../../../lib/bff-auth';
import { resolveTenantRouting } from '../../../../lib/routing/cutover';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: Request) {
  const body = await req.json();
  const tenantId = await resolveTenant(req);
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-ID': tenantId,
    ...auth,
  };

  const sessionId = body.sessionId || body.workspaceId || 'default';
  const routing = await resolveTenantRouting(tenantId);

  // 1. Migrated Tenant Path: Exclusively executes on JourneyAX Runtime Service Stream (Fails Closed)
  if (routing.cutoverState === 'migrated') {
    let upstream: Response | null = null;
    try {
      const runtimePayload = {
        sessionId,
        workspaceId: body.workspaceId || sessionId,
        correlationId: body.correlationId || `corr_${Date.now()}`,
        message: body.message || (Array.isArray(body.messages) ? body.messages[body.messages.length - 1]?.content : undefined),
        inputFacts: body.inputFacts,
      };

      upstream = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/runtime/chat/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify(runtimePayload),
      });

      if (upstream.ok && upstream.body) {
        return new Response(upstream.body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Cutover-State': 'migrated',
          },
        });
      }
    } catch (err: any) {
      console.error(`[Chat Stream Proxy] Migrated tenant '${tenantId}' runtime connection error:`, err.message);
    }

    // Fail closed for migrated tenant: NEVER silently fall back to legacy commerce stream
    const status = upstream && upstream.status >= 400 ? upstream.status : 502;
    return new Response(
      JSON.stringify({
        error: 'MIGRATED_TENANT_RUNTIME_STREAM_FAILURE',
        status,
        message: `🚨 Runtime Engine Stream Error: The verified JourneyAX runtime engine failed to establish a stream (HTTP ${status}). Execution blocked to prevent state divergence with unverified legacy commerce.`,
        tenantId,
        cutoverState: 'migrated',
        routingReason: routing.reason,
      }),
      {
        status,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 2. Unmigrated / Deliberate Rollback Path: Legacy commerce stream execution
  try {
    const upstream = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/chat/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, tenantId }),
    });

    if (!upstream.ok || !upstream.body) {
      if (upstream.status === 429 || upstream.status === 413) {
        return new Response(await upstream.text(), {
          status: upstream.status,
          headers: { 'Content-Type': 'application/json', 'Retry-After': upstream.headers.get('retry-after') || '5' },
        });
      }
      return new Response(
        JSON.stringify({
          error: `Gateway returned ${upstream.status}`,
          cutoverState: routing.cutoverState,
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Cutover-State': routing.cutoverState,
      },
    });
  } catch (error: any) {
    console.error('[Chat Stream Proxy] Gateway legacy connection error:', error.message);
    return new Response(
      JSON.stringify({
        error: error.message,
        cutoverState: routing.cutoverState,
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
