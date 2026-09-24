/**
 * Chat API Route — Thin Proxy to API Gateway with Server-Owned Cutover Routing
 *
 * ALL traffic from the UI goes through the API Gateway.
 * Server-owned routing decision from active tenant/environment release/cutover state:
 * - 'migrated': Routed exclusively to canonical JourneyAX Runtime Service. Any runtime failure fails closed.
 * - 'unmigrated' / 'rollback': Routed to legacy commerce.
 */

import { resolveTenant } from '../../../lib/tenant';
import { upstreamAuthHeaders, unauthorized } from '../../../lib/bff-auth';
import { resolveTenantRouting } from '../../../lib/routing/cutover';

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
  const workspaceId = body.workspaceId || body.sessionId || sessionId;
  const routing = await resolveTenantRouting(tenantId, 'production', {
    workspaceId,
  });

  // 1. Migrated Tenant Path: Exclusively executes on JourneyAX Runtime Service (Fails Closed)
  if (routing.cutoverState === 'migrated') {
    let runtimeResp: Response | null = null;
    try {
      const runtimePayload = {
        sessionId,
        workspaceId: body.workspaceId || sessionId,
        correlationId: body.correlationId || `corr_${Date.now()}`,
        message: body.message || (Array.isArray(body.messages) ? body.messages[body.messages.length - 1]?.content : undefined),
        inputFacts: body.inputFacts,
      };

      runtimeResp = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/runtime/turn`, {
        method: 'POST',
        headers,
        body: JSON.stringify(runtimePayload),
      });

      if (runtimeResp.ok) {
        const turnResult = await runtimeResp.json();
        return new Response(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: turnResult.assistantMessage || '',
            },
            uiActions: (turnResult.uiInstructions || []).map((inst: any) =>
              inst.envelope || {
                name: 'presentCard',
                arguments: {
                  card: {
                    id: inst.actionId || `${inst.component}-${Date.now()}`,
                    cardType: inst.component,
                    state: inst.props,
                  },
                },
              }
            ),
            workspace: turnResult.workspace,
            decision: turnResult.decision,
            conversation: [
              ...(body.messages || []),
              { role: 'assistant', content: turnResult.assistantMessage || '' },
            ],
            runtimeEngine: 'journey-runtime-service',
            cutoverState: 'migrated',
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
    } catch (err: any) {
      console.error(`[Chat Proxy] Migrated tenant '${tenantId}' runtime connection error:`, err.message);
    }

    // Fail closed for migrated tenant: NEVER silently fall back to legacy commerce
    const status = runtimeResp && runtimeResp.status >= 400 ? runtimeResp.status : 502;
    return new Response(
      JSON.stringify({
        error: 'MIGRATED_TENANT_RUNTIME_FAILURE',
        status,
        message: {
          role: 'assistant',
          content: `🚨 **Runtime Engine Error:** The verified JourneyAX runtime engine failed to complete this turn (HTTP ${status}). Execution blocked to prevent state divergence with unverified legacy commerce.`,
        },
        tenantId,
        cutoverState: 'migrated',
        routingReason: routing.reason,
      }),
      { status, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2. Unmigrated / Deliberate Rollback Path: Legacy commerce execution
  try {
    const response = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, tenantId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Chat Proxy] Gateway legacy error:', response.status, errorText);
      if (response.status === 429 || response.status === 413) {
        return new Response(errorText, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Retry-After': response.headers.get('retry-after') || '5' },
        });
      }
      return new Response(
        JSON.stringify({
          error: `Gateway returned ${response.status}`,
          message: { role: 'assistant', content: '🚨 **Error:** The AI service is temporarily unavailable. Please try again.' },
          conversation: [],
          uiActions: [],
          cutoverState: routing.cutoverState,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    return new Response(JSON.stringify({ ...data, cutoverState: routing.cutoverState }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[Chat Proxy] Gateway legacy connection error:', error.message);
    return new Response(
      JSON.stringify({
        error: error.message,
        message: { role: 'assistant', content: '🚨 **Error:** Could not connect to the API Gateway. Ensure all services are running.' },
        conversation: [],
        uiActions: [],
        cutoverState: routing.cutoverState,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
