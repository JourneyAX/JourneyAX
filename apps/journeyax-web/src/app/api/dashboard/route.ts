/**
 * The corner tile and dashboard of the signed-in person, for the chat: a thin proxy to the gateway, which signs who the person is (role and
 * staff groups). The figures are worked out on the server from the shop's pack and read through the same connector gate the assistant uses, so
 * the browser says nothing about who it is or what it may see. Any failure, a shopper, or a team with no dashboard gives an empty answer, and
 * the page simply shows no tile.
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
    const resp = await fetch(`${gatewayUrl()}/api/v1/${tenantId}/commerce/dashboard`, {
      headers: { 'X-Tenant-ID': tenantId, ...auth },
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    const data: any = resp.ok ? await resp.json().catch(() => ({})) : {};
    return Response.json(data?.dashboard && typeof data.dashboard === 'object' ? { dashboard: data.dashboard } : {});
  } catch {
    return Response.json({});
  }
}
