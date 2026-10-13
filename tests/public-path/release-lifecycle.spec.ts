import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { computePackChecksum } from '@journeyax/business-pack';
import { parseSse } from '../../packages/canary/src';
import { INTERNAL_KEY, startPublicPath } from './harness';

/**
 * Release lifecycle, proved on the real path with the real repositories and an isolated in-memory store:
 *
 *   publish v1 → approve v1 → serve → publish v2 → (nothing changes for customers until a person approves it)
 *   → wrong approvals refused → approve v2 as a canary → approve v2 fully → roll back to v1 → stop the line → restore
 *
 * Nothing here touches a real environment; `production` only names the environment inside the isolated store, because that is the
 * environment a customer's request lands in when it names none. Set LIFECYCLE_EVIDENCE_DIR to write the step-by-step evidence.
 */
const suite = createSuite('release lifecycle: publish → approve → serve → roll back, checksum-bound');
const TENANT = 'placemakers';
const ENV = 'production' as const;
const APPROVER = 'human:release-manager';

interface Step { step: string; action: string; expected: string; observed: string; ok: boolean }

async function main() {
  const quiet = console.log;
  const silently = async <T>(run: () => Promise<T>): Promise<T> => { console.log = () => undefined; try { return await run(); } finally { console.log = quiet; } };
  const path_ = await silently(() => startPublicPath());
  const { stack, activation } = path_;
  const evidence: Step[] = [];
  const record = (step: string, action: string, expected: string, observed: string, ok = true) => { evidence.push({ step, action, expected, observed, ok }); };

  const post = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let n = 0;
  const turn = (message: string, session = `lc-${Date.now()}-${n++}`) => ({ message, sessionId: session, workspaceId: session, turnId: `${session}-t${n++}`, correlationId: `${session}-c${n}` });

  /** What a customer gets, through the whole public path. */
  const asCustomer = async (message: string, session?: string) => {
    const response = await silently(() => post(path_.chatStreamUrl, turn(message, session), path_.customerHeaders));
    const body = await response.text();
    return { status: response.status, body, served: response.status === 200 && parseSse(body).some((frame) => frame.event === 'done') };
  };
  /** Which release actually served a conversation, read from the runtime as a platform workload (the customer never sees this). */
  const servedBy = async (session: string, message = 'vanities') => {
    const response = await silently(() => post(`${path_.urls.runtime}/api/v1/${TENANT}/${ENV}/runtime/chat/stream`, { ...turn(message, session), tenantId: TENANT, environmentId: ENV }, { 'X-Internal-Key': INTERNAL_KEY, 'X-Tenant-ID': TENANT }));
    const frames = parseSse(await response.text());
    const done = frames.find((frame) => frame.event === 'done')?.json;
    return { status: response.status, checksum: done?.workspace?.pins?.packChecksum as string | undefined, version: done?.workspace?.packVersionId as string | undefined };
  };
  const refusal = (result: { status: number; body: string }) => !/checksum|[a-f0-9]{64}|ReleaseActivation|ReleaseVerification|rollback|tamper|pointer|revision/i.test(result.body);
  const current = async () => (await activation.getReleaseActivation(TENANT, ENV))!;
  const approve = (status: 'migrated' | 'canary' | 'rollback', version: string, checksum: string, expectedRevision: number, extra: Record<string, unknown> = {}) =>
    activation.promoteReleaseActivation(TENANT, ENV, { status, approvedReleaseVersion: version, approvedReleaseChecksum: checksum, expectedRevision, approvedBy: APPROVER, ...extra } as any);
  const rejects = async (run: () => Promise<unknown>, code: RegExp) => {
    try { await run(); } catch (error: any) { assert.match(`${error?.code ?? ''} ${error?.name ?? ''} ${error?.message ?? ''}`, code, String(error?.message)); return error; }
    assert.fail(`expected a rejection matching ${code}`);
  };

  const v1 = { version: stack.pack.manifest.version as string, checksum: computePackChecksum(stack.pack) };
  let v2 = { version: '', checksum: '', configVersion: 0 };
  const conversationOnV1 = `lc-pinned-${Date.now()}`;

  try {
    await suite.test('v1 is live: it was approved by version and checksum, a customer is served, and the conversation is bound to that checksum', async () => {
      const first = await current();
      assert.equal(first.status, 'migrated');
      assert.equal(first.approvedReleaseVersion, v1.version);
      assert.equal(first.approvedReleaseChecksum, v1.checksum);
      assert.ok(first.approvedBy, 'the approval is attributed to a person');
      assert.equal((await asCustomer('vanities', conversationOnV1)).served, true);
      assert.equal((await path_.pinsOf(conversationOnV1))?.packChecksum, v1.checksum, 'the conversation is bound to the exact checksum that was approved');
      record('1', `approve v${v1.version} (migrated) and chat`, 'customer served by v1', `served; conversation pinned to ${v1.checksum.slice(0, 12)}…`);
    });

    await suite.test('publishing v2 is the go-live action for a migrated environment: new conversations run v2, an existing one stays on v1', async () => {
      await stack.db.collection('tenant_configs').updateOne({ projectId: TENANT }, { $set: { 'persona.systemName': 'PlaceMakers assistant (second release)' } });
      const published: any = await silently(() => stack.projects.publishConfig(TENANT, { environmentId: ENV, publishedBy: 'human:publisher', note: 'lifecycle proof' }));
      assert.equal(published.success, true, published.message);
      path_.invalidatePackCache();
      const pointer: any = await stack.db.collection('business_pack_pointers').findOne({ tenantId: TENANT, environmentId: ENV });
      v2 = { version: pointer.activeVersion, checksum: pointer.checksum, configVersion: published.version };
      assert.notEqual(v2.version, v1.version);
      assert.notEqual(v2.checksum, v1.checksum, 'a new release has its own checksum');
      const followed = await current();
      assert.equal(followed.approvedReleaseVersion, v2.version, 'the activation record follows the publication');
      assert.equal(followed.approvedReleaseChecksum, v2.checksum, 'and it is bound to the new release\'s checksum');
      const session = `lc-new-${Date.now()}`;
      assert.equal((await asCustomer('vanities', session)).served, true);
      assert.equal((await path_.pinsOf(session))?.packChecksum, v2.checksum, 'a new conversation is bound to v2');
      assert.equal((await asCustomer('vanities', conversationOnV1)).served, true);
      assert.equal((await path_.pinsOf(conversationOnV1))?.packChecksum, v1.checksum, 'the conversation that started on v1 carries on, on v1');
      record('2', `publish v${v2.version}`, 'record follows by checksum; new conversations on v2; the old one stays on v1', `record → ${v2.checksum.slice(0, 12)}…; new pinned to v2; old still pinned to v1`);
    });

    await suite.test('an explicit approval is strict: wrong checksum, stale revision, the wrong release and an unknown release are all refused, and nothing changes', async () => {
      const before = await current();
      const wrongChecksum = await rejects(() => approve('migrated', v2.version, v1.checksum, before.revision!), /CHECKSUM_MISMATCH/);
      const stale = await rejects(() => approve('migrated', v2.version, v2.checksum, before.revision! - 1), /conflict|revision/i);
      const wrongRelease = await rejects(() => approve('migrated', v1.version, v1.checksum, before.revision!), /POINTER_VERSION_MISMATCH/);
      const unknown = await rejects(() => approve('migrated', '9.9.9', v2.checksum, before.revision!), /RELEASE_NOT_FOUND/);
      const after = await current();
      assert.deepEqual([after.revision, after.approvedReleaseVersion, after.approvedReleaseChecksum, after.status], [before.revision, before.approvedReleaseVersion, before.approvedReleaseChecksum, before.status]);
      record('3', 'try four wrong approvals of v2', 'each refused; the record is unchanged', [wrongChecksum, stale, wrongRelease, unknown].map((error: any) => error.code ?? error.name).join(', '));
    });

    await suite.test('a canary approval is bucketed: at 0% nobody is served and the customer is told nothing about why; at 100% everybody is', async () => {
      const before = await current();
      const canary = await approve('canary', v2.version, v2.checksum, before.revision!, { canaryPercentage: 0, notes: 'canary at 0%' });
      path_.invalidatePackCache();
      const fresh = await asCustomer('vanities');
      assert.ok(!fresh.served && fresh.status >= 400, `nobody is in a 0% canary (status ${fresh.status})`);
      assert.ok(refusal(fresh), `the customer is not told why: ${fresh.body.slice(0, 160)}`);
      await approve('canary', v2.version, v2.checksum, (canary as any).revision, { canaryPercentage: 100, notes: 'canary at 100%' });
      assert.equal((await asCustomer('vanities')).served, true);
      record('4', 'approve v2 as a canary: 0%, then 100%', 'refused at 0%, served at 100%', `0%: HTTP ${fresh.status} with a plain refusal; 100%: served`);
    });

    await suite.test('rollback: re-pointing to v1 puts v1 back in front of new conversations by its original checksum', async () => {
      const before = await current();
      await approve('migrated', v2.version, v2.checksum, before.revision!, { notes: 'canary complete' });
      const versions: any[] = await stack.projects.listVersions(TENANT);
      const v1Config = versions.find((entry) => entry.packVersion === v1.version)?.version ?? 1;
      const rolled = await silently(() => stack.projects.rollbackConfig(TENANT, v1Config, 'human:release-manager', ENV));
      assert.equal(rolled.success, true, rolled.message);
      path_.invalidatePackCache();
      const after = await current();
      assert.equal(after.approvedReleaseVersion, v1.version);
      assert.equal(after.approvedReleaseChecksum, v1.checksum, 'rollback restores the exact checksum that was approved before');
      const session = `lc-rolled-${Date.now()}`;
      assert.equal((await asCustomer('vanities', session)).served, true);
      assert.equal((await path_.pinsOf(session))?.packChecksum, v1.checksum);
      record('5', 'roll back to v1', 'record and traffic return to v1, by its original checksum', `record → ${v1.checksum.slice(0, 12)}…; a new conversation pinned to v1`);
    });

    await suite.test('stop-the-line: setting the activation to rollback stops every conversation, pinned or not; re-approving the exact checksum restores service', async () => {
      const before = await current();
      const stopped = await approve('rollback', v1.version, v1.checksum, before.revision!, { notes: 'stop the line' });
      path_.invalidatePackCache();
      for (const session of [undefined, conversationOnV1]) {
        const result = await asCustomer('vanities', session);
        assert.ok(!result.served && result.status >= 400, 'nobody is served');
        assert.ok(refusal(result), `nothing about the activation reaches a customer: ${result.body.slice(0, 160)}`);
      }
      await approve('migrated', v1.version, v1.checksum, (stopped as any).revision, { notes: 'restored after the drill' });
      path_.invalidatePackCache();
      assert.equal((await asCustomer('vanities')).served, true);
      record('6', 'set the activation to rollback, then re-approve v1', 'all traffic stops; then resumes', 'refused for new and pinned conversations; served after the approval');
    });

    await suite.test('every explicit approval is a numbered, attributed revision: a person, a release and a checksum', async () => {
      const final = await current();
      assert.ok(final.revision! >= 6, `revisions advance one at a time (at ${final.revision})`);
      assert.equal(final.approvedBy, APPROVER);
      assert.equal(final.approvedReleaseChecksum, v1.checksum);
      record('7', 'read the record', 'attributed, checksum-bound, monotonic revision', `revision ${final.revision}, approved by ${final.approvedBy}`);
    });

    await suite.test('KNOWN RISK (characterised, not endorsed): a publish or rollback re-points the activation record without an approver, and revives a stopped line', async () => {
      // This documents what the publisher does today so the behaviour is visible and any change is deliberate: it follows the
      // publication into the activation record without a new approval, keeps the old revision, and turns a stopped line
      // (status 'rollback') back into 'migrated'. See the Phase 8 report: this is the one place a release goes live without an
      // explicit approval step, and the production checklist treats "Publish Business Pack" as the go-live action because of it.
      const before = await current();
      await approve('rollback', v1.version, v1.checksum, before.revision!, { notes: 'stop the line before a publish' });
      await stack.db.collection('tenant_configs').updateOne({ projectId: TENANT }, { $set: { 'persona.systemName': 'PlaceMakers assistant (third release)' } });
      const published: any = await silently(() => stack.projects.publishConfig(TENANT, { environmentId: ENV, publishedBy: 'human:publisher' }));
      assert.equal(published.success, true, published.message);
      path_.invalidatePackCache();
      const after = await current();
      assert.equal(after.status, 'migrated', 'today a publish restarts a stopped line');
      assert.equal(after.revision, before.revision! + 1, 'the numbered revision is not advanced by the publication itself');
      assert.equal(after.approvedBy, APPROVER, 'the approver on the record is still the earlier person');
      record('8', 'stop the line, then publish', 'KNOWN RISK: the stopped line is restarted by the publish', `status ${after.status}; approver unchanged (${after.approvedBy}); revision ${after.revision}`);
    });
  } finally {
    await path_.stop();
    if (process.env.LIFECYCLE_EVIDENCE_DIR && evidence.length) {
      mkdirSync(process.env.LIFECYCLE_EVIDENCE_DIR, { recursive: true });
      const rows = evidence.map((entry) => `| ${entry.step} | ${entry.action} | ${entry.expected} | ${entry.observed} |`);
      writeFileSync(path.join(process.env.LIFECYCLE_EVIDENCE_DIR, 'release-lifecycle-evidence.md'), [
        '# Release lifecycle evidence (isolated in-memory store)', '',
        'Real publisher, real Business Pack repository and loader, real checksum-bound activation repository, the real four-hop public path. The store is in memory; nothing here touches a real environment.', '',
        '| Step | Action | Expected | Observed |', '|---|---|---|---|', ...rows, '',
      ].join('\n'));
    }
  }
}

main().then(() => { suite.finish(); process.exit(process.exitCode ?? 0); }).catch((error) => { console.error(error); process.exit(1); });
