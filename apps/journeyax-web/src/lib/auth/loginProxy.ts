/**
 * The storefront's sign-in, shared by the login form and the demo persona buttons: ask the auth service, and on success set the access and
 * refresh tokens as HttpOnly cookies. The browser never sees a token, only the person's name and role.
 */
import { NextResponse } from 'next/server';
import { setAuthCookies } from '../bff-auth';
import { resolveTenant } from '../tenant';

const AUTH_URL = () => process.env.GATEWAY_URL || process.env.AUTH_SERVICE_URL || 'http://localhost:3010';

export async function signInAndSetCookies(req: Request, email: string, password: string): Promise<NextResponse> {
  // The login is not pinned to the storefront's tenant: the auth service matches by e-mail and the token carries the person's own tenant
  // and role, and the gateway then enforces access (a platform admin may act on any project; a tenant customer only on their own).
  const tenantId = await resolveTenant(req);
  try {
    const res = await fetch(`${AUTH_URL()}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success || !data.tokens) {
      return NextResponse.json({ success: false, message: data.message || 'Invalid email or password.' }, { status: 401 });
    }
    const out = NextResponse.json({ success: true, user: data.user });
    setAuthCookies(out, data.tokens.accessToken, data.tokens.refreshToken);
    return out;
  } catch (e: any) {
    return NextResponse.json({ success: false, message: `Could not reach the sign-in service (${e.message}).` }, { status: 503 });
  }
}
