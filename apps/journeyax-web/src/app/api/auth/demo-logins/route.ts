/**
 * GET /api/auth/demo-logins: who the demo sign-in screen may offer (name, a line about them, their group). No e-mail, no password.
 * Empty unless the web server was started with DEMO_LOGINS_FILE (a demo); see lib/auth/demoLogins.ts.
 */
import { NextResponse } from 'next/server';
import { demoLoginsEnv, loadDemoLogins, publicView } from '../../../../lib/auth/demoLogins';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ logins: publicView(loadDemoLogins(demoLoginsEnv())) }, { headers: { 'Cache-Control': 'no-store' } });
}
