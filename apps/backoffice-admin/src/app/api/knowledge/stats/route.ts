import { NextRequest, NextResponse } from 'next/server';
import { getOrSet, cacheKey } from '@journeyax/cache';
import { documentsCollection } from '../../../../lib/mongo-server';
import { requireAuth, scopeTenant } from '../../../../lib/require-auth';

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
      () => computeStats(brand), { ttlSeconds: 600, force }));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function computeStats(brand: string) {
  {
    const col = await documentsCollection();
    const brandFilter = { $or: [{ projectId: brand }, { brand }, { 'metadata.brand': brand }] };
    const P = { ...brandFilter, 'metadata.type': 'product' };

    const [total, products, withSpecs, withImage, withPrice, designs, technical, troubleshooting] = await Promise.all([
      col.countDocuments(brandFilter),
      col.countDocuments(P),
      col.countDocuments({ ...P, 'metadata.specs': { $exists: true } }),
      col.countDocuments({ ...P, 'metadata.images.0': { $exists: true } }),
      col.countDocuments({ ...P, 'metadata.price': { $exists: true } }),
      col.countDocuments({ ...brandFilter, 'metadata.type': 'design' }),
      col.countDocuments({ ...brandFilter, 'metadata.type': 'technical' }),
      col.countDocuments({ ...brandFilter, 'metadata.type': 'troubleshooting' }),
    ]);

    // Genuine duplicates: same (sourceUrl, chunkIndex, metadata.type) appearing >1×
    const dupAgg = await col.aggregate([
      { $match: brandFilter },
      { $group: { _id: { u: '$sourceUrl', c: '$chunkIndex', t: '$metadata.type' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $count: 'groups' },
    ]).toArray();

    return {
      brand,
      total,
      products,
      withSpecs,
      withImage,
      withPrice,
      designs,
      technical,
      troubleshooting,
      duplicateGroups: (dupAgg[0] as any)?.groups || 0,
      specsPct: products ? Math.round((withSpecs / products) * 100) : 0,
    };
  }
}
