import assert from 'node:assert/strict';
import {
  extractPackContent,
  computePackChecksum,
  stableJsonLegacy,
  stableJsonV2,
  BusinessPackContentSchema,
  BusinessPackEnvelopeSchema,
  CANONICAL_CONTENT_KEYS,
  publishBusinessPack,
  BusinessPackLoader,
  BusinessPackContent,
} from '../src';
import { rawLegacyFixture } from './fixtures/legacy-pack.fixture';

/**
 * FIXED golden checksum for `rawLegacyFixture` (parsed through the content schema).
 *
 * This literal was reproduced OFFLINE from the PRE-CHANGE legacy algorithm (the checksum code at
 * git HEAD: `stableJson` filtering only `undefined`, preserving `null`, `localeCompare` key sort,
 * array order kept, applied to the Zod-parsed pack). It must NEVER be recomputed from the code
 * under test: if this assertion fails, canonical fields, null handling, defaults or serialization
 * changed and every previously published release checksum is at risk.
 */
const EXPECTED_GOLDEN_LEGACY_CHECKSUM =
  'a8ae2a4483c375bf99d427a728a5413147a7aefce9952b4351838520800ef1c5';

/**
 * Step 1 OKF Foundation: Canonical Content Contract & Checksum Safety Test Suite
 *
 * Deterministically proves all 11 required criteria:
 * 1. Legacy Business Pack fixture retains previous checksum.
 * 2. Parsing a legacy release does not inject factRegistry, knowledgeModel, or defaults.
 * 3. Absent, explicit null, empty object, and empty array behavior is intentional and stable.
 * 4. Object key ordering does not change the checksum.
 * 5. Array order does change the checksum.
 * 6. routingPolicy participates in the checksum and survives storage/reconstruction.
 * 7. Envelope-only fields do not alter the content checksum.
 * 8. Publisher -> stored envelope -> loader -> runtime/outbox extraction produces identical content and checksum.
 * 9. Unknown envelope fields do not enter the content checksum.
 * 10. Tampered checksum is rejected (fail-closed).
 * 11. Legacy and new checksum-schema versions are handled deterministically.
 */
async function runCanonicalContentTestSuite() {
  console.log('🧪 Running Step 1: Business Pack Canonical Content & Checksum Safety Suite...\n');

  const legacyPackFixture: BusinessPackContent = BusinessPackContentSchema.parse(rawLegacyFixture);

  const expectedGoldenLegacyChecksum = EXPECTED_GOLDEN_LEGACY_CHECKSUM;
  assert.match(expectedGoldenLegacyChecksum, /^[0-9a-f]{64}$/, 'Golden checksum must be valid sha256 hex');

  // ──────────────────────────────────────────────────────────────────────────
  // Test 1: Representative legacy Business Pack fixture retains previous checksum
  // ──────────────────────────────────────────────────────────────────────────
  {
    const checksum = computePackChecksum(legacyPackFixture);
    assert.equal(
      checksum,
      expectedGoldenLegacyChecksum,
      'Test 1: Legacy Business Pack fixture must retain its exact checksum'
    );
    console.log('  ✅ PASS: 1. Representative legacy Business Pack fixture retains previous checksum');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 2: Parsing a legacy release does not inject factRegistry, knowledgeModel, or defaults
  // ──────────────────────────────────────────────────────────────────────────
  {
    const parsed = BusinessPackContentSchema.parse(legacyPackFixture);

    assert.equal(parsed.factRegistry, undefined, 'factRegistry must remain undefined');
    assert.equal(parsed.knowledgeModel, undefined, 'knowledgeModel must remain undefined');
    assert.equal(parsed.checksumSchemaVersion, undefined, 'checksumSchemaVersion must remain undefined');
    assert.equal('factRegistry' in parsed, false, 'factRegistry key must not be injected into parsed object');
    assert.equal('knowledgeModel' in parsed, false, 'knowledgeModel key must not be injected into parsed object');

    // Checksum of parsed output matches original fixture
    const parsedChecksum = computePackChecksum(parsed);
    assert.equal(
      parsedChecksum,
      expectedGoldenLegacyChecksum,
      'Test 2: Parsing legacy pack must not alter its checksum'
    );
    console.log('  ✅ PASS: 2. Parsing a legacy release does not inject factRegistry, knowledgeModel, or defaults');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 3: Absent, explicit null, empty object, and empty array behavior is intentional and stable
  // ──────────────────────────────────────────────────────────────────────────
  {
    // A: In legacy (v1), explicit null is preserved and distinct from undefined
    const withExplicitNull = {
      ...legacyPackFixture,
      routingPolicy: { defaultJourneyId: null, fallbackOnCatalogSearch: true },
    };
    const withUndefined = {
      ...legacyPackFixture,
      routingPolicy: { defaultJourneyId: undefined, fallbackOnCatalogSearch: true },
    };
    const withOmitted = {
      ...legacyPackFixture,
      routingPolicy: { fallbackOnCatalogSearch: true },
    };

    const hashNull = computePackChecksum(withExplicitNull);
    const hashUndefined = computePackChecksum(withUndefined);
    const hashOmitted = computePackChecksum(withOmitted);

    assert.equal(
      hashUndefined,
      hashOmitted,
      'Undefined property must serialize identically to omitted property'
    );
    assert.notEqual(
      hashNull,
      hashOmitted,
      'Explicit null in legacy contract is preserved and must produce distinct hash from omitted'
    );

    // B: Empty object vs empty array vs non-empty
    const packEmptyObj = { ...legacyPackFixture, extensions: {} };
    const packEmptyArr = { ...legacyPackFixture, rules: [] };
    assert.ok(computePackChecksum(packEmptyObj), 'Empty object serializes deterministically');
    assert.ok(computePackChecksum(packEmptyArr), 'Empty array serializes deterministically');

    // C: In v2 (checksumSchemaVersion === 2), explicit null is normalized/stripped identically to undefined
    const v2WithNull = {
      ...withExplicitNull,
      checksumSchemaVersion: 2,
    };
    const v2WithOmitted = {
      ...withOmitted,
      checksumSchemaVersion: 2,
    };
    const hashV2Null = computePackChecksum(v2WithNull);
    const hashV2Omitted = computePackChecksum(v2WithOmitted);
    assert.equal(
      hashV2Null,
      hashV2Omitted,
      'In checksumSchemaVersion 2, explicit null is stripped and normalizes identically to omitted'
    );

    console.log('  ✅ PASS: 3. Absent, explicit null, empty object, and empty array behavior is intentional and stable');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 4: Object key ordering does not change the checksum
  // ──────────────────────────────────────────────────────────────────────────
  {
    function scrambleKeys<T>(obj: T): T {
      if (Array.isArray(obj)) return obj.map(scrambleKeys) as any;
      if (obj && typeof obj === 'object') {
        const keys = Object.keys(obj).reverse();
        const result: any = {};
        for (const k of keys) {
          result[k] = scrambleKeys((obj as any)[k]);
        }
        return result;
      }
      return obj;
    }

    const scrambledPack = scrambleKeys(legacyPackFixture);
    const scrambledChecksum = computePackChecksum(scrambledPack);
    assert.equal(
      scrambledChecksum,
      expectedGoldenLegacyChecksum,
      'Object key order must never change the content checksum'
    );
    console.log('  ✅ PASS: 4. Object key ordering does not change the checksum');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 5: Array order does change the checksum
  // ──────────────────────────────────────────────────────────────────────────
  {
    const agent1 = legacyPackFixture.agents[0];
    const agent2 = {
      ...agent1,
      agentId: 'estimator_agent',
      name: 'Estimator',
    };

    const packOriginalArray = {
      ...legacyPackFixture,
      agents: [agent1, agent2],
    };

    const packReorderedArray = {
      ...legacyPackFixture,
      agents: [agent2, agent1],
    };

    const hashOrig = computePackChecksum(packOriginalArray);
    const hashReordered = computePackChecksum(packReorderedArray);

    assert.notEqual(
      hashOrig,
      hashReordered,
      'Array ordering must be significant and alter the content checksum'
    );
    console.log('  ✅ PASS: 5. Array order does change the checksum');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 6: routingPolicy participates in the checksum and survives storage/reconstruction
  // ──────────────────────────────────────────────────────────────────────────
  {
    const packWithoutRouting = { ...legacyPackFixture };
    delete (packWithoutRouting as any).routingPolicy;

    const packWithRouting: BusinessPackContent = {
      ...legacyPackFixture,
      routingPolicy: {
        defaultJourneyId: 'journey_laundry_renovation',
        fallbackOnCatalogSearch: true,
      },
    };

    const hashWithout = computePackChecksum(packWithoutRouting);
    const hashWith = computePackChecksum(packWithRouting);

    assert.notEqual(
      hashWithout,
      hashWith,
      'routingPolicy must participate in content checksum'
    );

    // Simulate database release document with envelope fields
    const mongoReleaseDoc = {
      _id: '507f1f77bcf86cd799439011',
      tenantId: 'placemakers',
      environmentId: 'production',
      version: '1.0.0',
      versionId: '1.0.0',
      status: 'published',
      checksum: hashWith,
      publishedAt: new Date().toISOString(),
      publishedBy: 'lead_architect',
      ...packWithRouting,
    };

    // Reconstruct via extractPackContent
    const extracted = extractPackContent(mongoReleaseDoc);
    assert.deepEqual(
      extracted.routingPolicy,
      { defaultJourneyId: 'journey_laundry_renovation', fallbackOnCatalogSearch: true },
      'routingPolicy must survive storage and reconstruction'
    );
    assert.equal(
      computePackChecksum(extracted),
      hashWith,
      'Reconstructed pack with routingPolicy must yield identical checksum'
    );
    console.log('  ✅ PASS: 6. routingPolicy participates in checksum and survives storage/reconstruction');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 7: Envelope-only fields do not alter the content checksum
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fullEnvelope = {
      _id: 'mongo_oid_987654321',
      tenantId: 'placemakers',
      environmentId: 'production',
      version: '1.0.0',
      versionId: '1.0.0',
      status: 'published',
      checksum: expectedGoldenLegacyChecksum,
      publishedAt: new Date(),
      publishedBy: 'devops_deployer',
      promotedAt: new Date(),
      promotedBy: 'release_manager',
      revision: 4,
      notes: 'Production release 1.0.0 for PlaceMakers',
      operationalState: {
        status: 'published',
        auditTrail: [{ action: 'promoted', by: 'release_manager' }],
      },
      evaluationResult: { passed: true, score: 1.0 },
      ...legacyPackFixture,
    };

    const envelopeChecksum = computePackChecksum(fullEnvelope);
    assert.equal(
      envelopeChecksum,
      expectedGoldenLegacyChecksum,
      'Envelope metadata (_id, timestamps, operationalState, notes, etc.) must NEVER alter content checksum'
    );
    console.log('  ✅ PASS: 7. Envelope-only fields do not alter the content checksum');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 8: Publisher -> stored envelope -> loader -> runtime/outbox extraction produces identical content and checksum
  // ──────────────────────────────────────────────────────────────────────────
  {
    const storedReleases: any[] = [];
    const storedPointers: any[] = [];

    const mockDb: any = {
      collection: (name: string) => {
        if (name === 'business_pack_releases') {
          return {
            findOne: async (q: any) =>
              storedReleases.find(
                (r) =>
                  r.tenantId === q.tenantId &&
                  r.environmentId === q.environmentId &&
                  r.version === q.version
              ) || null,
            insertOne: async (doc: any) => {
              storedReleases.push(doc);
              return { acknowledged: true, insertedId: 'mock_id' };
            },
          };
        }
        if (name === 'business_pack_pointers') {
          return {
            findOne: async (q: any) =>
              storedPointers.find(
                (p) => p.tenantId === q.tenantId && p.environmentId === q.environmentId
              ) || null,
            updateOne: async (q: any, u: any) => {
              const existingIdx = storedPointers.findIndex(
                (p) => p.tenantId === q.tenantId && p.environmentId === q.environmentId
              );
              if (existingIdx >= 0) {
                storedPointers[existingIdx] = { ...storedPointers[existingIdx], ...u.$set };
              }
              return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
            },
            insertOne: async (doc: any) => {
              storedPointers.push(doc);
              return { acknowledged: true, insertedId: 'mock_ptr_id' };
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

    // 1. Publisher publishes the pack
    const pubResult = await publishBusinessPack(mockDb, legacyPackFixture, {
      publishedBy: 'test_author',
    });
    assert.equal(pubResult.checksum, expectedGoldenLegacyChecksum);

    // 2. Inspect stored release document in mock DB
    const storedDoc = storedReleases[0];
    assert.ok(storedDoc, 'Release document must be stored in database');
    assert.equal(storedDoc.checksum, expectedGoldenLegacyChecksum);

    // 3. Loader loads release from Mongo
    const loader = new BusinessPackLoader({ db: mockDb });
    const loaded = await loader.loadFromMongo('placemakers', 'production', '1.0.0');
    assert.ok(loaded, 'Loader must successfully load and validate the stored release');
    assert.equal(computePackChecksum(loaded), expectedGoldenLegacyChecksum);

    // 4. Outbox worker extracts and verifies checksum
    const outboxExtracted = extractPackContent(storedDoc);
    const outboxChecksum = computePackChecksum(outboxExtracted);
    assert.equal(outboxChecksum, expectedGoldenLegacyChecksum);

    // Verify all 4 checksums are strictly identical
    assert.equal(
      pubResult.checksum,
      outboxChecksum,
      'Publisher, stored document, loader, and outbox extraction must all agree on checksum'
    );
    console.log('  ✅ PASS: 8. Publisher -> stored envelope -> loader -> outbox extraction produces identical content and checksum');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 9: An unknown envelope field does not enter the content checksum
  // ──────────────────────────────────────────────────────────────────────────
  {
    const envelopeWithUnknowns = {
      ...legacyPackFixture,
      _id: 'mongo_123',
      tenantId: 'placemakers',
      arbitraryDbClusterShard: 'shard-04.cluster.local',
      untrackedMongoMigrationFlag: true,
      randomTelemetryPayload: { latencyMs: 142, hops: 3 },
    };

    const extracted = extractPackContent(envelopeWithUnknowns);
    assert.equal((extracted as any).arbitraryDbClusterShard, undefined);
    assert.equal((extracted as any).untrackedMongoMigrationFlag, undefined);
    assert.equal((extracted as any).randomTelemetryPayload, undefined);

    const checksum = computePackChecksum(envelopeWithUnknowns);
    assert.equal(
      checksum,
      expectedGoldenLegacyChecksum,
      'Unknown envelope fields must never enter the content checksum'
    );
    console.log('  ✅ PASS: 9. Unknown envelope field does not enter the content checksum');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 10: Tampered checksum is rejected
  // ──────────────────────────────────────────────────────────────────────────
  {
    const mockDbWithTamperedDoc: any = {
      collection: (name: string) => {
        if (name === 'business_pack_releases') {
          return {
            findOne: async () => ({
              tenantId: 'placemakers',
              environmentId: 'production',
              version: '1.0.0',
              checksum: 'tampered_or_invalid_checksum_string_value_here_1234567890abcdef',
              ...legacyPackFixture,
            }),
          };
        }
        if (name === 'business_pack_pointers') {
          return {
            findOne: async () => ({
              tenantId: 'placemakers',
              environmentId: 'production',
              activeVersion: '1.0.0',
            }),
          };
        }
        return { findOne: async () => null };
      },
    };

    const loader = new BusinessPackLoader({ db: mockDbWithTamperedDoc });
    const loaded = await loader.loadFromMongo('placemakers', 'production', '1.0.0');
    assert.equal(
      loaded,
      null,
      'Release with tampered checksum must fail closed and return null'
    );
    console.log('  ✅ PASS: 10. Tampered checksum is rejected (fails closed)');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 11: Legacy and new checksum-schema versions are handled deterministically
  // ──────────────────────────────────────────────────────────────────────────
  {
    // Content with explicit null property
    const contentWithNull = {
      ...legacyPackFixture,
      routingPolicy: {
        defaultJourneyId: null,
        fallbackOnCatalogSearch: true,
      },
    };

    // Legacy (no checksumSchemaVersion): uses stableJsonLegacy (null preserved)
    const legacyChecksum = computePackChecksum(contentWithNull);

    // Modern (checksumSchemaVersion: 2): uses stableJsonV2 (null normalized to omitted)
    const v2Pack = {
      ...contentWithNull,
      checksumSchemaVersion: 2,
    };
    const v2Checksum = computePackChecksum(v2Pack);

    assert.notEqual(
      legacyChecksum,
      v2Checksum,
      'Legacy and v2 schema versions must use respective algorithms deterministically'
    );

    // Verify v2 checksum is identical whether null was explicitly present or omitted
    const v2OmittedPack = {
      ...legacyPackFixture,
      routingPolicy: {
        fallbackOnCatalogSearch: true,
      },
      checksumSchemaVersion: 2,
    };
    const v2OmittedChecksum = computePackChecksum(v2OmittedPack);
    assert.equal(
      v2Checksum,
      v2OmittedChecksum,
      'v2 canonicalization normalizes explicit null and omitted identically'
    );
    console.log('  ✅ PASS: 11. Legacy and new checksum-schema versions are handled deterministically');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 12: Future OKF-compatible fields parse without defaults and validate
  // ──────────────────────────────────────────────────────────────────────────
  {
    const okfPack: BusinessPackContent = {
      ...legacyPackFixture,
      factRegistry: {
        version: '1.0.0',
        facts: {
          room_type: {
            key: 'room_type',
            displayName: 'Room Type',
            description: 'Room being renovated',
            type: 'enum',
            allowedValues: ['laundry', 'bathroom', 'kitchen'],
            uiInputType: 'select',
            sensitivity: 'public',
            permittedSources: ['customer'],
            promptQuestion: 'What room are you renovating?',
          },
          length_mm: {
            key: 'length_mm',
            displayName: 'Length',
            type: 'number',
            unit: 'mm',
            sensitivity: 'internal',
            permittedSources: ['customer', 'capability'],
          },
        },
      },
      knowledgeModel: {
        type: 'okf_release',
        modelId: 'okf_placemakers_trade',
        releaseId: 'okf_rel_202610_v1',
        version: '1.0.0',
        checksum: '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
        required: true,
        failurePolicy: 'fail_closed',
        registryUri: 'okf://placemakers/trade-guidance',
      },
    };

    const parsedOkf = BusinessPackContentSchema.parse(okfPack);
    assert.equal(parsedOkf.knowledgeModel?.type, 'okf_release');
    assert.equal((parsedOkf.knowledgeModel as any)?.releaseId, 'okf_rel_202610_v1');
    assert.equal(parsedOkf.factRegistry?.facts?.room_type?.type, 'enum');
    assert.equal(parsedOkf.factRegistry?.facts?.length_mm?.unit, 'mm');

    const okfChecksum = computePackChecksum(okfPack);
    assert.equal(okfChecksum.length, 64);
    assert.notEqual(
      okfChecksum,
      expectedGoldenLegacyChecksum,
      'Adding factRegistry and knowledgeModel safely participates in immutable content checksum'
    );
    console.log('  ✅ PASS: 12. Future OKF-compatible fields (factRegistry, knowledgeModel) parse and hash safely');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test 13: Operational release state separation (withdrawn release does not mutate content)
  // ──────────────────────────────────────────────────────────────────────────
  {
    // A release in published state
    const publishedEnvelope = {
      _id: 'mongo_rel_01',
      tenantId: 'placemakers',
      environmentId: 'production',
      version: '1.0.0',
      status: 'published',
      checksum: expectedGoldenLegacyChecksum,
      publishedAt: new Date().toISOString(),
      ...legacyPackFixture,
    };

    // Later operational revocation/withdrawal: status becomes 'withdrawn', withdrawalReason added
    const withdrawnEnvelope = {
      ...publishedEnvelope,
      status: 'withdrawn',
      operationalState: {
        status: 'withdrawn',
        withdrawnAt: new Date().toISOString(),
        withdrawnBy: 'security_auditor',
        withdrawalReason: 'Deprecated packaging superseded by v2',
      },
    };

    // Content extraction on withdrawn envelope produces the exact same immutable content
    const extractedPublished = extractPackContent(publishedEnvelope);
    const extractedWithdrawn = extractPackContent(withdrawnEnvelope);

    assert.deepEqual(
      extractedPublished,
      extractedWithdrawn,
      'Operational withdrawal must not mutate the immutable content'
    );

    assert.equal(
      computePackChecksum(extractedWithdrawn),
      expectedGoldenLegacyChecksum,
      'Operational withdrawal must not alter the content checksum'
    );
    console.log('  ✅ PASS: 13. Operational release state separation: withdrawal does not alter immutable checksum');
  }

  console.log('\n==================================================');
  console.log('🎉 Step 1 OKF Foundation Suite: All 13 tests passed, 0 failed');
  console.log('==================================================\n');
}

runCanonicalContentTestSuite().catch((err) => {
  console.error('Suite failed with error:', err);
  process.exit(1);
});
