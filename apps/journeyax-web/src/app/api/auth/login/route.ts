/**
 * Storefront BFF login. Proxies to auth-service via the gateway, then sets the
 * access + refresh tokens as HttpOnly cookies. The browser NEVER sees the
 * tokens — only the non-sensitive profile comes back for display.
 */
import { NextResponse } from 'next/server';
import { signInAndSetCookies } from '../../../../lib/auth/loginProxy';

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

  return signInAndSetCookies(req, body.email, body.password);
}
