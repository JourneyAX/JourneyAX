/**
 * POST /api/auth/demo-login { id }: signs in as one of the demo personas. The server looks the id up in the private demo file and signs in
 * with that person's own e-mail and password through the normal sign-in; nothing the browser sends can name an e-mail or a password.
 * Refused (404) when there is no demo file, so a real shop never offers it.
 */
import { NextResponse } from 'next/server';
import { demoLoginsEnv, findDemoLogin, loadDemoLogins } from '../../../../lib/auth/demoLogins';
import { signInAndSetCookies } from '../../../../lib/auth/loginProxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const logins = loadDemoLogins(demoLoginsEnv());
  if (logins.length === 0) return NextResponse.json({ success: false, message: 'Demo sign-ins are not switched on here.' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const login = findDemoLogin(logins, (body as { id?: unknown })?.id);
  if (!login) return NextResponse.json({ success: false, message: 'That demo person does not exist.' }, { status: 404 });
  return signInAndSetCookies(req, login.email, login.password);
}
