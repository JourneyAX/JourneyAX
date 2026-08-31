import { NextRequest, NextResponse } from 'next/server';
import { getOrSet, cacheKey } from '@journeyax/cache';
import { requireAuth, scopeTenant } from '../../../../lib/require-auth';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

/**
 * GET /api/knowledge/stats?brand=caroma
 * Real completeness stats for a tenant's scraped knowledge base
 * (journeyx.documents), plus a count of genuine duplicate groups.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'knowledge.read');
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
  const brand = (scopeTenant(auth.identity, req.nextUrl.searchParams.get('brand')) || '').toLowerCase();
  if (!brand) return NextResponse.json({ error: 'brand is required' }, { status: 400 });

  /* Nine counts and a grouping aggregation over the whole corpus — measured at
   * 1.5-2.9s, and re-run every time the Knowledge tab is opened. It only moves
   * when an ingest writes documents, so it is cached and dropped on ingest. */
  const force = req.nextUrl.searchParams.get('refresh') === '1';
  try {
    return NextResponse.json(await getOrSet(cacheKey(brand, 'knowledge-stats'),
      async () => {
        const res = await fetch(`${GATEWAY_URL}/api/v1/${brand}/products/stats`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
        return res.json();
      }, { ttlSeconds: 600, force }));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

