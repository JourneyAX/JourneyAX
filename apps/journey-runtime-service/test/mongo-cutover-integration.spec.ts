import * as dotenv from 'dotenv';
import * as path from 'path';
import * as assert from 'assert';
import * as crypto from 'crypto';
import { MongoClient } from 'mongodb';

// Load root .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { RuntimeService } from '../src/runtime.service';
import { RuntimeController } from '../src/runtime.controller';
import {
  publishBusinessPack,
  rollbackBusinessPack,
} from '@journeyax/business-pack';
import {
  COLLECTION_BUSINESS_PACK_RELEASES,
  COLLECTION_BUSINESS_PACK_POINTERS,
  COLLECTION_TENANT_CUTOVERS,
  COLLECTION_CUTOVER_AUDIT_LOGS,
  closeDatabase,
} from '@journeyax/database';

async function runRealMongoIntegrationTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING REAL MONGO INTEGRATION TEST SUITE (ZERO MOCKS)');
  console.log('========================================================================\n');

  if (process.env.RUN_INTEGRATION_TESTS !== 'true') {
    console.log('Skipping real MongoDB integration tests (set RUN_INTEGRATION_TESTS=true to run against live database).');
    process.exit(0);
  }

  const mongoUri = process.env.TEST_MONGODB_URI?.trim();
  if (!mongoUri) {
    console.error('❌ TEST_MONGODB_URI not found in environment. Aborting integration tests.');
    console.error('   Fallback to MONGODB_URI or localhost is prohibited.');
    process.exit(1);
  }

  const dbName = process.env.TEST_MONGODB_DB_NAME?.trim() || 'journeyx_test';
  if (!dbName.toLowerCase().includes('test')) {
    console.error(`❌ DB name "${dbName}" rejected: DB name must contain "test".`);
    process.exit(1);
  }

  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  const db = client.db(dbName);
  console.log(`✅ Connected to real MongoDB database: "${dbName}"\n`);

  const testTenant = `integration_tenant_${Date.now()}`;
  const environmentId = 'production';

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Real Mongo Publication with Session Transaction
    // -------------------------------------------------------------------------
    console.log('Test 1: Transactional Business Pack Publication to real MongoDB');
    const mockPack: any = {
      manifest: {
        packId: `pack-${testTenant}`,
        tenantId: testTenant,
        name: 'Integration Test Pack',
        version: '1.0.0',
        description: 'Integration test pack',
        schemaVersion: '1.0.0',
        environmentId: 'production',
        author: 'integration-test',
      },
      profile: {
        companyName: 'Integration Enterprise',
        industry: 'cloud-consulting',
        primaryGoals: ['assessment'],
        locales: ['en-US'],
      },
      vocabulary: {
        version: '1.0.0',
        dimensions: [],
        terms: [],
        acronyms: {},
        slotSynonyms: {},
        slotMappings: {},
        prohibitedTerms: [],
      },
      entities: {
        version: '1.0.0',
        entities: [],
      },
      conversationPolicy: {
        fencingRules: [],
        prohibitedTopics: [],
        escalationThresholds: {
          sentimentFloor: -0.6,
          maxTurnsWithoutProgress: 4,
        },
      },
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'standard_turn',
        policies: [
          {
            policyId: 'standard_turn',
            candidates: [{ provider: 'openai', model: 'gpt-4o-mini', priority: 1 }],
            dataResidency: 'us',
            maxInputTokens: 10000,
            maxOutputTokens: 1000,
            fallbackAllowed: true,
            timeoutMs: 5000,
          },
        ],
      },
      agents: [
        {
          agentId: 'integration_agent',
          name: 'Consultant',
          purpose: 'Testing',
          description: 'Testing Agent',
          modelPolicyRef: 'standard_turn',
          systemPromptTemplate: 'Test prompt.',
          allowedTools: [],
          maxTurns: 3,
          handoffConditions: [],
        },
      ],
      journeys: [
        {
          journeyId: 'integration_journey',
          version: '1.0.0',
          displayName: 'Integration Journey',
          description: 'Testing journey',
          goals: ['complete_goal'],
          initialStage: 'start',
          stages: {
            start: {
              stageId: 'start',
              displayName: 'Start Stage',
              description: 'Initial stage',
              requiredFacts: [],
              allowedCapabilities: [],
              nextDecisionPolicy: 'dependency-first',
              exitConditions: [],
            },
          },
        },
      ],
      rules: [],
      capabilities: {
        version: '1.0.0',
        toolDefinitions: [],
        toolBindings: [],
        stageBindings: [],
      },
      experience: {
        version: '1.0.0',
        theme: {
          primaryColor: '#003366',
          accentColor: '#FF6600',
          fontFamily: 'Inter',
          borderRadius: '8px',
          customCssVars: {},
        },
        cards: {
          allowedCardTypes: ['quote', 'bundle'],
          defaultCardRenderer: '@journeyax/ui-cards',
        },
      },
      evaluations: [],
    };

    const session1 = client.startSession();
    let publishResult1: any;
    try {
      await session1.withTransaction(async () => {
        publishResult1 = await publishBusinessPack(db, mockPack, {
          session: session1,
          publishedBy: 'integration-test',
        });
      });
    } finally {
      await session1.endSession();
    }

    assert.ok(publishResult1);
    assert.equal(publishResult1.release.manifest.version, '1.0.0');
    assert.ok(publishResult1.checksum);

    // Assert written to MongoDB
    const persistedRelease = await db.collection(COLLECTION_BUSINESS_PACK_RELEASES).findOne({
      tenantId: testTenant,
      environmentId: 'production',
      $or: [{ version: '1.0.0' }, { 'manifest.version': '1.0.0' }],
    });
    assert.ok(persistedRelease, 'Release must exist in business_pack_releases');
    const checksumV1 = persistedRelease.checksum || persistedRelease.manifest.checksum;
    assert.equal(checksumV1, publishResult1.checksum);

    const persistedPointer = await db.collection(COLLECTION_BUSINESS_PACK_POINTERS).findOne({
      tenantId: testTenant,
      environmentId: 'production',
    });
    assert.ok(persistedPointer, 'Pointer must exist in business_pack_pointers');
    assert.equal(persistedPointer.activeVersion, '1.0.0');
    console.log('✓ Release 1.0.0 published and verified in real MongoDB\n');

    // -------------------------------------------------------------------------
    // TEST 2: Transactional Rollback
    // -------------------------------------------------------------------------
    console.log('Test 2: Transactional Business Pack Rollback in real MongoDB');
    // Publish 1.0.1
    const mockPack2 = {
      ...mockPack,
      manifest: {
        ...mockPack.manifest,
        version: '1.0.1',
      },
    };
    const session2 = client.startSession();
    try {
      await session2.withTransaction(async () => {
        await publishBusinessPack(db, mockPack2, {
          session: session2,
          publishedBy: 'integration-test',
        });
      });
    } finally {
      await session2.endSession();
    }

    const pointerV2 = await db.collection(COLLECTION_BUSINESS_PACK_POINTERS).findOne({
      tenantId: testTenant,
      environmentId: 'production',
    });
    assert.equal(pointerV2?.activeVersion, '1.0.1');

    // Rollback to 1.0.0
    const sessionRollback = client.startSession();
    try {
      await sessionRollback.withTransaction(async () => {
        await rollbackBusinessPack(db, testTenant, 'production', {
          targetVersion: '1.0.0',
          session: sessionRollback,
          rolledBackBy: 'governance-rollback',
        });
      });
    } finally {
      await sessionRollback.endSession();
    }

    const pointerAfterRollback = await db.collection(COLLECTION_BUSINESS_PACK_POINTERS).findOne({
      tenantId: testTenant,
      environmentId: 'production',
    });
    assert.equal(pointerAfterRollback?.activeVersion, '1.0.0');
    console.log('✓ Rollback to 1.0.0 confirmed in real MongoDB\n');

    // -------------------------------------------------------------------------
    // TEST 3: Transactional Cutover Persistence with Validation, CAS & Audit
    // -------------------------------------------------------------------------
    console.log('Test 3: Transactional Cutover Persistence, Validation, CAS, and Audit Log');
    const runtimeService = new RuntimeService();
    const runtimeController = new RuntimeController(runtimeService);

    // Negative A: Nonexistent release rejected
    await assert.rejects(
      async () => {
        await runtimeController.setCutoverRecord(
          testTenant,
          'production',
          {
            status: 'migrated',
            approvedReleaseVersion: '9.9.9',
            approvedReleaseChecksum: 'sha256:fake',
            expectedRevision: 0,
          },
          { authContext: { principalId: 'admin' } }
        );
      },
      (err: any) => {
        assert.equal(err.status, 400);
        return true;
      }
    );

    // Negative B: Checksum mismatch rejected
    await assert.rejects(
      async () => {
        await runtimeController.setCutoverRecord(
          testTenant,
          'production',
          {
            status: 'migrated',
            approvedReleaseVersion: '1.0.0',
            approvedReleaseChecksum: 'sha256:corrupted_checksum',
            expectedRevision: 0,
          },
          { authContext: { principalId: 'admin' } }
        );
      },
      (err: any) => {
        assert.equal(err.status, 400);
        return true;
      }
    );

    // Positive A: Promote to migrated with verified release v1.0.0
    const cutoverRecord = await runtimeController.setCutoverRecord(
      testTenant,
      'production',
      {
        status: 'migrated',
        approvedReleaseVersion: '1.0.0',
        approvedReleaseChecksum: checksumV1,
        expectedRevision: 0,
        approvedBy: 'security-governance-lead',
        notes: 'Initial production promotion',
      },
      { authContext: { principalId: 'admin' } }
    );

    assert.equal(cutoverRecord.status, 'migrated');
    assert.equal(cutoverRecord.revision, 1);
    assert.equal(cutoverRecord.approvedReleaseVersion, '1.0.0');

    // Verify canonical release-activation endpoint and compatibility cutover alias return the exact same authoritative record
    const canonicalActivation = await runtimeController.getReleaseActivationRecord(
      testTenant,
      'production',
      { authContext: { principalId: 'admin' } }
    );
    const aliasCutover = await runtimeController.getCutoverRecord(
      testTenant,
      'production',
      { authContext: { principalId: 'admin' } }
    );
    assert.equal(canonicalActivation.status, 'migrated');
    assert.equal(canonicalActivation.revision, 1);
    assert.equal(canonicalActivation.approvedReleaseVersion, '1.0.0');
    assert.deepEqual(canonicalActivation, aliasCutover, 'Canonical and alias endpoints must return identical record');

    // Verify written to real tenant_cutovers
    const persistedCutover = await db.collection(COLLECTION_TENANT_CUTOVERS).findOne({
      tenantId: testTenant,
      environmentId: 'production',
    });
    assert.ok(persistedCutover);
    assert.equal(persistedCutover.status, 'migrated');
    assert.equal(persistedCutover.revision, 1);

    // Verify written to real cutover_audit_logs
    const auditEntries = await db
      .collection(COLLECTION_CUTOVER_AUDIT_LOGS)
      .find({ tenantId: testTenant, environmentId: 'production' })
      .toArray();
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].newStatus, 'migrated');
    assert.equal(auditEntries[0].newRevision, 1);
    assert.equal(auditEntries[0].approvedBy, 'security-governance-lead');

    // Negative C: CAS Conflict (expectedRevision: 99 when current is 1)
    await assert.rejects(
      async () => {
        await runtimeController.setCutoverRecord(
          testTenant,
          'production',
          {
            status: 'canary',
            approvedReleaseVersion: '1.0.0',
            approvedReleaseChecksum: checksumV1,
            canaryPercentage: 20,
            expectedRevision: 99,
          },
          { authContext: { principalId: 'admin' } }
        );
      },
      (err: any) => {
        assert.equal(err.status, 409);
        return true;
      }
    );

    // Positive B: Valid CAS update (expectedRevision: 1 -> advances to revision 2)
    const cutoverV2 = await runtimeController.setCutoverRecord(
      testTenant,
      'production',
      {
        status: 'canary',
        approvedReleaseVersion: '1.0.0',
        approvedReleaseChecksum: checksumV1,
        canaryPercentage: 20,
        expectedRevision: 1,
        approvedBy: 'canary-governor',
        notes: 'Promoted to 20% canary',
      },
      { authContext: { principalId: 'admin' } }
    );
    assert.equal(cutoverV2.revision, 2);
    assert.equal(cutoverV2.status, 'canary');
    assert.equal(cutoverV2.canaryPercentage, 20);

    const auditEntries2 = await db
      .collection(COLLECTION_CUTOVER_AUDIT_LOGS)
      .find({ tenantId: testTenant, environmentId: 'production' })
      .toArray();
    assert.equal(auditEntries2.length, 2);
    console.log('✓ Cutover persistence, Business Pack verification, CAS, and Audit Log verified in MongoDB\n');

    // -------------------------------------------------------------------------
    // TEST 4: Restart Survival
    // -------------------------------------------------------------------------
    console.log('Test 4: Restart Survival');
    // Instantiate brand-new runtime service instance simulating application restart
    const freshRestartedService = new RuntimeService();
    const restartedRecord = await freshRestartedService.getCutoverRecord(testTenant, 'production');
    assert.ok(restartedRecord, 'Cutover record must survive service restart');
    assert.equal(restartedRecord?.revision, 2);
    assert.equal(restartedRecord?.status, 'canary');
    assert.equal(restartedRecord?.canaryPercentage, 20);
    assert.equal(restartedRecord?.approvedReleaseVersion, '1.0.0');
    console.log('✓ Cutover state survives process restart completely intact\n');

    // -------------------------------------------------------------------------
    // TEST 5: Database Failure Fail-Closed Verification
    // -------------------------------------------------------------------------
    console.log('Test 5: Database Failure Fail-Closed Enforcement');
    const originalUri = process.env.MONGODB_URI;
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      // Disconnect active database pool
      await closeDatabase();

      // Point to an unreachable host and set production mode
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:59999/?serverSelectionTimeoutMS=200';
      process.env.NODE_ENV = 'production';

      const failingService = new RuntimeService();
      // getCutoverRecord must fail closed to null in production
      const result = await failingService.getCutoverRecord(testTenant, 'production');
      assert.equal(result, null, 'Must fail closed to null when database is unreachable');

      // persistCutoverRecordTransactionally must fail closed with 503 or error
      await assert.rejects(
        async () => {
          await failingService.persistCutoverRecordTransactionally(testTenant, 'production', {
            status: 'migrated',
            approvedReleaseVersion: '1.0.0',
            approvedReleaseChecksum: 'sha256:fake',
            approvedBy: 'admin',
          });
        },
        (err: any) => {
          assert.ok(err, 'Must reject on unreachable database');
          return true;
        }
      );
      console.log('✓ Unreachable database strictly fails closed in production\n');
    } finally {
      await closeDatabase();
      process.env.MONGODB_URI = originalUri;
      process.env.NODE_ENV = originalNodeEnv;
    }

    console.log('====================================================');
    console.log('✓ All Real MongoDB Integration Tests PASSED!');
    console.log('====================================================\n');
  } finally {
    // Clean up test data
    console.log(`Cleaning up test documents for tenant: ${testTenant}`);
    await db.collection(COLLECTION_BUSINESS_PACK_RELEASES).deleteMany({ tenantId: testTenant });
    await db.collection(COLLECTION_BUSINESS_PACK_POINTERS).deleteMany({ tenantId: testTenant });
    await db.collection(COLLECTION_TENANT_CUTOVERS).deleteMany({ tenantId: testTenant });
    await db.collection(COLLECTION_CUTOVER_AUDIT_LOGS).deleteMany({ tenantId: testTenant });
    await client.close();
  }
}

runRealMongoIntegrationTests().catch((err) => {
  console.error('Fatal integration test error:', err);
  process.exit(1);
});
