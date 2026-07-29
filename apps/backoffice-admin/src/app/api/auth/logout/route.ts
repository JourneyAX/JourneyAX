/**
 * BFF logout (P0-02 R4). Revokes the refresh token at auth-service and clears the
 * HttpOnly auth cookies.
 */
import { NextResponse } from 'next/server';
import { readCookie, clearAuthCookies, COOKIE_RT } from '../../../../lib/bff-auth';

const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.NEXT_PUBLIC_AUTH_API || 'http://localhost:8080';

export async function POST(req: Request) {
  const refreshToken = readCookie(req, COOKIE_RT);
  if (refreshToken) {
    try {
      await fetch(`${AUTH_URL}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* best-effort revoke */ }
  }
  const out = NextResponse.json({ success: true });
  clearAuthCookies(out);
  return out;
}
