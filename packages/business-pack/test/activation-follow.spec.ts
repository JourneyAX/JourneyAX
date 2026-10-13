import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { publishBusinessPack, rollbackBusinessPack } from '../src';
import { rawLegacyFixture } from './fixtures/legacy-pack.fixture';

/**
 * A publication or rollback may carry an environment's release activation to the release it just made active, but only while
 * customers are already being served (`migrated`, `canary`). It never restarts a stopped line, never migrates a legacy tenant,
 * moves the numbered revision, and is attributed in the audit log.
 */
const suite = createSuite('business-pack: activation follows a publication only while live');
const TENANT = 'placemakers';
const ENV = 'production';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const packAt = (version: string) => ({ ...clone(rawLegacyFixture), manifest: { ...clone(rawLegacyFixture).manifest, version } });

const approval = (status: string, extra: Record<string, unknown> = {}) => ({
  tenantId: TENANT, environmentId: ENV, status, approvedReleaseVersion: '1.0.0', approvedReleaseChecksum: 'c'.repeat(64),
  canaryPercentage: 0, revision: 4, approvedBy: 'human:release-manager', promotedAt: new Date('2026-01-01'), notes: 'earlier approval', ...extra,
});

/** v1.0.0 is published; the environment carries the given activation record (or none). */
async function environment(record?: Record<string, unknown>) {
  const db = new MemoryDb();
  const first = await publishBusinessPack(db as any, packAt('1.0.0'), { publishedBy: 'human:publisher' });
  if (record) await db.collection('tenant_cutovers').insertOne({ ...record, approvedReleaseChecksum: record.approvedReleaseChecksum === 'keep' ? first.checksum : record.approvedReleaseChecksum });
  const activation = () => db.collection('tenant_cutovers').findOne({ tenantId: TENANT, environmentId: ENV });
  const audit = () => db.dump('cutover_audit_logs');
  return { db, first, activation, audit };
}

async function main() {
  await suite.test('no activation record: nothing follows and none is created', async () => {
    const { db, activation } = await environment();
    const second = await publishBusinessPack(db as any, packAt('1.0.1'), { publishedBy: 'human:publisher' });
    assert.equal(second.activation?.outcome, 'none');
    assert.equal(await activation(), null);
  });

  await suite.test('a migrated record follows to the new release by version and checksum, with a numbered revision and an audit row', async () => {
    const { db, activation, audit } = await environment(approval('migrated', { approvedReleaseChecksum: 'keep' }));
    const second = await publishBusinessPack(db as any, packAt('1.0.1'), { publishedBy: 'human:publisher' });
    assert.equal(second.activation?.outcome, 'followed');
    const record: any = await activation();
    assert.equal(record.status, 'migrated');
    assert.equal(record.approvedReleaseVersion, '1.0.1');
    assert.equal(record.approvedReleaseChecksum, second.checksum);
    assert.equal(record.revision, 5, 'the revision advances so an approval based on the old one is refused');
    assert.equal(record.promotedBy, 'human:publisher');
    assert.equal(record.approvedBy, 'human:release-manager', 'it does not claim a new person approved it');
    const rows: any[] = audit();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].previousRevision, rows[0].newRevision, rows[0].approvedBy, rows[0].newStatus], [4, 5, 'human:publisher', 'migrated']);
    assert.equal(rows[0].approvedReleaseChecksum, second.checksum);
  });

  await suite.test('a canary record stays a canary at the same percentage', async () => {
    const { db, activation } = await environment(approval('canary', { canaryPercentage: 25, approvedReleaseChecksum: 'keep' }));
    await publishBusinessPack(db as any, packAt('1.0.1'), { publishedBy: 'human:publisher' });
    const record: any = await activation();
    assert.deepEqual([record.status, record.canaryPercentage, record.approvedReleaseVersion], ['canary', 25, '1.0.1']);
  });

  await suite.test('a stopped line (rollback) stays stopped: the publication moves the pointer, not the activation', async () => {
    const { db, first, activation, audit } = await environment(approval('rollback', { approvedReleaseChecksum: 'keep' }));
    const second = await publishBusinessPack(db as any, packAt('1.0.1'), { publishedBy: 'human:publisher' });
    assert.deepEqual([second.activation?.outcome, second.activation?.status], ['unchanged', 'rollback']);
    const record: any = await activation();
    assert.deepEqual([record.status, record.approvedReleaseVersion, record.approvedReleaseChecksum, record.revision], ['rollback', '1.0.0', first.checksum, 4]);
    assert.equal(audit().length, 0, 'nothing was approved, so nothing is logged as an approval');
    const pointer: any = await db.collection('business_pack_pointers').findOne({ tenantId: TENANT, environmentId: ENV });
    assert.equal(pointer.activeVersion, '1.0.1', 'the release itself is still published');
  });

  await suite.test('a legacy (unmigrated) record is not migrated by a publication', async () => {
    const { db, activation } = await environment(approval('unmigrated', { approvedReleaseChecksum: 'keep' }));
    const second = await publishBusinessPack(db as any, packAt('1.0.1'), { publishedBy: 'human:publisher' });
    assert.equal(second.activation?.outcome, 'unchanged');
    assert.deepEqual([(await activation() as any).status, (await activation() as any).revision], ['unmigrated', 4]);
  });

  await suite.test('rollback follows a live record to the original checksum, and leaves a stopped line stopped', async () => {
    const live = await environment(approval('migrated', { approvedReleaseChecksum: 'keep' }));
    await publishBusinessPack(live.db as any, packAt('1.0.1'), { publishedBy: 'human:publisher' });
    const rolled = await rollbackBusinessPack(live.db as any, TENANT, ENV, { rolledBackBy: 'human:release-manager', targetVersion: '1.0.0' });
    assert.equal(rolled.activation?.outcome, 'followed');
    const record: any = await live.activation();
    assert.deepEqual([record.approvedReleaseVersion, record.approvedReleaseChecksum, record.revision], ['1.0.0', live.first.checksum, 6]);
    assert.equal(live.audit().length, 2, 'the publication and the rollback are each logged');

    const stopped = await environment(approval('rollback', { approvedReleaseChecksum: 'keep' }));
    await publishBusinessPack(stopped.db as any, packAt('1.0.1'), { publishedBy: 'human:publisher' });
    const stoppedRoll = await rollbackBusinessPack(stopped.db as any, TENANT, ENV, { rolledBackBy: 'human:release-manager', targetVersion: '1.0.0' });
    assert.equal(stoppedRoll.activation?.outcome, 'unchanged');
    assert.equal(((await stopped.activation()) as any).status, 'rollback');
  });

  await suite.test('an approval made while a publication was in flight is never overwritten: the publication fails instead', async () => {
    const { db } = await environment(approval('migrated', { approvedReleaseChecksum: 'keep' }));
    const collection = db.collection.bind(db);
    (db as any).collection = (name: string) => {
      const target: any = collection(name);
      if (name !== 'tenant_cutovers') return target;
      return new Proxy(target, {
        get: (source, key) => key === 'updateOne'
          ? async (filter: any, update: any, options: any) => {
              await source.updateOne({ tenantId: TENANT, environmentId: ENV }, { $set: { revision: 99 } });
              return source.updateOne(filter, update, options);
            }
          : source[key].bind?.(source) ?? source[key],
      });
    };
    await assert.rejects(() => publishBusinessPack(db as any, packAt('1.0.1'), { publishedBy: 'human:publisher' }), /modified concurrently/);
  });

  process.exitCode = suite.finish() ? 0 : 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
