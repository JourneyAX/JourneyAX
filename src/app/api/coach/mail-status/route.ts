/**
 * Whether SMTP is actually configured and reachable.
 *
 * Broken mail delivery has no other symptom than "the coach never got a
 * code" — nothing in the coach-facing flow can tell them that's the cause.
 * This exists so it can be checked directly, from a terminal or an uptime
 * monitor, without waiting for a coach to report a problem.
 *
 * Dev-only: mail configuration is operational detail nobody outside the team
 * should be able to probe.
 */

import { verifyMailer, mailerStatus } from '@/lib/coach/mailer';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'not available in production' }, { status: 404 });
  }

  const status = mailerStatus();
  if (!status.configured) {
    return Response.json({ configured: false, mode: 'dev-preview (SMTP not set)' });
  }

  const check = await verifyMailer();
  return Response.json({
    configured: true,
    mode: 'smtp',
    connectionOk: check.ok,
    error: check.error ?? status.lastError,
  });
}
