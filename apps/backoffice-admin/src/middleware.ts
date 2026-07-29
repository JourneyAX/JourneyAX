/**
 * Transparent token refresh (P0-02 R4). The access JWT lives 15m; the refresh
 * token 7d. Rather than let the session die every 15 minutes (or push refresh
 * logic into the client, which would need JS-readable tokens), this edge
 * middleware silently rotates a near-expiry access cookie before the API route
 * runs — using the HttpOnly refresh cookie the browser sends automatically.
 *
 * It only calls auth-service when the access token is actually within 60s of
 * expiry (a cheap local exp decode gates it), so steady-state requests pay
 * nothing. On refresh it updates BOTH the forwarded request (so the handler sees
 * the fresh token this same request) and the response cookies (so the browser
 * gets the rotated pair).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_AT, COOKIE_RT, jwtSecondsLeft } from './lib/bff-auth';

const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.NEXT_PUBLIC_AUTH_API || 'http://localhost:8080';
const IS_PROD = process.env.NODE_ENV === 'production';
const SEVEN_DAYS = 60 * 60 * 24 * 7;

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // login/logout don't require a valid access token.
  if (pathname.startsWith('/api/auth/login') || pathname.startsWith('/api/auth/logout')) {
    return NextResponse.next();
  }

  const at = req.cookies.get(COOKIE_AT)?.value;
  const rt = req.cookies.get(COOKIE_RT)?.value;

  if (jwtSecondsLeft(at) > 60) return NextResponse.next(); // still comfortably valid
  if (!rt) return NextResponse.next();                     // nothing to refresh → route will 401

  try {
    const res = await fetch(`${AUTH_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return NextResponse.next();
    const data = await res.json();
    const tokens = data?.tokens;
    if (!tokens?.accessToken) return NextResponse.next();

    const newAt = tokens.accessToken as string;
    const newRt = (tokens.refreshToken as string) || rt;

    // Rewrite the cookie the HANDLER sees on this same request…
    const cookieHeader = (req.headers.get('cookie') || '')
      .split(';').map((s) => s.trim()).filter(Boolean)
      .filter((c) => !c.startsWith(`${COOKIE_AT}=`) && !c.startsWith(`${COOKIE_RT}=`));
    cookieHeader.push(`${COOKIE_AT}=${newAt}`, `${COOKIE_RT}=${newRt}`);
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set('cookie', cookieHeader.join('; '));

    // …and set the rotated pair back on the browser.
    const out = NextResponse.next({ request: { headers: reqHeaders } });
    const opts = { httpOnly: true, secure: IS_PROD, sameSite: 'lax' as const, path: '/', maxAge: SEVEN_DAYS };
    out.cookies.set(COOKIE_AT, newAt, opts);
    out.cookies.set(COOKIE_RT, newRt, opts);
    return out;
  } catch {
    return NextResponse.next();
  }
}

// Only run on the back-office API surface.
export const config = { matcher: ['/api/:path*'] };
