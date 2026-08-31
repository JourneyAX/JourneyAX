import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, scopeTenant } from '../../../../lib/require-auth';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

/**
 * GET /api/knowledge/reconciliation?brand=augusta
 *
 * Catalogue-vs-feed drift found during ingestion: style codes the catalogue
 * genuinely references but which have no product record, so they were excluded
 * from the relationship graph (we cannot recommend something unbuyable). Ranked
 * by how often each code appears, so the most-referenced gaps surface first.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'knowledge.read');
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
  const brand = (scopeTenant(auth.identity, req.nextUrl.searchParams.get('brand')) || '').toLowerCase();
  if (!brand) return NextResponse.json({ error: 'brand is required' }, { status: 400 });

  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${brand}/products/reconciliation`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    
    if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

