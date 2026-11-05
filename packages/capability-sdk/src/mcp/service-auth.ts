import { GoogleAuth } from 'google-auth-library';

/** Cloud Run IAM is additional to tenant-scoped application authentication.
 * https://docs.cloud.google.com/run/docs/authenticating/service-to-service
 */
export function createCloudServiceHeaders(options: { token?: (audience: string) => Promise<string>; env?: () => NodeJS.ProcessEnv } = {}) {
  const auth = new GoogleAuth();
  const clients = new Map<string, Promise<import('google-auth-library').IdTokenClient>>();
  return async (target: string): Promise<Record<string, string>> => {
    const url = new URL(target);
    if (!url.hostname.endsWith('.run.app')) return {};
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Private hosted service requires a secure service origin.');
    const env = options.env?.() ?? process.env;
    if (env.DISABLE_GCP_AUTH === 'true') {
      if (env.NODE_ENV === 'production') throw new Error('Hosted service identity cannot be disabled in production.');
      return {};
    }
    const audience = url.origin;
    let bearer: string;
    if (options.token) bearer = `Bearer ${await options.token(audience)}`;
    else {
      if (!clients.has(audience)) {
        if (clients.size >= 64) clients.delete(clients.keys().next().value!);
        clients.set(audience, auth.getIdTokenClient(audience));
      }
      try {
        const client = await clients.get(audience)!;
        const headers = await client.getRequestHeaders();
        bearer = typeof (headers as any).get === 'function' ? (headers as any).get('authorization') : (headers as any).Authorization || (headers as any).authorization;
      } catch { clients.delete(audience); throw new Error('Private hosted service identity is unavailable.'); }
    }
    if (!/^Bearer [A-Za-z0-9._~-]{10,}$/.test(bearer!)) throw new Error('Private hosted service returned no usable identity.');
    // Leave Authorization available for the connection's own API key.
    return { 'X-Serverless-Authorization': bearer! };
  };
}

export const cloudServiceHeaders = createCloudServiceHeaders();
