import assert from 'node:assert/strict';
import {
  BusinessPackContentSchema,
  BusinessPackLoader,
  BusinessPackRollbackError,
  ReleaseVerificationError,
  RoutingPolicyResolutionError,
  computePackChecksum,
  getVerifiedBusinessPackMetadata,
  publishBusinessPack,
  rollbackBusinessPack,
  tryVerifyPersistedBusinessPackRelease,
  verifyPersistedBusinessPackRelease,
} from '../src';
import { rawLegacyFixture } from './fixtures/legacy-pack.fixture';

/**
 * Authoritative persisted-release verifier suite:
 *  A. Happy paths (flattened, nested packData, legacy missing `extensions`)
 *  B. Fail-closed reasons (malformed, withdrawn, incomplete, unsupported, semantic, checksum)
 *  C. Tenant / environment / version identity isolation (envelope vs content vs caller vs pointer)
 *  D. Consumers (loader, rollback) reject before returning configuration / moving the pointer
 *  E. Canonical publisher enforces routing policy for direct publishBusinessPack callers
 */

const GOLDEN = 'a8ae2a4483c375bf99d427a728a5413147a7aefce9952b4351838520800ef1c5';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ PASS: ${name}`);
  } catch (err: any) {
    failed++;
    failures.push(name);
    console.error(`  ❌ FAIL: ${name}\n     ${err?.message ?? err}`);
  }
}

async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
  const origError = console.error;
  const origLog = console.log;
  const origWarn = console.warn;
  console.error = () => undefined;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = origError;
    console.log = origLog;
    console.warn = origWarn;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err: any) {
    assert.ok(err instanceof ReleaseVerificationError, `expected ReleaseVerificationError, got ${err?.message}`);
    return err.reason;
  }
  assert.fail('expected the verifier to reject');
}

const content = () => BusinessPackContentSchema.parse(clone(rawLegacyFixture)) as any;

/** Builds a persisted (flattened) release whose checksum is CORRECT for the given content. */
function release(contentOverride: any = content(), envelopeOverride: Record<string, unknown> = {}) {
  return {
    tenantId: contentOverride.manifest.tenantId,
    environmentId: contentOverride.manifest.environmentId,
    version: contentOverride.manifest.version,
    versionId: contentOverride.manifest.version,
    status: 'published',
    checksum: computePackChecksum(contentOverride),
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    publishedBy: 'tester',
    ...contentOverride,
    ...envelopeOverride,
  } as any;
}

function withManifest(patch: Record<string, unknown>) {
  const c = content();
  c.manifest = { ...c.manifest, ...patch };
  return c;
}

function createMockDb(seed: { releases?: any[]; pointers?: any[] } = {}) {
  const releases: any[] = [...(seed.releases ?? [])];
  const pointers: any[] = [...(seed.pointers ?? [])];
  const match = (doc: any, q: any) => Object.entries(q).every(([k, v]) => doc[k] === v);
  const db: any = {
    collection: (name: string) => {
      if (name === 'business_pack_releases') {
        return {
          findOne: async (q: any) => releases.find((r) => match(r, q)) || null,
          insertOne: async (doc: any) => {
            releases.push(doc);
            return { acknowledged: true };
          },
        };
      }
      if (name === 'business_pack_pointers') {
        return {
          findOne: async (q: any) => pointers.find((p) => match(p, q)) || null,
          updateOne: async (q: any, u: any) => {
            const idx = pointers.findIndex((p) => match(p, q));
            if (idx >= 0) pointers[idx] = { ...pointers[idx], ...u.$set };
            return { matchedCount: idx >= 0 ? 1 : 0, modifiedCount: idx >= 0 ? 1 : 0 };
          },
          insertOne: async (doc: any) => {
            pointers.push(doc);
            return { acknowledged: true };
          },
        };
      }
      return {
        insertOne: async () => ({ acknowledged: true }),
        updateOne: async () => ({ acknowledged: true }),
        findOne: async () => null,
      };
    },
  };
  return { db, releases, pointers };
}

function twoJourneyPack(extra: Record<string, unknown> = {}, markers: { a?: boolean; b?: boolean } = {}) {
  const raw: any = clone(rawLegacyFixture);
  const second = clone(raw.journeys[0]);
  second.journeyId = 'journey_second';
  second.displayName = 'Second Journey';
  raw.journeys[0] = { ...raw.journeys[0], ...(markers.a ? { isDefaultConsultant: true } : {}) };
  raw.journeys.push({ ...second, ...(markers.b ? { isDefaultConsultant: true } : {}) });
  raw.capabilities.stageBindings.push({
    journeyId: 'journey_second',
    stageId: 'stage_intake',
    tools: [{ toolId: 'catalog.search' }],
  });
  return { ...raw, ...extra };
}

async function main() {
  console.log('🔐 Running authoritative persisted-release verifier suite...\n');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('A. Valid releases');
  await test('flattened release verifies and returns schema-parsed content (not the raw document)', () => {
    const doc = release();
    const verified = verifyPersistedBusinessPackRelease(doc, {
      tenantId: 'placemakers',
      environmentId: 'production',
      version: '1.0.0',
      pointerChecksum: doc.checksum,
    });
    assert.equal(verified.checksum, GOLDEN);
    assert.notEqual(verified.content, doc);
    assert.equal((verified.content as any).status, undefined, 'envelope-only fields must not leak into content');
    assert.equal((verified.content as any).checksum, undefined);
    assert.equal(verified.content.manifest.tenantId, 'placemakers');
    assert.equal(verified.content.capabilities.stageBindings.length, 1);
  });

  await test('nested packData release verifies and yields identical content', () => {
    const flat = release();
    const nested: any = {
      tenantId: flat.tenantId,
      environmentId: flat.environmentId,
      version: flat.version,
      versionId: flat.versionId,
      status: 'published',
      checksum: flat.checksum,
      packData: content(),
    };
    const a = verifyPersistedBusinessPackRelease(flat);
    const b = verifyPersistedBusinessPackRelease(nested, { tenantId: 'placemakers', environmentId: 'production', version: '1.0.0' });
    assert.deepEqual(b.content, a.content);
    assert.equal(b.checksum, a.checksum);
  });

  await test('legitimate pre-9be7b80 release missing persisted `extensions` verifies (read-only normalization)', () => {
    const legacy: any = release();
    delete legacy.extensions;
    legacy.checksum = GOLDEN; // hash produced when content carried `extensions: {}`
    const before = structuredClone(legacy);
    const verified = verifyPersistedBusinessPackRelease(legacy);
    assert.deepEqual(verified.content.extensions, {});
    assert.equal(verified.checksum, GOLDEN);
    assert.deepEqual(legacy, before, 'verification must not mutate the stored document');
  });

  await test('historical immutable fields remain part of the checksum even when the current execution schema strips them', () => {
    const historical: any = content();
    historical.profile.retiredLegacyLabel = 'published-in-an-older-schema';
    const doc = release(historical);
    const verified = verifyPersistedBusinessPackRelease(doc);

    assert.equal(verified.checksum, computePackChecksum(historical));
    assert.equal((verified.content.profile as any).retiredLegacyLabel, undefined);
    assert.equal((doc.profile as any).retiredLegacyLabel, 'published-in-an-older-schema');
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nB. Fail-closed reasons');
  await test('malformed documents are rejected as malformed_envelope', () => {
    for (const bad of [null, undefined, 'str', 42, [], { tenantId: 7 }]) {
      assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(bad)), 'malformed_envelope', JSON.stringify(bad));
    }
    // An object with no content at all is rejected as incomplete rather than silently accepted.
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease({})), 'incomplete_content');
  });

  await test('ambiguous flat + packData envelope is rejected', () => {
    const doc = { ...release(), packData: content() };
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc)), 'malformed_envelope');
  });

  await test('withdrawn / revoked releases are rejected (status and operationalState)', () => {
    for (const patch of [
      { status: 'withdrawn' },
      { status: 'revoked' },
      { operationalState: { status: 'withdrawn' } },
      { operationalState: { status: 'revoked' } },
    ]) {
      assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(release(content(), patch))), 'withdrawn', JSON.stringify(patch));
    }
  });

  await test('incomplete content is rejected as incomplete_content', () => {
    for (const field of ['vocabulary', 'entities', 'conversationPolicy', 'rules', 'experience', 'evaluations', 'journeys', 'manifest']) {
      const doc = release();
      delete doc[field];
      assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc)), 'incomplete_content', `missing ${field}`);
    }
  });

  await test('unsupported checksumSchemaVersion is rejected', () => {
    for (const bad of [0, 3, 999, -1, '2', null]) {
      const doc = release();
      doc.checksumSchemaVersion = bad;
      assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc)), 'unsupported_checksum_version', JSON.stringify(bad));
    }
  });

  await test('semantically invalid content (dangling default journey) is rejected before checksum', () => {
    const c = content();
    c.routingPolicy = { defaultJourneyId: 'ghost', fallbackOnCatalogSearch: true };
    const doc = release(c);
    doc.checksum = 'deadbeef'; // checksum also wrong, semantic must be reported first
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc)), 'semantic_invalid');
  });

  await test('missing / blank / non-string stored checksum is rejected', () => {
    for (const bad of [undefined, '', '   ']) {
      const doc = release();
      if (bad === undefined) delete doc.checksum;
      else doc.checksum = bad;
      const reason = reasonOf(() => verifyPersistedBusinessPackRelease(doc));
      assert.ok(['missing_checksum', 'malformed_envelope'].includes(reason), `${JSON.stringify(bad)} -> ${reason}`);
    }
    const doc = release();
    doc.checksum = 12345;
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc)), 'malformed_envelope');
  });

  await test('tampered content / wrong checksum is rejected as checksum_mismatch', () => {
    const tampered = release();
    tampered.profile = { ...tampered.profile, companyName: 'Tampered' };
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(tampered)), 'checksum_mismatch');
    const wrong = release(content(), { checksum: 'a'.repeat(64) });
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(wrong)), 'checksum_mismatch');
  });

  await test('tryVerify returns a typed result instead of throwing', () => {
    const ok = tryVerifyPersistedBusinessPackRelease(release());
    assert.equal(ok.ok, true);
    const bad = tryVerifyPersistedBusinessPackRelease(release(content(), { checksum: 'x' }));
    assert.equal(bad.ok, false);
    if (bad.ok === false) assert.equal(bad.error.reason, 'checksum_mismatch');
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nC. Tenant / environment / version identity');
  await test('Tenant-A envelope containing Tenant-B pack content is rejected (checksum is valid)', () => {
    const tenantB = withManifest({ tenantId: 'tenant-b' });
    const doc = release(tenantB, { tenantId: 'tenant-a' });
    assert.equal(doc.checksum, computePackChecksum(tenantB), 'precondition: checksum matches content');
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc)), 'identity_mismatch');
    assert.equal(
      reasonOf(() => verifyPersistedBusinessPackRelease(doc, { tenantId: 'tenant-a' })),
      'identity_mismatch'
    );
  });

  await test('production envelope containing staging content is rejected', () => {
    const staging = withManifest({ environmentId: 'staging' });
    const doc = release(staging, { environmentId: 'production' });
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc, { environmentId: 'production' })), 'identity_mismatch');
  });

  await test('envelope version / versionId differing from manifest version is rejected', () => {
    const doc = release(content(), { version: '9.9.9' });
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc)), 'identity_mismatch');
    const doc2 = release(content(), { versionId: '2.0.0' });
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc2)), 'identity_mismatch');
  });

  await test('envelope missing a required identity field is rejected', () => {
    for (const field of ['tenantId', 'environmentId', 'version']) {
      const doc = release();
      delete doc[field];
      const reason = reasonOf(() => verifyPersistedBusinessPackRelease(doc));
      assert.ok(['identity_mismatch', 'malformed_envelope'].includes(reason), `${field} -> ${reason}`);
    }
  });

  await test('requested tenant / environment / version differing from a consistent release is rejected', () => {
    const doc = release();
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc, { tenantId: 'other' })), 'scope_mismatch');
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc, { environmentId: 'staging' })), 'scope_mismatch');
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc, { version: '1.0.1' })), 'scope_mismatch');
  });

  await test('requested scope differing from BOTH envelope and content is rejected', () => {
    const doc = release();
    assert.equal(
      reasonOf(() => verifyPersistedBusinessPackRelease(doc, { tenantId: 'x', environmentId: 'dev', version: '7.0.0' })),
      'scope_mismatch'
    );
  });

  await test('pointer checksum differing from the verified release checksum is rejected', () => {
    const doc = release();
    assert.equal(
      reasonOf(() => verifyPersistedBusinessPackRelease(doc, { pointerChecksum: 'f'.repeat(64) })),
      'pointer_checksum_mismatch'
    );
    assert.equal(reasonOf(() => verifyPersistedBusinessPackRelease(doc, { pointerChecksum: '  ' })), 'pointer_checksum_mismatch');
    assert.equal(verifyPersistedBusinessPackRelease(doc, { pointerChecksum: doc.checksum }).checksum, doc.checksum);
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nD. Consumers reject before returning configuration / mutating state');
  const pointerFor = (checksum: string, extra: Record<string, unknown> = {}) => ({
    tenantId: 'placemakers',
    environmentId: 'production',
    activeVersion: '1.0.0',
    previousVersion: '0.9.0',
    revision: 3,
    checksum,
    ...extra,
  });

  await test('BusinessPackLoader returns the verified release for a consistent pointer + release', async () => {
    const doc = release();
    const { db } = createMockDb({ releases: [doc], pointers: [pointerFor(doc.checksum)] });
    const loader = new BusinessPackLoader({ db } as any);
    const pack = await quiet(() => loader.loadFromMongo('placemakers', 'production'));
    assert.ok(pack);
    assert.equal(pack!.manifest.tenantId, 'placemakers');
    const metadata = getVerifiedBusinessPackMetadata(pack!);
    assert.equal(metadata?.checksum, doc.checksum);
    assert.equal(metadata?.version, '1.0.0');
    assert.equal(Object.getOwnPropertySymbols(pack!).length > 0, true);
    assert.equal(JSON.stringify(pack!).includes('verified-release-metadata'), false);
  });

  await test('pinned loader ignores a newer active pointer but enforces the pinned checksum and withdrawal state', async () => {
    const pinned = release();
    const newerContent = withManifest({ version: '2.0.0' });
    const newer = release(newerContent);
    const { db } = createMockDb({
      releases: [pinned, newer],
      pointers: [pointerFor(newer.checksum, { activeVersion: '2.0.0' })],
    });
    const loader = new BusinessPackLoader({ db } as any);

    const loaded = await quiet(() => loader.loadPinned('placemakers', 'production', '1.0.0', pinned.checksum));
    assert.equal(loaded.manifest.version, '1.0.0');
    await assert.rejects(
      () => quiet(() => loader.loadPinned('placemakers', 'production', '1.0.0', 'f'.repeat(64))),
      /unavailable or invalid/
    );

    const withdrawnDb = createMockDb({
      releases: [release(content(), { status: 'withdrawn' })],
      pointers: [],
    }).db;
    const withdrawnLoader = new BusinessPackLoader({ db: withdrawnDb } as any);
    await assert.rejects(
      () => quiet(() => withdrawnLoader.loadPinned('placemakers', 'production', '1.0.0', pinned.checksum)),
      /unavailable or invalid/
    );
  });

  await test('BusinessPackLoader rejects active pointers with missing or blank checksums', async () => {
    const doc = release();
    for (const pointer of [
      pointerFor(doc.checksum, { checksum: undefined }),
      pointerFor(doc.checksum, { checksum: '   ' }),
    ]) {
      const { db } = createMockDb({ releases: [doc], pointers: [pointer] });
      const loader = new BusinessPackLoader({ db } as any);
      assert.equal(await quiet(() => loader.loadFromMongo('placemakers', 'production')), null);
      assert.equal(await quiet(() => loader.hasPublishedPackAsync('placemakers', 'production')), false);
    }
  });

  await test('BusinessPackLoader rejects pointer-checksum, tenant, environment and version mismatches', async () => {
    const good = release();
    const cases: Array<{ name: string; releases: any[]; pointers: any[]; version?: string }> = [
      { name: 'pointer checksum', releases: [good], pointers: [pointerFor('0'.repeat(64))] },
      {
        name: 'tenant-a envelope / tenant-b content',
        releases: [release(withManifest({ tenantId: 'tenant-b' }), { tenantId: 'placemakers' })],
        pointers: [pointerFor(computePackChecksum(withManifest({ tenantId: 'tenant-b' })))],
      },
      {
        name: 'production envelope / staging content',
        releases: [release(withManifest({ environmentId: 'staging' }), { environmentId: 'production' })],
        pointers: [pointerFor(computePackChecksum(withManifest({ environmentId: 'staging' })))],
      },
      {
        name: 'envelope version differs',
        releases: [release(content(), { version: '2.0.0', versionId: '2.0.0' })],
        pointers: [pointerFor(good.checksum, { activeVersion: '2.0.0' })],
      },
    ];
    for (const c of cases) {
      const { db } = createMockDb({ releases: c.releases, pointers: c.pointers });
      const loader = new BusinessPackLoader({ db } as any);
      const pack = await quiet(() => loader.loadFromMongo('placemakers', 'production'));
      assert.equal(pack, null, `loader must fail closed for: ${c.name}`);
    }
  });

  await test('BusinessPackLoader rejects an explicitly requested version that conflicts with the release', async () => {
    const doc = release(content(), { version: '2.0.0', versionId: '2.0.0' }); // envelope says 2.0.0, content 1.0.0
    const { db } = createMockDb({ releases: [doc] });
    const loader = new BusinessPackLoader({ db } as any);
    assert.equal(await quiet(() => loader.loadFromMongo('placemakers', 'production', '2.0.0')), null);
  });

  async function rollbackFixture(target: any) {
    const current = release(withManifest({ version: '2.0.0' }));
    const { db, pointers } = createMockDb({
      releases: [target, current],
      pointers: [pointerFor(current.checksum, { activeVersion: '2.0.0', previousVersion: '1.0.0' })],
    });
    return { db, pointers };
  }

  await test('rollbackBusinessPack succeeds for a verified target and records the verified checksum', async () => {
    const target = release();
    const { db, pointers } = await rollbackFixture(target);
    const result = await quiet(() => rollbackBusinessPack(db, 'placemakers', 'production'));
    assert.equal(result.activeVersion, '1.0.0');
    assert.equal(pointers[0].checksum, target.checksum);
  });

  await test('rollbackBusinessPack rejects identity mismatches with a typed reason and leaves the pointer untouched', async () => {
    const targets: Array<[string, any, string]> = [
      ['tenant', release(withManifest({ tenantId: 'tenant-b' }), { tenantId: 'placemakers' }), 'identity_mismatch'],
      ['environment', release(withManifest({ environmentId: 'staging' }), { environmentId: 'production' }), 'identity_mismatch'],
      ['version', release(content(), { version: '1.0.0', versionId: '1.0.0' }, ), 'ok'],
    ];
    // Content version differing from the requested/stored version: envelope 1.0.0, manifest 1.5.0
    targets[2] = ['version', release(withManifest({ version: '1.5.0' }), { version: '1.0.0', versionId: '1.0.0' }), 'identity_mismatch'];
    for (const [label, target, reason] of targets) {
      const { db, pointers } = await rollbackFixture(target);
      const before = clone(pointers[0]);
      let error: any;
      try {
        await quiet(() => rollbackBusinessPack(db, 'placemakers', 'production'));
      } catch (e) {
        error = e;
      }
      assert.ok(error instanceof BusinessPackRollbackError, `${label}: expected BusinessPackRollbackError, got ${error?.message}`);
      assert.equal(error.reason, reason, label);
      assert.deepEqual(pointers[0], before, `${label}: pointer must not move`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nE. Canonical publisher routing enforcement (direct publishBusinessPack)');
  await test('publisher rejects a tampered existing release before idempotent return or pointer mutation', async () => {
    const original = release();
    const tampered = clone(original);
    tampered.profile.companyName = 'Tampered while retaining the old checksum';
    const pointer = pointerFor(original.checksum);
    const { db, releases, pointers } = createMockDb({ releases: [tampered], pointers: [pointer] });
    const beforePointer = clone(pointers[0]);

    await assert.rejects(
      () => publishBusinessPack(db, clone(rawLegacyFixture)),
      /failed integrity verification|checksum/i
    );
    assert.equal(releases.length, 1, 'publisher must not write another release');
    assert.deepEqual(pointers[0], beforePointer, 'publisher must not move or revise the active pointer');
  });

  await test('two journeys with no default are rejected by publishBusinessPack and nothing is persisted', async () => {
    const { db, releases, pointers } = createMockDb();
    await assert.rejects(
      () => publishBusinessPack(db, twoJourneyPack()),
      (err: any) => err instanceof RoutingPolicyResolutionError && /none is configured|routingPolicy\.defaultJourneyId is not set/.test(err.message)
    );
    assert.equal(releases.length, 0);
    assert.equal(pointers.length, 0);
  });

  await test('multiple default markers are rejected (even with an explicit default)', async () => {
    for (const extra of [{}, { routingPolicy: { defaultJourneyId: 'journey_second', fallbackOnCatalogSearch: true } }]) {
      const { db, releases } = createMockDb();
      await assert.rejects(
        () => publishBusinessPack(db, twoJourneyPack(extra, { a: true, b: true })),
        (err: any) => err instanceof RoutingPolicyResolutionError && /multiple journeys are marked as default/.test(err.message)
      );
      assert.equal(releases.length, 0);
    }
  });

  await test('configured default referencing a missing journey is rejected', async () => {
    const { db, releases } = createMockDb();
    await assert.rejects(
      () => publishBusinessPack(db, twoJourneyPack({ routingPolicy: { defaultJourneyId: 'nope', fallbackOnCatalogSearch: true } })),
      /does not match any journey/
    );
    assert.equal(releases.length, 0);
  });

  await test('a single marker without a persisted explicit default is rejected for multi-journey packs', async () => {
    const { db } = createMockDb();
    await assert.rejects(() => publishBusinessPack(db, twoJourneyPack({}, { b: true })), /persist it explicitly|not set/);
  });

  await test('accepted: one journey, explicit default, and compiled pack with marker already persisted explicitly', async () => {
    const one = createMockDb();
    await quiet(() => publishBusinessPack(one.db, clone(rawLegacyFixture)));
    assert.equal(one.releases.length, 1);

    const explicit = createMockDb();
    await quiet(() =>
      publishBusinessPack(
        explicit.db,
        twoJourneyPack({ routingPolicy: { defaultJourneyId: 'journey_second', fallbackOnCatalogSearch: true } })
      )
    );
    assert.equal(explicit.releases[0].routingPolicy.defaultJourneyId, 'journey_second');

    const compiled = createMockDb();
    await quiet(() =>
      publishBusinessPack(
        compiled.db,
        twoJourneyPack({ routingPolicy: { defaultJourneyId: 'journey_second', fallbackOnCatalogSearch: true } }, { b: true })
      )
    );
    assert.equal(compiled.releases.length, 1);
  });

  await test('published release round-trips through the verifier', async () => {
    const { db, releases } = createMockDb();
    const { checksum } = await quiet(() => publishBusinessPack(db, clone(rawLegacyFixture)));
    const verified = verifyPersistedBusinessPackRelease(releases[0], {
      tenantId: 'placemakers',
      environmentId: 'production',
      version: '1.0.0',
      pointerChecksum: checksum,
    });
    assert.equal(verified.checksum, checksum);
  });

  console.log(`\nVerifier suite: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`Failures:\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
