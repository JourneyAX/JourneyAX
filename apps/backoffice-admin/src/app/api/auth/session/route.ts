/**
 * BFF session (P0-02 R4). Returns the current user's profile if the HttpOnly
 * access cookie is valid — lets the SPA restore its session on load WITHOUT ever
 * exposing a token to JS. Middleware has already refreshed a near-expiry access
 * cookie before this runs.
 */
import { NextResponse } from 'next/server';
import { readCookie, COOKIE_AT } from '../../../../lib/bff-auth';

const AUTH_URL = process.env.GATEWAY_URL || process.env.AUTH_SERVICE_URL || 'http://localhost:3010';

export async function GET(req: Request) {
  const token = readCookie(req, COOKIE_AT);
  if (!token) return NextResponse.json({ authenticated: false }, { status: 401 });
  try {
    const res = await fetch(`${AUTH_URL}/api/v1/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return NextResponse.json({ authenticated: false }, { status: 401 });
    const { valid, payload } = await res.json();
    if (!valid || !payload) return NextResponse.json({ authenticated: false }, { status: 401 });
    return NextResponse.json({
      authenticated: true,
      user: { email: payload.sub, fullName: payload.fullName, role: payload.role, tenantId: payload.tenantId },
    });
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 503 });
  }
}
