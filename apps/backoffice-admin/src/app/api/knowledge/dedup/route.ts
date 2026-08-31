import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, scopeTenant } from '../../../../lib/require-auth';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

/**
 * POST /api/knowledge/dedup  { brand: "caroma" }
 * Collapses genuine duplicate chunks — same (sourceUrl, chunkIndex, metadata.type)
 * appearing more than once (from earlier re-ingest runs) — keeping the newest by
 * updatedAt/crawledAt. Cross-type rows (a product's text vs its PDF chunk sharing
 * an index) are NOT touched; they're legitimately different content.
 */
export async function POST(req: NextRequest) {
  // Destructive → requires knowledge.delete. Tenant from identity, not the body.
  const auth = await requireAuth(req, 'knowledge.delete');
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
  let requested = '';
  try {
    const body = await req.json();
    requested = body?.brand || '';
  } catch { /* no body */ }
  const brand = (scopeTenant(auth.identity, requested) || '').toLowerCase();
  if (!brand) return NextResponse.json({ error: 'brand is required' }, { status: 400 });

  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${brand}/products/maintenance`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${auth.token}`,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ op: 'dedupe-knowledge', dryRun: false })
    });
    
    if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
    const data = await res.json();
    return NextResponse.json({ brand, duplicateGroups: data.details?.duplicateGroups || 0, removed: data.details?.removed || 0 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
