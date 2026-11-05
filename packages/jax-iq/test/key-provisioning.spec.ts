import './setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { provisionIqKeys, IQ_KEYS_COLLECTION } from '../src/keys/mongo-provisioner';
import type { KeyRow } from '../src/keys/types';

const scope = { tenantId: 'store-a', environmentId: 'test', releaseVersion: '5.0.0', releaseChecksum: 'release-checksum-a' };
const row = (source: string, canonical = 'ACCOUNT-1'): KeyRow => ({ tenantId: scope.tenantId, environmentId: 'test', thing: 'Account', canonicalId: canonical, system: 'crm', keyKind: 'account_id', systemKey: source, role: 'primary', evidence: 'real_field', status: 'matched', firstSeenAt: '2026-11-02T10:00:00Z', lastVerifiedAt: '2026-11-02T10:00:00Z', builtBy: { runId: 'operator-run', releaseVersion: scope.releaseVersion, releaseChecksum: scope.releaseChecksum } });

test('scoped key provisioning is replayable and preserves first evidence time', async () => {
  const db = new MemoryDb({ transactional: true });
  assert.deepEqual(await provisionIqKeys(db, [row('source-1')], scope), { inserted: 1, updated: 0 });
  const refresh = { ...row('source-1'), firstSeenAt: '2026-11-03T10:00:00Z', lastVerifiedAt: '2026-11-03T10:00:00Z' };
  assert.deepEqual(await provisionIqKeys(db, [refresh], scope), { inserted: 0, updated: 1 });
  assert.equal(db.dump(IQ_KEYS_COLLECTION).length, 1);
  assert.equal(db.dump(IQ_KEYS_COLLECTION)[0].firstSeenAt, row('source-1').firstSeenAt);
});

test('identity conflicts roll back the whole batch rather than retargeting an account', async () => {
  const db = new MemoryDb({ transactional: true });
  await provisionIqKeys(db, [row('source-1')], scope);
  const before = structuredClone(db.dump(IQ_KEYS_COLLECTION));
  await assert.rejects(() => provisionIqKeys(db, [row('source-2','ACCOUNT-2'), row('source-1','ACCOUNT-3')], scope), /U1/);
  assert.deepEqual(db.dump(IQ_KEYS_COLLECTION), before);
  await assert.rejects(() => provisionIqKeys(db, [row('source-2')], scope), /U2/);
  assert.deepEqual(db.dump(IQ_KEYS_COLLECTION), before);
});

test('cross-tenant/release rows, name-only matches and nontransactional storage cannot be provisioned', async () => {
  const db = new MemoryDb({ transactional: true });
  for (const change of [{ tenantId: 'other' }, { environmentId: 'production' }, { evidence: 'name_only' }, { builtBy: { ...row('a').builtBy, releaseChecksum: 'other' } }]) {
    await assert.rejects(() => provisionIqKeys(db, [{ ...row('source-1'), ...change } as KeyRow], scope), /invalid|scope|evidence/);
  }
  await assert.rejects(() => provisionIqKeys({ collection: db.collection.bind(db) }, [row('source-1')], scope), /transaction/);
  assert.equal(db.dump(IQ_KEYS_COLLECTION).length, 0);
});
