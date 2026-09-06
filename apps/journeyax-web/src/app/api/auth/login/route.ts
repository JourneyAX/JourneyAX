/**
 * Storefront BFF login. Proxies to auth-service via the gateway, then sets the
 * access + refresh tokens as HttpOnly cookies. The browser NEVER sees the
 * tokens — only the non-sensitive profile comes back for display.
 */
import { NextResponse } from 'next/server';
import { setAuthCookies } from '../../../../lib/bff-auth';
import { resolveTenant } from '../../../../lib/tenant';

const AUTH_URL = process.env.GATEWAY_URL || process.env.AUTH_SERVICE_URL || 'http://localhost:3010';

export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: 'Bad request.' }, { status: 400 });
  }
  if (!body.email || !body.password) {
    return NextResponse.json({ success: false, message: 'Email and password are required.' }, { status: 400 });
  }

  // Resolve the storefront tenant for logging/scoping context, but do NOT pin
  // the login to it: auth-service matches by email and the issued token carries
  // the user's real tenantId + role. The gateway then enforces access — a
  // platform admin (tenant "platform", e.g. the seeded admin/admin) may act on
  // any project; a tenant customer only on their own. Pinning here rejected the
  // platform admin with "Email not registered under this tenant."
  const tenantId = await resolveTenant(req);
  try {
    const res = await fetch(`${AUTH_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId },
      body: JSON.stringify({ email: body.email, password: body.password }),
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
