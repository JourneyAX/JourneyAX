/**
 * Who is signed in, if anyone.
 *
 * Uses `resolveReorderViewer` rather than reading the coach cookie directly,
 * so this answer and the one `/api/reorder-orders` acts on can never disagree.
 * They did briefly: this route knew only about coach sessions, so with
 * REORDER_DEMO_MODE on the data API served records while the page gate still
 * said "signed out" — a locked door in front of an open window.
 *
 * 200 with `authenticated: false` rather than a 401 — "not signed in" is a
 * normal answer to this question, not an error.
 */

import { resolveReorderViewer } from '@/lib/reorder-authorization';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const viewer = resolveReorderViewer(req);
  if (!viewer) return Response.json({ authenticated: false });

  return Response.json({
    authenticated: true,
    name: viewer.name,
    role: viewer.role,
    schools: viewer.schools,
    // 'coach-link' means they came through the emailed link and code.
    // 'local-demo' means the access check is bypassed for demonstration.
    via: viewer.source,
  });
}
