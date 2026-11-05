import { createHash } from 'node:crypto';
import { checkKeyRow, checkKeyUniqueness, systemKeyId } from './repository';
import type { KeyRow } from './types';

export const IQ_KEYS_COLLECTION = 'jax_iq_keys';
export interface KeyProvisionScope { tenantId: string; environmentId: string; releaseVersion: string; releaseChecksum: string }

/** Operator provisioning only. The model and query service never receive this writer. */
export async function ensureIqKeyIndexes(db: any): Promise<void> {
  const keys = db.collection(IQ_KEYS_COLLECTION);
  await keys.createIndex({ tenantId: 1, environmentId: 1, thing: 1, system: 1, keyKind: 1, systemKey: 1 }, { unique: true, name: 'iq_system_identity' });
  await keys.createIndex({ tenantId: 1, environmentId: 1, thing: 1, canonicalId: 1, system: 1, keyKind: 1 }, { unique: true, name: 'iq_primary_identity', partialFilterExpression: { role: 'primary', status: 'matched' } });
}

/** Atomic, scoped identity-link provisioning with the same U1/U2 checks used by the query engine's key contracts. */
export async function provisionIqKeys(db: any, rows: KeyRow[], scope: KeyProvisionScope): Promise<{ inserted: number; updated: number }> {
  if (!scope.tenantId || !scope.environmentId || !scope.releaseVersion || !scope.releaseChecksum || !Array.isArray(rows) || rows.length > 1000) throw new Error('An explicit release scope and a bounded key batch are required.');
  for (const row of rows) {
    if (checkKeyRow(row).length || row.tenantId !== scope.tenantId || row.environmentId !== scope.environmentId || row.builtBy.releaseVersion !== scope.releaseVersion || row.builtBy.releaseChecksum !== scope.releaseChecksum || row.status === 'matched' && row.evidence === 'name_only') {
      throw new Error('A key row is invalid, belongs to another release/scope, or lacks identity evidence.');
    }
  }
  if (new Set(rows.map(systemKeyId)).size !== rows.length) throw new Error('The batch contains duplicate source identities.');
  const client = db.client;
  if (!client?.startSession) throw new Error('Key provisioning requires transaction-capable storage.');
  const session = client.startSession();
  let result = { inserted: 0, updated: 0 };
  try {
    await session.withTransaction(async () => {
      result = { inserted: 0, updated: 0 };
      const keys = db.collection(IQ_KEYS_COLLECTION);
      for (const row of rows) {
        const owned = { tenantId: scope.tenantId, environmentId: scope.environmentId, thing: row.thing };
        const neighbours = await keys.find({ ...owned, $or: [
          { system: row.system, keyKind: row.keyKind, systemKey: row.systemKey },
          { canonicalId: row.canonicalId },
        ] }, { session }).limit(1001).toArray();
        if (neighbours.length > 1000 || neighbours.some((value: any) => checkKeyRow(stripId(value)).length)) throw new Error('Existing identity links are invalid or exceed the provisioning bound.');
        const problem = checkKeyUniqueness(row, neighbours);
        if (problem) throw new Error(`Identity provisioning refused by ${problem.rule}.`);
        const existing = neighbours.find((other: KeyRow) => systemKeyId(other) === systemKeyId(row));
        const next = { ...row, ...(existing && existing.canonicalId === row.canonicalId && Date.parse(existing.firstSeenAt) < Date.parse(row.firstSeenAt) ? { firstSeenAt: existing.firstSeenAt } : {}) };
        if (existing) {
          const saved = await keys.updateOne({ ...owned, _id: existing._id, canonicalId: existing.canonicalId, status: existing.status }, { $set: next }, { session });
          if (saved.matchedCount !== 1) throw new Error('An identity link changed during provisioning.');
          result.updated++;
        } else {
          const id = createHash('sha256').update(systemKeyId(row)).digest('hex');
          await keys.insertOne({ _id: id, ...next }, { session });
          result.inserted++;
        }
      }
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result;
  } finally { await session.endSession(); }
}

function stripId(value: any): KeyRow { const { _id, ...row } = value; return row; }
