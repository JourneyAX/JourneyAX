import { NextRequest, NextResponse } from 'next/server';
import { knowledgeDb } from '../../../../lib/mongo-server';
import { requireAuth, scopeTenant } from '../../../../lib/require-auth';

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
    const db = await knowledgeDb();
    const doc = await db.collection('ingest_reconciliation').findOne({
      projectId: brand,
      kind: 'catalogue-codes-missing-from-feed',
    });
    const rels = db.collection('collections');
    const [collections, sizingGroups, outfittingSets] = await Promise.all([
      rels.countDocuments({ projectId: brand, kind: 'collection' }),
      rels.countDocuments({ projectId: brand, kind: 'sizing-group' }),
      rels.countDocuments({ projectId: brand, kind: 'outfitting-set' }),
    ]);

    // The brand hub is what the agent is actually told about this business every
    // turn, so an operator should be able to read exactly that text.
    const hub = await db.collection('brand_hub').findOne({ projectId: brand }, { projection: { _id: 0 } });

    return NextResponse.json({
      brand,
      hub: hub || null,
      relationships: { collections, sizingGroups, outfittingSets },
      missing: doc
        ? {
            distinctCodes: doc.distinctCodes ?? 0,
            totalReferences: doc.totalReferences ?? 0,
            codes: (doc.codes || []).slice(0, 100),
            updatedAt: doc.updatedAt ?? null,
          }
        : null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
