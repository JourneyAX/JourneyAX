import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BusinessPackContentSchema,
  BusinessPackEnvelopeSchema,
  BusinessPackLoader,
  CANONICAL_CONTENT_KEYS,
  RoutingPolicyResolutionError,
  SUPPORTED_CHECKSUM_SCHEMA_VERSIONS,
  computePackChecksum,
  extractPackContent,
  normalizeLegacyStoredContent,
  parseChecksumSchemaVersion,
  parsePersistedRelease,
  publishBusinessPack,
  resolveChecksumAlgorithm,
  resolvePublicationRoutingPolicy,
  rollbackBusinessPack,
  stableJsonLegacy,
  stableJsonV2,
} from '../src';
import { rawLegacyFixture } from './fixtures/legacy-pack.fixture';

/**
 * Step 1 OKF hardening suite (pass 2):
 *  A. Unsupported checksumSchemaVersion fails closed (checksum, publisher, loader, rollback, envelope)
 *  B. Established Business Pack fields stay strict and default-free; only new OKF fields optional
 *  C. Default journey selection is explicit/unambiguous (no positional or fabricated IDs)
 *  D. Storage-envelope boundary (flattened / nested `packData`, malformed envelopes rejected)
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
  console.error = () => undefined;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = origError;
    console.log = origLog;
  }
}

async function rejectsWith(fn: () => Promise<unknown>, pattern: RegExp, label: string) {
  let error: any;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error, `${label}: expected rejection but call succeeded`);
  assert.match(String(error.message), pattern, `${label}: unexpected error message: ${error.message}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
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
      if (name === 'outbox_events' || name === 'tenant_cutovers') {
        return {
          insertOne: async () => ({ acknowledged: true }),
          updateOne: async () => ({ acknowledged: true }),
          findOne: async () => null,
        };
      }
      throw new Error(`Unexpected collection in mock: ${name}`);
    },
  };
  return { db, releases, pointers };
}

/** A persisted (flattened) release document as publishBusinessPack stores it. */
function storedReleaseDoc(content: Record<string, unknown>, checksum: string, extra: Record<string, unknown> = {}) {
  return {
    tenantId: 'placemakers',
    environmentId: 'production',
    version: '1.0.0',
    versionId: '1.0.0',
    status: 'published',
    checksum,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    publishedBy: 'tester',
    ...content,
    ...extra,
  };
}

const validFixture = () => BusinessPackContentSchema.parse(clone(rawLegacyFixture));

const REQUIRED_ESTABLISHED_FIELDS = [
  'vocabulary',
  'entities',
  'conversationPolicy',
  'rules',
  'experience',
  'evaluations',
  'extensions',
] as const;

async function main() {
  console.log('🧪 Running Step 1 OKF hardening suite...\n');

  // ═══════════════════════════════════════════════════════════════════════
  // A. Checksum schema version fails closed
  // ═══════════════════════════════════════════════════════════════════════
  console.log('A. Unsupported checksumSchemaVersion fails closed');

  await test('supported versions are exactly absent/1 and 2', () => {
    assert.deepEqual([...SUPPORTED_CHECKSUM_SCHEMA_VERSIONS], [1, 2]);
    assert.equal(parseChecksumSchemaVersion(undefined), 1);
    assert.equal(parseChecksumSchemaVersion(1), 1);
    assert.equal(parseChecksumSchemaVersion(2), 2);
  });

  await test('algorithm selection is exhaustive: 1 -> legacy, 2 -> v2', () => {
    assert.equal(resolveChecksumAlgorithm(1), stableJsonLegacy);
    assert.equal(resolveChecksumAlgorithm(2), stableJsonV2);
    assert.throws(() => resolveChecksumAlgorithm(3 as any), /Unhandled checksumSchemaVersion/);
  });

  const UNSUPPORTED: unknown[] = [0, 3, 999, -1, -2, 1.5, '1', '2', 'v2', '', null, true, NaN, [], {}];

  await test('computePackChecksum rejects every unsupported checksumSchemaVersion', () => {
    for (const bad of UNSUPPORTED) {
      assert.throws(
        () => computePackChecksum({ ...validFixture(), checksumSchemaVersion: bad }),
        /Unsupported checksumSchemaVersion/,
        `version ${JSON.stringify(bad)} must be rejected`
      );
    }
    // supported values still hash
    assert.equal(computePackChecksum(validFixture()), GOLDEN);
    assert.match(computePackChecksum({ ...validFixture(), checksumSchemaVersion: 1 }), /^[0-9a-f]{64}$/);
    assert.match(computePackChecksum({ ...validFixture(), checksumSchemaVersion: 2 }), /^[0-9a-f]{64}$/);
  });

  await test('content schema rejects unsupported checksumSchemaVersion', () => {
    for (const bad of UNSUPPORTED) {
      const result = BusinessPackContentSchema.safeParse({ ...clone(rawLegacyFixture), checksumSchemaVersion: bad });
      assert.equal(result.success, false, `schema must reject ${JSON.stringify(bad)}`);
    }
    for (const good of [undefined, 1, 2]) {
      const result = BusinessPackContentSchema.safeParse({ ...clone(rawLegacyFixture), checksumSchemaVersion: good });
      assert.equal(result.success, true, `schema must accept ${String(good)}`);
    }
  });

  await test('PUBLISHER rejects unsupported checksumSchemaVersion and persists nothing', async () => {
    for (const bad of UNSUPPORTED) {
      const { db, releases, pointers } = createMockDb();
      await rejectsWith(
        () => publishBusinessPack(db, { ...clone(rawLegacyFixture), checksumSchemaVersion: bad }),
        /Schema validation failed/,
        `publisher version ${JSON.stringify(bad)}`
      );
      assert.equal(releases.length, 0, 'no release may be stored');
      assert.equal(pointers.length, 0, 'no pointer may be stored');
    }
  });

  await test('publisher accepts absent/1/2 checksumSchemaVersion', async () => {
    for (const good of [undefined, 1, 2]) {
      const { db, releases } = createMockDb();
      const pack: any = { ...clone(rawLegacyFixture) };
      if (good !== undefined) pack.checksumSchemaVersion = good;
      const result = await publishBusinessPack(db, pack);
      assert.equal(releases.length, 1);
      assert.equal(releases[0].checksum, result.checksum);
    }
  });

  await test('LOADER rejects stored releases with unsupported checksumSchemaVersion', async () => {
    for (const bad of UNSUPPORTED) {
      const content: any = { ...validFixture(), checksumSchemaVersion: bad };
      const doc = storedReleaseDoc(content, GOLDEN);
      const { db } = createMockDb({
        releases: [doc],
        pointers: [{ tenantId: 'placemakers', environmentId: 'production', activeVersion: '1.0.0' }],
      });
      const loader = new BusinessPackLoader({ db });
      const loaded = await quiet(() => loader.loadFromMongo('placemakers', 'production'));
      assert.equal(loaded, null, `loader must fail closed for version ${JSON.stringify(bad)}`);
      await rejectsWith(
        () => quiet(() => new BusinessPackLoader({ db }).loadPublished('placemakers', 'production')),
        /No published Business Pack found/,
        `loadPublished version ${JSON.stringify(bad)}`
      );
    }
  });

  await test('LOADER rejects unsupported checksumSchemaVersion inside nested packData', async () => {
    const doc = {
      tenantId: 'placemakers',
      environmentId: 'production',
      version: '1.0.0',
      checksum: GOLDEN,
      packData: { ...validFixture(), checksumSchemaVersion: 3 },
    };
    const { db } = createMockDb({ releases: [doc] });
    const loaded = await quiet(() => new BusinessPackLoader({ db }).loadFromMongo('placemakers', 'production', '1.0.0'));
    assert.equal(loaded, null);
  });

  await test('rollback rejects a target release with unsupported checksumSchemaVersion', async () => {
    const doc = storedReleaseDoc({ ...validFixture(), checksumSchemaVersion: 3 }, GOLDEN);
    const { db } = createMockDb({
      releases: [doc],
      pointers: [
        {
          tenantId: 'placemakers',
          environmentId: 'production',
          activeVersion: '1.0.1',
          previousVersion: '1.0.0',
          revision: 1,
        },
      ],
    });
    await rejectsWith(
      () => rollbackBusinessPack(db, 'placemakers', 'production'),
      /Rollback failed/,
      'rollback unsupported version'
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // B. Established fields stay strict & default-free
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nB. Established Business Pack content remains strict');

  await test('only factRegistry and knowledgeModel are new optional fields', () => {
    const full = clone(rawLegacyFixture) as any;
    assert.equal(BusinessPackContentSchema.safeParse(full).success, true);
    // new OKF fields are optional
    assert.equal('factRegistry' in BusinessPackContentSchema.parse(full), false);
    assert.equal('knowledgeModel' in BusinessPackContentSchema.parse(full), false);
    // every established field is required
    for (const field of ['manifest', 'profile', 'modelPolicy', 'agents', 'journeys', 'capabilities', ...REQUIRED_ESTABLISHED_FIELDS]) {
      const incomplete = clone(rawLegacyFixture) as any;
      delete incomplete[field];
      assert.equal(
        BusinessPackContentSchema.safeParse(incomplete).success,
        false,
        `'${field}' must be required`
      );
    }
  });

  await test('Zod parsing injects no top-level defaults into checksum-bearing content', () => {
    const parsed = BusinessPackContentSchema.parse(clone(rawLegacyFixture));
    const rawKeys = Object.keys(rawLegacyFixture).sort();
    const parsedKeys = Object.keys(parsed).sort();
    assert.deepEqual(parsedKeys, rawKeys, 'parsing must not add or drop top-level keys');
    assert.equal(computePackChecksum(parsed), GOLDEN);
  });

  await test('PUBLISHER fails closed for each incomplete pack and persists nothing', async () => {
    for (const field of REQUIRED_ESTABLISHED_FIELDS) {
      const incomplete = clone(rawLegacyFixture) as any;
      delete incomplete[field];
      const { db, releases, pointers } = createMockDb();
      await rejectsWith(
        () => publishBusinessPack(db, incomplete),
        new RegExp(`Schema validation failed.*${field}`, 's'),
        `publisher missing ${field}`
      );
      assert.equal(releases.length, 0);
      assert.equal(pointers.length, 0);
    }
  });

  await test('publisher rejects null/empty-wrong-type established fields', async () => {
    for (const field of REQUIRED_ESTABLISHED_FIELDS) {
      const bad = clone(rawLegacyFixture) as any;
      bad[field] = null;
      const { db } = createMockDb();
      await rejectsWith(() => publishBusinessPack(db, bad), /Schema validation failed/, `publisher null ${field}`);
    }
  });

  await test('LOADER fails closed for stored releases missing an established field', async () => {
    for (const field of ['vocabulary', 'entities', 'conversationPolicy', 'rules', 'experience', 'evaluations'] as const) {
      const content: any = { ...validFixture() };
      delete content[field];
      const { db } = createMockDb({ releases: [storedReleaseDoc(content, GOLDEN)] });
      const loaded = await quiet(() => new BusinessPackLoader({ db }).loadFromMongo('placemakers', 'production', '1.0.0'));
      assert.equal(loaded, null, `loader must reject stored release missing '${field}'`);
    }
  });

  await test('rollback fails closed when the target release is incomplete', async () => {
    const content: any = { ...validFixture() };
    delete content.vocabulary;
    const { db } = createMockDb({
      releases: [storedReleaseDoc(content, GOLDEN)],
      pointers: [
        { tenantId: 'placemakers', environmentId: 'production', activeVersion: '1.0.1', previousVersion: '1.0.0', revision: 1 },
      ],
    });
    await rejectsWith(() => rollbackBusinessPack(db, 'placemakers', 'production'), /incomplete_content/, 'rollback incomplete');
  });

  await test('explicit legacy normalization: only absent `extensions` on legacy content -> {}', async () => {
    const legacyContent: any = { ...validFixture() };
    delete legacyContent.extensions; // pre-9be7b80 stored release shape
    assert.deepEqual(normalizeLegacyStoredContent(legacyContent).extensions, {});
    // v1/v2 content is never normalized
    for (const version of [1, 2]) {
      const versioned: any = { ...legacyContent, checksumSchemaVersion: version };
      assert.equal(normalizeLegacyStoredContent(versioned).extensions, undefined);
    }
    // an existing value is never overwritten
    const withExt: any = { ...validFixture(), extensions: { spacePlanner: undefined, custom: 1 } };
    assert.equal(normalizeLegacyStoredContent(withExt), withExt);

    // Loader re-verifies such a legacy release against the checksum that hashed `extensions: {}`
    const { db } = createMockDb({ releases: [storedReleaseDoc(legacyContent, GOLDEN)] });
    const loaded = await quiet(() => new BusinessPackLoader({ db }).loadFromMongo('placemakers', 'production', '1.0.0'));
    assert.ok(loaded, 'legacy release lacking extensions must still verify');
    assert.deepEqual(loaded!.extensions, {});

    // ...but a v2 release lacking extensions is incomplete and must fail closed
    const v2Content: any = { ...legacyContent, checksumSchemaVersion: 2 };
    const v2Doc = storedReleaseDoc(v2Content, GOLDEN);
    const { db: db2 } = createMockDb({ releases: [v2Doc] });
    const loadedV2 = await quiet(() => new BusinessPackLoader({ db: db2 }).loadFromMongo('placemakers', 'production', '1.0.0'));
    assert.equal(loadedV2, null);

    // ...and publication never applies normalization
    const { db: db3 } = createMockDb();
    await rejectsWith(() => publishBusinessPack(db3, legacyContent), /Schema validation failed.*extensions/s, 'publish missing extensions');
  });

  await test('only `extensions` has a legacy storage fallback (other fields never normalized)', () => {
    for (const field of REQUIRED_ESTABLISHED_FIELDS.filter((f) => f !== 'extensions')) {
      const content: any = { ...validFixture() };
      delete content[field];
      assert.equal(normalizeLegacyStoredContent(content)[field as keyof typeof content], undefined);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // C. Default journey selection
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nC. Publication default-journey selection');

  const J = (journeyId: string, extra: Record<string, unknown> = {}) => ({ journeyId, ...extra });

  await test('explicit valid routingPolicy.defaultJourneyId wins (over markers and position)', () => {
    const policy = resolvePublicationRoutingPolicy({
      configured: { defaultJourneyId: 'j_b', fallbackOnCatalogSearch: false },
      journeys: [J('j_a', { isDefaultConsultant: true }), J('j_b'), J('j_c')],
    });
    assert.deepEqual(policy, { defaultJourneyId: 'j_b', fallbackOnCatalogSearch: false });
  });

  await test('journey explicitly marked default is selected (flag and metadata)', () => {
    const viaFlag = resolvePublicationRoutingPolicy({
      journeys: [J('j_a'), J('j_b', { isDefaultConsultant: true }), J('j_c')],
    });
    assert.equal(viaFlag.defaultJourneyId, 'j_b');
    assert.equal(viaFlag.fallbackOnCatalogSearch, true);
    const viaMeta = resolvePublicationRoutingPolicy({
      journeys: [J('j_a'), J('j_b'), J('j_c', { metadata: { isDefaultConsultant: true } })],
    });
    assert.equal(viaMeta.defaultJourneyId, 'j_c');
  });

  await test('exactly one journey is inferred', () => {
    const policy = resolvePublicationRoutingPolicy({ configured: null, journeys: [J('only_one')] });
    assert.deepEqual(policy, { defaultJourneyId: 'only_one', fallbackOnCatalogSearch: true });
    // configured routingPolicy without defaultJourneyId keeps other fields and infers
    const keepFallback = resolvePublicationRoutingPolicy({
      configured: { fallbackOnCatalogSearch: false },
      journeys: [J('only_one')],
    });
    assert.deepEqual(keepFallback, { defaultJourneyId: 'only_one', fallbackOnCatalogSearch: false });
  });

  await test('multiple journeys without an unambiguous default are rejected (never journeys[0])', () => {
    assert.throws(
      () => resolvePublicationRoutingPolicy({ journeys: [J('j_a'), J('j_b')] }),
      (err: unknown) =>
        err instanceof RoutingPolicyResolutionError &&
        /2 journeys exist \[j_a, j_b\].*routingPolicy\.defaultJourneyId/s.test(err.message)
    );
    assert.throws(
      () => resolvePublicationRoutingPolicy({ configured: { fallbackOnCatalogSearch: true }, journeys: [J('j_a'), J('j_b'), J('j_c')] }),
      RoutingPolicyResolutionError
    );
  });

  await test('multiple journeys marked default are ambiguous and rejected', () => {
    assert.throws(
      () =>
        resolvePublicationRoutingPolicy({
          journeys: [J('j_a', { isDefaultConsultant: true }), J('j_b', { metadata: { isDefaultConsultant: true } })],
        }),
      /Ambiguous default journey.*j_a, j_b/s
    );
  });

  await test('invalid configured defaultJourneyId is rejected (no fallback to marker/single/position)', () => {
    assert.throws(
      () =>
        resolvePublicationRoutingPolicy({
          configured: { defaultJourneyId: 'does_not_exist' },
          journeys: [J('only_one')],
        }),
      (err: unknown) => err instanceof RoutingPolicyResolutionError && /'does_not_exist'.*does not match any journey/s.test(err.message)
    );
    assert.throws(
      () =>
        resolvePublicationRoutingPolicy({
          configured: { defaultJourneyId: 'does_not_exist' },
          journeys: [J('j_a', { isDefaultConsultant: true }), J('j_b')],
        }),
      RoutingPolicyResolutionError
    );
  });

  await test('no journeys is rejected', () => {
    assert.throws(() => resolvePublicationRoutingPolicy({ journeys: [] }), /no journeys/);
  });

  await test('PUBLISHER rejects a dangling configured routingPolicy.defaultJourneyId', async () => {
    const { db, releases } = createMockDb();
    await rejectsWith(
      () =>
        publishBusinessPack(db, {
          ...clone(rawLegacyFixture),
          routingPolicy: { defaultJourneyId: 'journey_does_not_exist', fallbackOnCatalogSearch: true },
        }),
      /routingPolicy\.defaultJourneyId 'journey_does_not_exist' does not match any journey/,
      'publisher dangling default'
    );
    assert.equal(releases.length, 0);
  });

  await test('PUBLISHER stores a valid explicit default and the checksum covers it', async () => {
    const { db, releases } = createMockDb();
    const result = await publishBusinessPack(db, {
      ...clone(rawLegacyFixture),
      routingPolicy: { defaultJourneyId: 'journey_laundry_renovation', fallbackOnCatalogSearch: true },
    });
    assert.equal(releases[0].routingPolicy.defaultJourneyId, 'journey_laundry_renovation');
    assert.notEqual(result.checksum, GOLDEN);
  });

  await test('LOADER rejects a stored release whose default journey does not exist', async () => {
    const content: any = { ...validFixture(), routingPolicy: { defaultJourneyId: 'ghost', fallbackOnCatalogSearch: true } };
    const checksum = computePackChecksum(content);
    const { db } = createMockDb({ releases: [storedReleaseDoc(content, checksum)] });
    const loaded = await quiet(() => new BusinessPackLoader({ db }).loadFromMongo('placemakers', 'production', '1.0.0'));
    assert.equal(loaded, null);
  });

  await test('project-service publication contains no positional or fabricated default journey', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../apps/project-service/src/business-pack-publication.service.ts'),
      'utf8'
    );
    assert.equal(/journeys\[0\]/i.test(source), false, 'must not select journeys[0]');
    assert.equal(/validatedJourneys\[0\]/.test(source), false, 'must not select validatedJourneys[0]');
    assert.equal(/_materials_hardware/.test(source), false, 'must not fabricate a tenant default journey id');
    assert.equal(/resolvePublicationRoutingPolicy/.test(source), true, 'must use the explicit resolver');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // D. Storage-envelope boundary
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nD. Storage-envelope boundary');

  const meta = {
    _id: 'oid_1',
    tenantId: 'placemakers',
    environmentId: 'production',
    version: '1.0.0',
    versionId: '1.0.0',
    status: 'published',
    checksum: GOLDEN,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    publishedBy: 'tester',
    promotedAt: '2026-01-02T00:00:00Z',
    promotedBy: 'rm',
    revision: 3,
    notes: 'n',
    operationalState: { status: 'withdrawn', withdrawalReason: 'x' },
    evaluationResult: { passed: true },
  };

  await test('flattened envelope: metadata is separated from content and never hashed', () => {
    const doc = { ...meta, ...validFixture() };
    const result = parsePersistedRelease(doc);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(Object.keys(result.content).sort(), Object.keys(validFixture()).sort());
    for (const metaKey of Object.keys(meta)) {
      assert.equal(metaKey in result.content, false, `${metaKey} must not leak into content`);
    }
    assert.equal(result.envelope.checksum, GOLDEN);
    assert.equal(computePackChecksum(result.content), GOLDEN);
  });

  await test('nested packData envelope: same content and checksum as the flattened form', () => {
    const nested = { ...meta, packData: validFixture() };
    const flat = { ...meta, ...validFixture() };
    const a = parsePersistedRelease(nested);
    const b = parsePersistedRelease(flat);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.deepEqual(a.content, b.content);
    assert.equal(computePackChecksum(a.content), GOLDEN);
    assert.equal('packData' in a.content, false);
  });

  await test('envelope parsing never injects defaults into content slots', () => {
    const sparse = { ...meta, capabilities: { toolDefinitions: [] }, agents: [] };
    const result = parsePersistedRelease(sparse);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.content, { capabilities: { toolDefinitions: [] }, agents: [] });
  });

  await test('malformed envelopes are rejected', () => {
    const malformed: Array<[string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['string', 'release'],
      ['number', 42],
      ['array', [validFixture()]],
      ['packData as array', { ...meta, packData: [validFixture()] }],
      ['packData as string', { ...meta, packData: 'oops' }],
      ['packData as null', { ...meta, packData: null }],
      ['both packData and flattened content', { ...meta, ...validFixture(), packData: validFixture() }],
      ['both packData and a single flattened key', { ...meta, packData: validFixture(), journeys: [] }],
      ['numeric tenantId', { ...meta, tenantId: 123 }],
      ['empty version', { ...meta, version: '' }],
      ['numeric status', { ...meta, status: 1 }],
      ['numeric checksum', { ...meta, checksum: 12345 }],
      ['numeric publishedAt', { ...meta, publishedAt: 1767225600000 }],
      ['bad operationalState.status', { ...meta, operationalState: { status: 'exploded' } }],
      ['agents not an array', { ...meta, ...validFixture(), agents: { a: 1 } }],
      ['manifest not an object', { ...meta, ...validFixture(), manifest: 'm' }],
      ['capabilities as array', { ...meta, ...validFixture(), capabilities: [] }],
      ['unsupported checksumSchemaVersion', { ...meta, ...validFixture(), checksumSchemaVersion: 3 }],
      ['unsupported nested checksumSchemaVersion', { ...meta, packData: { ...validFixture(), checksumSchemaVersion: '2' } }],
    ];
    for (const [label, doc] of malformed) {
      const result = parsePersistedRelease(doc);
      assert.equal(result.ok, false, `malformed envelope '${label}' must be rejected`);
      assert.equal(BusinessPackEnvelopeSchema.safeParse(doc).success, false, `schema must reject '${label}'`);
    }
  });

  await test('legacy storage forms (`content` / `businessPack` wrappers) are NOT supported', () => {
    // no repository evidence for these shapes: they must yield no content, never be silently unwrapped
    for (const wrapper of ['content', 'businessPack']) {
      const doc = { ...meta, [wrapper]: validFixture() };
      const parsed = parsePersistedRelease(doc);
      assert.ok(parsed.ok);
      if (!parsed.ok) return;
      assert.deepEqual(parsed.content, {}, `'${wrapper}' wrapper must not be unwrapped`);
      assert.equal(Object.keys(extractPackContent(doc)).length, 0);
    }
  });

  await test('LOADER loads both legitimate storage representations with identical result', async () => {
    const flatDoc = storedReleaseDoc(validFixture() as any, GOLDEN);
    const nestedDoc = {
      tenantId: 'placemakers',
      environmentId: 'production',
      version: '1.0.0',
      versionId: '1.0.0',
      status: 'published',
      checksum: GOLDEN,
      packData: validFixture(),
    };
    const loadedFlat = await quiet(() =>
      new BusinessPackLoader({ db: createMockDb({ releases: [flatDoc] }).db }).loadFromMongo('placemakers', 'production', '1.0.0')
    );
    const loadedNested = await quiet(() =>
      new BusinessPackLoader({ db: createMockDb({ releases: [nestedDoc] }).db }).loadFromMongo('placemakers', 'production', '1.0.0')
    );
    assert.ok(loadedFlat && loadedNested);
    assert.deepEqual(loadedFlat, loadedNested);
    assert.equal(computePackChecksum(loadedFlat), GOLDEN);
  });

  await test('LOADER fails closed on malformed / ambiguous envelopes', async () => {
    const bad: unknown[] = [
      { ...storedReleaseDoc(validFixture() as any, GOLDEN), tenantId: 99 },
      { ...storedReleaseDoc(validFixture() as any, GOLDEN), packData: validFixture() },
      { ...storedReleaseDoc(validFixture() as any, GOLDEN), publishedAt: 12345 },
      { ...storedReleaseDoc(validFixture() as any, GOLDEN), checksum: 12345 },
    ];
    for (const doc of bad) {
      const { db } = createMockDb({ releases: [doc] });
      const loaded = await quiet(() =>
        new BusinessPackLoader({ db }).loadFromMongo(
          (doc as any).tenantId === 99 ? (99 as any) : 'placemakers',
          'production',
          '1.0.0'
        )
      );
      assert.equal(loaded, null);
    }
  });

  await test('rollback fails closed on a malformed target envelope', async () => {
    const doc = { ...storedReleaseDoc(validFixture() as any, GOLDEN), packData: validFixture() };
    const { db } = createMockDb({
      releases: [doc],
      pointers: [
        { tenantId: 'placemakers', environmentId: 'production', activeVersion: '1.0.1', previousVersion: '1.0.0', revision: 1 },
      ],
    });
    await rejectsWith(() => rollbackBusinessPack(db, 'placemakers', 'production'), /malformed_envelope/, 'rollback malformed envelope');
  });

  await test('rollback succeeds for a well-formed release (flattened and nested)', async () => {
    for (const doc of [
      storedReleaseDoc(validFixture() as any, GOLDEN),
      { tenantId: 'placemakers', environmentId: 'production', version: '1.0.0', checksum: GOLDEN, packData: validFixture() },
    ]) {
      const { db, pointers } = createMockDb({
        releases: [doc],
        pointers: [
          { tenantId: 'placemakers', environmentId: 'production', activeVersion: '1.0.1', previousVersion: '1.0.0', revision: 1 },
        ],
      });
      const result = await quiet(() => rollbackBusinessPack(db, 'placemakers', 'production'));
      assert.equal(result.activeVersion, '1.0.0');
      assert.equal(pointers[0].activeVersion, '1.0.0');
    }
  });

  await test('canonical key list is complete and envelope-only keys are excluded', () => {
    for (const k of ['_id', 'tenantId', 'environmentId', 'version', 'versionId', 'status', 'checksum', 'publishedAt', 'operationalState', 'packData']) {
      assert.equal((CANONICAL_CONTENT_KEYS as readonly string[]).includes(k), false, `${k} is envelope-only`);
    }
  });

  console.log('\n==================================================');
  console.log(`Step 1 hardening suite: ${passed} passed, ${failed} failed`);
  console.log('==================================================\n');
  if (failed > 0) {
    console.error('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
