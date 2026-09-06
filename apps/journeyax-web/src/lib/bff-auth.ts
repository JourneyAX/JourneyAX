/**
 * Storefront BFF auth cookie helpers — the same R4 model the back-office uses.
 *
 * The access + refresh tokens live ONLY in HttpOnly cookies, never in
 * JS-reachable storage (the previous storefront AuthContext kept them in
 * localStorage — the exact "are the tokens going up gracefully?" worry). Route
 * handlers read the access cookie and forward it upstream as a Bearer token,
 * so the gateway sees a real authenticated user instead of an anonymous guest.
 */
import type { NextResponse } from 'next/server';

export const COOKIE_AT = 'jxs_at'; // access token  (short-lived JWT)
export const COOKIE_RT = 'jxs_rt'; // refresh token (7d, rotating)

const IS_PROD = process.env.NODE_ENV === 'production';
const SEVEN_DAYS = 60 * 60 * 24 * 7;

/**
 * Anonymous access is OFF for the storefront until the token path is proven
 * end to end. Flip with STOREFRONT_ALLOW_ANONYMOUS=true only when that's
 * deliberately wanted (e.g. a public brand showroom).
 */
export const REQUIRE_AUTH = process.env.STOREFRONT_ALLOW_ANONYMOUS !== 'true';

function opts(maxAge: number) {
  return { httpOnly: true, secure: IS_PROD, sameSite: 'lax' as const, path: '/', maxAge };
}

export function setAuthCookies(res: NextResponse, accessToken: string, refreshToken: string): void {
  res.cookies.set(COOKIE_AT, accessToken, opts(SEVEN_DAYS));
  res.cookies.set(COOKIE_RT, refreshToken, opts(SEVEN_DAYS));
}

export function clearAuthCookies(res: NextResponse): void {
  res.cookies.set(COOKIE_AT, '', opts(0));
  res.cookies.set(COOKIE_RT, '', opts(0));
}

/** Parse a single cookie value out of a raw Cookie header. */
export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Headers to forward to the gateway on behalf of the signed-in customer.
 * Returns `null` when auth is required and there is no session — callers
 * respond 401 instead of silently falling through as a guest.
 */
export function upstreamAuthHeaders(req: Request): Record<string, string> | null {
  const token = readCookie(req, COOKIE_AT);
  if (token) return { Authorization: `Bearer ${token}` };
  return REQUIRE_AUTH ? null : {};
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Please sign in to continue.' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Seconds-until-expiry for a JWT, WITHOUT verifying the signature (cheap, local). */
export function jwtSecondsLeft(token: string | undefined): number {
  if (!token) return 0;
  try {
    const seg = token.split('.')[1];
    const json = JSON.parse(atobUniversal(seg.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof json.exp !== 'number') return 0;
    return json.exp - Math.floor(Date.now() / 1000);
  } catch {
    return 0;
  }
}

function atobUniversal(b64: string): string {
  if (typeof atob === 'function') return atob(b64);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).Buffer.from(b64, 'base64').toString('binary');
}
