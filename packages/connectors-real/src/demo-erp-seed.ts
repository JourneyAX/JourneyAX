import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DEMO_ERP_COLLECTIONS } from './connectors/mongo-demo-erp';

const RecordSchema = z.record(z.string().min(1).max(80), z.unknown());
export const DemoErpDatasetSchema = z.object({
  datasetId: z.string().regex(/^demo-[a-z0-9][a-z0-9-]{0,63}$/),
  tenantId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  environmentId: z.enum(['dev', 'test', 'staging']),
  source: z.literal('journeyax-demo-erp'),
  records: z.object({
    accounts: z.array(RecordSchema).max(500), orders: z.array(RecordSchema).max(500), invoices: z.array(RecordSchema).max(500),
    deliveries: z.array(RecordSchema).max(500), stock: z.array(RecordSchema).max(500), prices: z.array(RecordSchema).max(500),
  }).strict(),
}).strict();
export type DemoErpDataset = z.infer<typeof DemoErpDatasetSchema>;
export interface DemoErpSeedRow { collection: string; document: Record<string, any> }
const ID_FIELDS = { accounts: 'accountId', orders: 'orderId', invoices: 'invoiceId', deliveries: 'deliveryId', stock: 'stockId', prices: 'priceId' } as const;
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function assertSafeRecord(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error('Demo record nesting exceeds its limit.');
  if (typeof value === 'string' && /-----BEGIN|\bBearer\s+\S+|\bsk_(?:live|test)_/i.test(value)) throw new Error('Credentials cannot be seeded into ERP records.');
  if (Array.isArray(value)) { if (value.length > 100) throw new Error('Demo list exceeds its limit.'); for (const item of value) assertSafeRecord(item, depth + 1); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype', '_id', 'tenantId', 'environmentId', 'synthetic', 'contentHash', 'source', 'datasetId'].includes(key) || /password|secret|token|api.?key/i.test(key)) throw new Error('A demo record contains a reserved or credential field.');
    assertSafeRecord(item, depth + 1);
  }
}

/** Pure validation and deterministic IDs. Invalid/cross-account records are rejected before any connection is opened. */
export function planDemoErpSeed(input: unknown): { dataset: DemoErpDataset; rows: DemoErpSeedRow[] } {
  const dataset = DemoErpDatasetSchema.parse(input);
  const rows: DemoErpSeedRow[] = []; const ids = new Set<string>();
  const accountIds = new Set(dataset.records.accounts.map(record => record.accountId));
  const orders = new Map(dataset.records.orders.map(record => [record.orderId, record.accountId]));
  for (const [kind, records] of Object.entries(dataset.records) as Array<[keyof typeof ID_FIELDS, Record<string, any>[]]>) for (const record of records) {
    assertSafeRecord(record);
    const sourceId = record[ID_FIELDS[kind]];
    if (typeof sourceId !== 'string' || !/^DEMO-[A-Z0-9-]{1,100}$/.test(sourceId)) throw new Error('Demo identifiers must have a DEMO- prefix.');
    if (kind !== 'accounts' && kind !== 'stock' && (!record.accountId || !accountIds.has(record.accountId))) throw new Error('Demo record has no account in the same dataset.');
    if ((kind === 'invoices' || kind === 'deliveries') && record.orderId && orders.get(record.orderId) !== record.accountId) throw new Error('Demo order reference belongs to another account or is missing.');
    const id = hash([dataset.tenantId, dataset.environmentId, dataset.datasetId, kind, sourceId]);
    if (ids.has(id)) throw new Error('Duplicate demo record identifier.'); ids.add(id);
    const document = { ...record, _id: id, tenantId: dataset.tenantId, environmentId: dataset.environmentId, datasetId: dataset.datasetId, synthetic: true, source: dataset.source };
    rows.push({ collection: DEMO_ERP_COLLECTIONS[kind], document: { ...document, contentHash: hash(document) } });
  }
  return { dataset, rows };
}

/** Must run inside the caller's Mongo transaction. Immutable re-runs are allowed; changed records need a new dataset version. */
export async function applyDemoErpSeed(plan: ReturnType<typeof planDemoErpSeed>, db: any, session: any): Promise<{ inserted: number; unchanged: number }> {
  let inserted = 0, unchanged = 0;
  for (const row of plan.rows) {
    const col = db.collection(row.collection);
    const existing = await col.findOne({ _id: row.document._id }, { session, projection: { contentHash: 1, tenantId: 1, environmentId: 1, synthetic: 1 } });
    if (existing) {
      if (existing.contentHash !== row.document.contentHash || existing.tenantId !== plan.dataset.tenantId || existing.environmentId !== plan.dataset.environmentId || existing.synthetic !== true) throw new Error('Existing demo record differs; nothing may be overwritten.');
      unchanged++; continue;
    }
    await col.insertOne(row.document, { session }); inserted++;
  }
  return { inserted, unchanged };
}
