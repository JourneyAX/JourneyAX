import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/require-auth';
import { probeBrand } from '../../../../lib/brand-probe';

/**
 * POST /api/onboarding/probe { url }
 *
 * Reads a prospective customer's site and returns what it declares about
 * itself — name, logo, theme colour, catalogue entry point — as SUGGESTIONS for
 * the onboarding form. Nothing is persisted here; the operator confirms or edits
 * every field before a project is created.
 *
 * Requires `user.manage` (the same permission as creating a project) because it
 * makes the server fetch an operator-supplied URL.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'user.manage');
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const raw = String(body?.url || '').trim();
  if (!raw) return NextResponse.json({ error: 'url is required' }, { status: 400 });

  // Only public http(s) origins: this endpoint makes the server fetch a
  // caller-supplied URL, so refuse schemes and hosts that could be used to reach
  // internal services (SSRF).
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return NextResponse.json({ error: 'That does not look like a valid URL.' }, { status: 400 });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return NextResponse.json({ error: 'Only http and https URLs are supported.' }, { status: 400 });
  }
  const host = parsed.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
    /^0\./.test(host) || !host.includes('.');
  if (isPrivate) {
    return NextResponse.json({ error: 'That host is not publicly reachable.' }, { status: 400 });
  }

  try {
    return NextResponse.json(await probeBrand(parsed.toString()));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
