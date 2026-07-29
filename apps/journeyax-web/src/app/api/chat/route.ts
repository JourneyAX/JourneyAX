/**
 * Chat API Route — Thin Proxy to API Gateway
 *
 * ALL traffic from the UI goes through the API Gateway.
 * The gateway handles: auth validation, tenant resolution, and routing to the correct service.
 *
 * Flow:
 * ChatPanel.tsx
 *   → POST /api/chat (this file)
 *     → API Gateway :3010 /api/v1/commerce/chat
 *       → JourneyAXController (agent-commerce-service :3004)
 *         → AgentService (ReAct loop)
 *           → ProductService (product-service :8083)
 *             → MongoDB Atlas
 */

import { resolveTenant } from '../../../lib/tenant';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: Request) {
  // Client-minimal contract: the browser sends only { message, sessionId }
  // (server owns transcript + state). Legacy { messages, state } still forwarded.
  const body = await req.json();

  // Forward auth + tenant headers from the browser if present
  // Multi-storefront routing: ?project → X-Tenant-ID header → Host domain → env.
  const tenantId = await resolveTenant(req);
  const authHeader = req.headers.get('authorization');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-ID': tenantId,
  };
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  try {
    const response = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, tenantId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Chat Proxy] Gateway error:', response.status, errorText);
      // P0-05: pass the rate-limit body straight through so the UI shows the
      // graceful "slow down" assistant message rather than a generic error.
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
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[Chat Proxy] Gateway connection error:', error.message);
    return new Response(
      JSON.stringify({
        error: error.message,
        message: { role: 'assistant', content: '🚨 **Error:** Could not connect to the API Gateway. Ensure all services are running.' },
        conversation: [],
        uiActions: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
