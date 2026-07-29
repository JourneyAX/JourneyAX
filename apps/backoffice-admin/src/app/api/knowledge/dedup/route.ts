import { NextRequest, NextResponse } from 'next/server';
import { documentsCollection } from '../../../../lib/mongo-server';
import { requireAuth, scopeTenant } from '../../../../lib/require-auth';

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
    const col = await documentsCollection();
    const brandFilter = { $or: [{ brand }, { 'metadata.brand': brand }] };

    const groups = await col.aggregate([
      { $match: brandFilter },
      {
        $group: {
          _id: { u: '$sourceUrl', c: '$chunkIndex', t: '$metadata.type' },
          n: { $sum: 1 },
          docs: { $push: { id: '$_id', when: { $ifNull: ['$updatedAt', '$crawledAt'] } } },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ]).toArray();

    const toDelete: any[] = [];
    for (const g of groups as any[]) {
      // keep the newest, delete the rest
      const sorted = [...g.docs].sort((a, b) => new Date(b.when || 0).getTime() - new Date(a.when || 0).getTime());
      sorted.slice(1).forEach((d) => toDelete.push(d.id));
    }

    let removed = 0;
    if (toDelete.length) {
      const res = await col.deleteMany({ _id: { $in: toDelete } });
      removed = res.deletedCount || 0;
    }

    return NextResponse.json({ brand, duplicateGroups: groups.length, removed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
