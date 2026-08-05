/**
 * Streaming Chat proxy — forwards the browser's request to the gateway's SSE
 * endpoint and pipes the event stream straight back (no buffering).
 *
 * Mirrors /api/chat but for Server-Sent Events. The client (ChatPanel) falls
 * back to the buffered /api/chat if this stream errors, so the storefront keeps
 * working even if streaming is unavailable.
 */
import { resolveTenant } from '../../../../lib/tenant';

// Vercel streaming contract. Without these, Vercel runs this handler as a
// default Node serverless function with a ~15s wall-clock cap and may buffer the
// piped SSE body — so a long agent turn (retrieval + LLM) is KILLED mid-stream
// and the `uiAction` events that drive the 60% panel never reach the browser
// (the panel freezes / the guided step silently vanishes). Locally there is no
// such cap, which is why it worked before the cloud build and broke after.
//   - force-dynamic : never statically optimise / cache this route
//   - runtime nodejs: keep Node (fetch stream piping), not edge
//   - maxDuration 60: allow the full turn (60s is the Hobby ceiling; raise on Pro)
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

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
