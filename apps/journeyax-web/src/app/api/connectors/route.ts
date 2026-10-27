/**
 * The connectors the signed-in person may use, for the chat's "+" menu: a thin proxy to the gateway, which signs who the person is
 * (role and staff groups) so the answer is what the assistant would be allowed to use for them. The browser says nothing about roles.
 * Any failure gives an empty list, so the menu simply has no connector section instead of an error.
 */
import { resolveServiceUrl } from '@journeyax/shared-types';
import { resolveTenant } from '../../../lib/tenant';
import { upstreamAuthHeaders, unauthorized } from '../../../lib/bff-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const gatewayUrl = () => resolveServiceUrl('GATEWAY_URL', process.env.GATEWAY_URL, 'http://localhost:3010');

export async function GET(req: Request) {
  const tenantId = await resolveTenant(req);
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  try {
    const resp = await fetch(`${gatewayUrl()}/api/v1/${tenantId}/commerce/connectors`, {
      headers: { 'X-Tenant-ID': tenantId, ...auth },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const data: any = resp.ok ? await resp.json().catch(() => ({})) : {};
    return Response.json({
      connectors: Array.isArray(data?.connectors) ? data.connectors : [],
      // What the empty chat says to this person, from the pack; the page uses it when it is there.
      ...(data?.welcome && typeof data.welcome === 'object' ? { welcome: data.welcome } : {}),
    });
  } catch {
    return Response.json({ connectors: [] });
  }
}
