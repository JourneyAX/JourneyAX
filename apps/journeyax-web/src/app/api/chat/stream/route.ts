/**
 * Streaming Chat proxy — forwards the browser's request to the gateway's SSE
 * endpoint and pipes the event stream straight back (no buffering).
 *
 * Mirrors /api/chat but for Server-Sent Events. The client (ChatPanel) falls
 * back to the buffered /api/chat if this stream errors, so the storefront keeps
 * working even if streaming is unavailable.
 */
import { resolveTenant } from '../../../../lib/tenant';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: Request) {
  const body = await req.json();
  // Multi-storefront routing: ?project → X-Tenant-ID header → Host domain → env.
  const tenantId = await resolveTenant(req);
  const authHeader = req.headers.get('authorization');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-ID': tenantId,
  };
  if (authHeader) headers['Authorization'] = authHeader;

  try {
    const upstream = await fetch(`${GATEWAY_URL}/api/v1/${tenantId}/commerce/chat/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, tenantId }),
    });

    if (!upstream.ok || !upstream.body) {
      // P0-05: surface rate-limit/oversize rejections with their real status +
      // body so the client falls back to the buffered path and renders the
      // graceful "slow down" message (rather than masking it as a 502).
      if (upstream.status === 429 || upstream.status === 413) {
        return new Response(await upstream.text(), {
          status: upstream.status,
          headers: { 'Content-Type': 'application/json', 'Retry-After': upstream.headers.get('retry-after') || '5' },
        });
      }
      return new Response(JSON.stringify({ error: `Gateway returned ${upstream.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Pipe the SSE stream straight through to the browser.
    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
