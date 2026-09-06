/**
 * Transparent token refresh for the storefront (same model as the back-office).
 * The access JWT is short-lived; the refresh token lasts 7d. This edge
 * middleware silently rotates a near-expiry access cookie before the API route
 * runs, using the HttpOnly refresh cookie the browser sends automatically — so
 * the session never dies mid-conversation and no token ever reaches JS.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_AT, COOKIE_RT, jwtSecondsLeft } from './lib/bff-auth';

const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:8080';
const IS_PROD = process.env.NODE_ENV === 'production';
const SEVEN_DAYS = 60 * 60 * 24 * 7;

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/auth/login') || pathname.startsWith('/api/auth/logout')) {
    return NextResponse.next();
  }

  const at = req.cookies.get(COOKIE_AT)?.value;
  const rt = req.cookies.get(COOKIE_RT)?.value;

  if (jwtSecondsLeft(at) > 60) return NextResponse.next();
  if (!rt) return NextResponse.next();

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

    const cookieHeader = (req.headers.get('cookie') || '')
      .split(';').map((s) => s.trim()).filter(Boolean)
      .filter((c) => !c.startsWith(`${COOKIE_AT}=`) && !c.startsWith(`${COOKIE_RT}=`));
    cookieHeader.push(`${COOKIE_AT}=${newAt}`, `${COOKIE_RT}=${newRt}`);
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set('cookie', cookieHeader.join('; '));

    const out = NextResponse.next({ request: { headers: reqHeaders } });
    const opts = { httpOnly: true, secure: IS_PROD, sameSite: 'lax' as const, path: '/', maxAge: SEVEN_DAYS };
    out.cookies.set(COOKIE_AT, newAt, opts);
    out.cookies.set(COOKIE_RT, newRt, opts);
    return out;
  } catch {
    return NextResponse.next();
  }
}

export const config = { matcher: ['/api/:path*'] };
