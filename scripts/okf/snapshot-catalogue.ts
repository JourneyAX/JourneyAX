/**
 * READ-ONLY. Captures a dated taxonomy snapshot of a tenant's catalogue for the ingestion pipeline.
 *
 *   node --env-file=.env --import tsx scripts/okf/snapshot-catalogue.ts <tenantId> <ingest-config.json> [outDir]
 *
 * Reads `products`, `<tenant>_domain_keywords` and `documents`; writes only a local JSON file. The pipeline itself
 * never talks to the database, so a snapshot is also the reproducible input for tests and reviews.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { connectToDatabase } from '@journeyax/database';
import { IngestConfigSchema, TaxonomySnapshotSchema, classifyDocument, extractSkus } from '../../packages/knowledge/src';

(async () => {
  const [tenantId, configPath, outDirArg] = process.argv.slice(2);
  if (!tenantId || !configPath) throw new Error('usage: snapshot-catalogue.ts <tenantId> <ingest-config.json> [outDir]');
  const config = IngestConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required (read-only use)');
  const dbName = process.env.RUNTIME_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx';
  const { db } = await connectToDatabase(uri, dbName);
  const snapshotAt = new Date().toISOString();
  const owner = { $or: [{ projectId: tenantId }, { tenantId }] };

  const products = db.collection('products');
  const totalProducts = await products.countDocuments(owner);
  const grouped: any[] = await products.aggregate([
    { $match: owner },
    { $group: { _id: { path: '$categoryPath', category: '$category' }, n: { $sum: 1 } } },
  ]).toArray();
  const rows = grouped.map((row) => ({
    path: Array.isArray(row._id.path) ? row._id.path : [],
    ...(row._id.category ? { category: row._id.category } : {}),
    productCount: row.n,
  })).sort((a, b) => b.productCount - a.productCount || JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)));

  const keywordDocs: any[] = await db.collection(`${tenantId}_domain_keywords`).find({}).toArray().catch(() => []);
  const keywordHints = keywordDocs.filter((doc) => Array.isArray(doc.domainKeywords)).map((doc) => ({
    category: doc.category, path: Array.isArray(doc.categoryPath) ? doc.categoryPath : [], keywords: doc.domainKeywords,
    ...(doc.model ? { model: doc.model } : {}), ...(doc.generatedAt ? { generatedAt: new Date(doc.generatedAt).toISOString() } : {}),
  })).filter((hint) => hint.category);

  // Documents: PDFs that name the SKUs they are about, mapped to those products' categories.
  const pdfs: any[] = await db.collection('documents').aggregate([
    { $match: { projectId: tenantId, sourceUrl: { $regex: '^pdf://' } } },
    { $sort: { chunkIndex: 1 } },
    { $group: { _id: '$sourceUrl', chunks: { $sum: 1 }, title: { $first: '$title' }, crawledAt: { $first: '$crawledAt' }, opening: { $first: { $substrCP: [{ $ifNull: ['$content', ''] }, 0, 600] } } } },
  ]).toArray();
  const skusByPdf = new Map<string, string[]>(pdfs.map((pdf) => [pdf._id, extractSkus(pdf.opening || '', pdf.title || '')]));
  const allSkus = [...new Set([...skusByPdf.values()].flat())];
  const productBySku = new Map<string, { category?: string; path: string[] }>();
  for (let i = 0; i < allSkus.length; i += 1000) {
    const batch = allSkus.slice(i, i + 1000);
    const found: any[] = await products.find({ $and: [owner, { $or: [{ sku: { $in: batch } }, { parentSku: { $in: batch } }] }] }, { projection: { sku: 1, parentSku: 1, category: 1, categoryPath: 1 } }).toArray();
    for (const product of found) for (const id of [product.sku, product.parentSku].filter(Boolean)) {
      productBySku.set(String(id), { category: product.category, path: Array.isArray(product.categoryPath) ? product.categoryPath : [] });
    }
  }
  const kindRank = new Map(config.documents.kinds.map((rule, index) => [rule.kind, index] as const));
  const byKind: Record<string, number> = {};
  let mapped = 0;
  const perCategory = new Map<string, any[]>();
  for (const pdf of pdfs) {
    const kind = classifyDocument(pdf.title || '', pdf.opening || '', config.documents.kinds);
    byKind[kind] = (byKind[kind] || 0) + 1;
    const skus = skusByPdf.get(pdf._id) || [];
    const hit = skus.map((sku) => ({ sku, product: productBySku.get(sku) })).find((entry) => entry.product?.category);
    if (!hit?.product) continue;
    mapped++;
    const key = JSON.stringify([hit.product.path, hit.product.category]);
    const list = perCategory.get(key) || [];
    list.push({
      category: hit.product.category, path: hit.product.path, sourceUrl: pdf._id, title: String(pdf.title || '').slice(0, 300), kind,
      chunkCount: pdf.chunks, sku: hit.sku, ...(pdf.crawledAt ? { crawledAt: new Date(pdf.crawledAt).toISOString() } : {}),
    });
    perCategory.set(key, list);
  }
  const documentCandidates = [...perCategory.values()].flatMap((list) => list
    .sort((a, b) => (kindRank.get(a.kind) ?? 99) - (kindRank.get(b.kind) ?? 99) || b.chunkCount - a.chunkCount || (a.sourceUrl < b.sourceUrl ? -1 : 1))
    .slice(0, config.documents.maxCandidatesPerCategory));

  const snapshot = TaxonomySnapshotSchema.parse({
    tenantId, snapshotAt, source: `${dbName}.products / ${dbName}.documents / ${dbName}.${tenantId}_domain_keywords`,
    totalProducts, rows, keywordHints, documentCandidates,
    documentTotals: { documents: pdfs.length, mappedToProduct: mapped, byKind },
  });
  const outDir = path.resolve(outDirArg || path.join(__dirname, '../../docs/inventory'));
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${tenantId}-taxonomy-snapshot-${snapshotAt.slice(0, 10)}.json`);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(JSON.stringify({ file: path.relative(process.cwd(), file), rows: rows.length, totalProducts, keywordHints: keywordHints.length, pdfs: pdfs.length, mappedToProduct: mapped, candidates: documentCandidates.length, byKind }));
  process.exit(0);
})().catch((error) => { console.error('ERR', error.message); process.exit(1); });
