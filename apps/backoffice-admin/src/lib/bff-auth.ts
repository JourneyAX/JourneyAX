/**
 * BFF auth cookie helpers (P0-02 R4).
 *
 * The back-office access + refresh tokens live ONLY in HttpOnly cookies — never
 * in JS-reachable storage — so an XSS payload can't exfiltrate them. These
 * helpers are runtime-agnostic (work in both node route handlers and the edge
 * middleware): reads parse the Cookie header / atob-decode the JWT expiry; writes
 * go through NextResponse.cookies.
 */
import type { NextResponse } from 'next/server';

export const COOKIE_AT = 'jax_at'; // access token  (short-lived JWT, 15m)
export const COOKIE_RT = 'jax_rt'; // refresh token (7d, rotating)

const IS_PROD = process.env.NODE_ENV === 'production';
const SEVEN_DAYS = 60 * 60 * 24 * 7;

/** Cookie options — HttpOnly always; Secure only in prod (localhost is http). */
function opts(maxAge: number) {
  return { httpOnly: true, secure: IS_PROD, sameSite: 'lax' as const, path: '/', maxAge };
}

export function setAuthCookies(res: NextResponse, accessToken: string, refreshToken: string): void {
  // The access COOKIE persists for the session window; the JWT inside expires in
  // 15m and middleware transparently refreshes it. The refresh cookie is 7d.
  res.cookies.set(COOKIE_AT, accessToken, opts(SEVEN_DAYS));
  res.cookies.set(COOKIE_RT, refreshToken, opts(SEVEN_DAYS));
}

export function clearAuthCookies(res: NextResponse): void {
  res.cookies.set(COOKIE_AT, '', opts(0));
  res.cookies.set(COOKIE_RT, '', opts(0));
}

/** Parse a single cookie value out of a raw Cookie header (route-handler side). */
export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
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

/** atob that works in both edge (global atob) and node runtimes. */
function atobUniversal(b64: string): string {
  if (typeof atob === 'function') return atob(b64);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).Buffer.from(b64, 'base64').toString('binary');
}
