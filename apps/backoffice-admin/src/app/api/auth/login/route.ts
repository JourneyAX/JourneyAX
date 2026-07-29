/**
 * BFF login (P0-02 R4). Proxies to auth-service, then sets the access + refresh
 * tokens as HttpOnly cookies. The browser NEVER sees the tokens — only the
 * non-sensitive user profile is returned for display.
 */
import { NextResponse } from 'next/server';
import { setAuthCookies } from '../../../../lib/bff-auth';

const AUTH_URL = process.env.AUTH_SERVICE_URL || process.env.NEXT_PUBLIC_AUTH_API || 'http://localhost:8080';

export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: 'Bad request.' }, { status: 400 });
  }

  try {
    const res = await fetch(`${AUTH_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.email, password: body.password }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.tokens) {
      return NextResponse.json({ success: false, message: data.message || 'Invalid email or password.' }, { status: 401 });
    }
    // Return ONLY the profile; tokens go into HttpOnly cookies.
    const out = NextResponse.json({ success: true, user: data.user });
    setAuthCookies(out, data.tokens.accessToken, data.tokens.refreshToken);
    return out;
  } catch (e: any) {
    return NextResponse.json({ success: false, message: `Could not reach auth-service (${e.message}).` }, { status: 503 });
  }
}
