import { MemoryDb } from '@journeyax/test-support';
import { loadPinnedOkfRelease } from '@journeyax/knowledge';
import { resolveCatalogMapping, normalizeCatalogProduct } from '@journeyax/business-pack';

export interface EvaluationStorageRequest { projectId: string; businessPack: any }

/** Local answer checks use the actual public source values in a private in-memory store.
 * This does not certify MongoDB behaviour or permit live business operations.
 */
export async function createPublicEvaluationStorage(sourceDb: any, { projectId, businessPack }: EvaluationStorageRequest) {
  const candidate = businessPack;
  if (candidate.manifest?.tenantId !== projectId || !['dev', 'test'].includes(candidate.manifest?.environmentId)) throw new Error('Public-source memory evaluation requires an explicit non-production candidate and tenant.');
  const requested: string[] = [...new Set<string>((candidate.evaluations ?? []).flatMap((suite: any) => suite.sourceFixtures?.productSkus ?? []))];
  if (!requested.length || requested.length > 100 || requested.some(sku => typeof sku !== 'string' || !sku || sku.length > 120 || /[\u0000-\u001f\u007f]/.test(sku))) throw new Error('Declare a bounded public catalogue fixture set for evaluation.');
  const mapping = resolveCatalogMapping(candidate.catalogMapping);
  const products = await sourceDb.collection('products').find({ $and: [{ $or: mapping.tenantFields.map(field => ({ [field]: projectId })) }, { $or: mapping.identifierPaths.map(path => ({ [path]: { $in: requested } })) }] }, { projection: { _id: 0 } }).limit(100).toArray();
  const clean = products.filter((product: any) => {
    const owners = mapping.tenantFields.map(field => product[field]).filter((value: unknown) => typeof value === 'string' && value);
    return owners.length > 0 && owners.every((owner: string) => owner === projectId);
  });
  const skus = clean.map((product: any) => normalizeCatalogProduct(product, mapping, { title: '', category: '' }).sku);
  if (requested.some(sku => !skus.includes(sku))) throw new Error('A required public catalogue fixture is missing or has conflicting ownership.');
  const db = new MemoryDb({ transactional: true });
  if (clean.length) await db.collection('products').insertMany(structuredClone(clean));
  const guides = await sourceDb.collection('product_guides').find({ tenantId: projectId, skus: { $in: skus } }, { projection: { _id: 0 } }).limit(100).toArray();
  if (guides.length) await db.collection('product_guides').insertMany(structuredClone(guides));
  if (candidate.knowledgeModel?.type === 'okf_release') {
    const knowledge = await loadPinnedOkfRelease(sourceDb, { tenantId: projectId, environmentId: candidate.manifest.environmentId, ...candidate.knowledgeModel });
    if (knowledge.activeRevocations.length) throw new Error('This memory snapshot cannot omit active knowledge revocations. Configure an isolated store that includes their verified history.');
    // Same immutable content/checksum, isolated namespace. No verification is fabricated.
    await db.collection('okf_releases').insertOne({ ...structuredClone(knowledge.release), environmentId: 'test' });
  }
  return { db, client: db.client, cleanup: () => {}, fixtureSummary: { publicProducts: clean.length, publicGuides: guides.length, customerRecords: 0, storage: 'isolated_memory' } };
}
