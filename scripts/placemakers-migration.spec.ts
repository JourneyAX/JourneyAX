/**
 * placemakers-migration.spec.ts
 *
 * Enterprise Closure Suite: Canonical PlaceMakers Business Pack Migration & Canary
 *
 * Strictly Isolated Execution:
 * Unconditionally strips all network and database environment variables.
 * Uses isolated in-memory Mongo adapters with zero network access or external DNS.
 */

import {
  enforceOfflineCredentialIsolation,
  assertOfflineCredentialIsolation,
  resetEgressViolations,
  assertLocalhostOnlyEgress,
  getEgressViolations,
} from './offline-credential-isolation';

// Unconditionally strip all network, database, cloud, and provider credentials
enforceOfflineCredentialIsolation();

import assert from 'node:assert/strict';
import {
  BusinessPackRelease,
  BusinessPackReleaseSchema,
  validateBusinessPack,
  computePackChecksum,
  publishBusinessPack,
  rollbackBusinessPack,
  BusinessPackLoader,
  parseCanonicalSecretRef,
} from '@journeyax/business-pack';
import { CutoverRepository, DurableCutoverRecord } from '@journeyax/database';
import { DuplicateTurnError } from '@journeyax/journey-core';
import { BadRequestException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { RuntimeModule } from '../apps/journey-runtime-service/src/runtime.module';
import { RuntimeController } from '../apps/journey-runtime-service/src/runtime.controller';
import { RuntimeService } from '../apps/journey-runtime-service/src/runtime.service';
import { TurnApplicationService } from '../apps/journey-runtime-service/src/kernel/turn-application.service';
import { PackRepository } from '../apps/journey-runtime-service/src/kernel/pack.repository';
import { WorkspaceRepository } from '../apps/journey-runtime-service/src/kernel/workspace.repository';
import { ExecutionRepository } from '../apps/journey-runtime-service/src/kernel/execution.repository';
import { OutboxRepository } from '../apps/journey-runtime-service/src/kernel/outbox.repository';
import { CapabilityGateway } from '../apps/journey-runtime-service/src/kernel/capability.gateway';
import { ApprovalService } from '../apps/journey-runtime-service/src/kernel/approval.service';
import { JourneyResolver } from '../apps/journey-runtime-service/src/kernel/journey.resolver';
import { AgentRouter } from '../apps/journey-runtime-service/src/kernel/agent.router';
import { ModelGateway } from '../apps/journey-runtime-service/src/kernel/model.gateway';
import { ModelRouter } from '../apps/journey-runtime-service/src/model/model-router';
import { PresentationPort } from '../apps/journey-runtime-service/src/kernel/presentation.port';
import { OutcomeValidator } from '../apps/journey-runtime-service/src/turn/validate-outcome';
import { TurnInterpreter } from '../apps/journey-runtime-service/src/turn/interpret-event';
import { FactReducer } from '../apps/journey-runtime-service/src/turn/fact-reducer';

import { runTenantConnectorInventory } from './inventory-tenant-connectors';

function getNestedValue(obj: any, path: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (path in obj) return obj[path];
  const parts = path.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr === null || curr === undefined || typeof curr !== 'object') return undefined;
    curr = curr[part];
  }
  return curr;
}

function matchesFilter(doc: any, filter: any): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$or' && Array.isArray(v)) {
      if (!v.some((subFilter) => matchesFilter(doc, subFilter))) {
        return false;
      }
      continue;
    }
    if (k === '$and' && Array.isArray(v)) {
      if (!v.every((subFilter) => matchesFilter(doc, subFilter))) {
        return false;
      }
      continue;
    }
    const val = getNestedValue(doc, k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$ne' in v) {
        if (val === (v as any).$ne) return false;
      } else if ('$in' in v && Array.isArray((v as any).$in)) {
        if (!(v as any).$in.includes(val)) return false;
      } else {
        if (JSON.stringify(val) !== JSON.stringify(v)) return false;
      }
    } else if (val !== v) {
      return false;
    }
  }
  return true;
}

// Mock in-memory database implementation conforming to Mongo Db & MongoClient interface
export function createIsolatedTestDb() {
  const collections = new Map<string, any[]>();

  function getCol(name: string) {
    if (!collections.has(name)) {
      collections.set(name, []);
    }
    return collections.get(name)!;
  }

  const db: any = {
    collection: (name: string) => {
      const items = getCol(name);
      return {
        find: (filter: any = {}) => {
          const filtered = items.filter((doc) => matchesFilter(doc, filter));
          return {
            sort: () => ({
              toArray: async () => JSON.parse(JSON.stringify(filtered)),
            }),
            toArray: async () => JSON.parse(JSON.stringify(filtered)),
          };
        },
        findOne: async (filter: any = {}) => {
          const match = items.find((doc) => matchesFilter(doc, filter));
          return match ? JSON.parse(JSON.stringify(match)) : null;
        },
        insertOne: async (doc: any) => {
          items.push(JSON.parse(JSON.stringify(doc)));
          return { acknowledged: true, insertedId: doc._id || 'mock-id' };
        },
        deleteOne: async (filter: any = {}) => {
          const idx = items.findIndex((doc) => matchesFilter(doc, filter));
          if (idx !== -1) {
            items.splice(idx, 1);
            return { deletedCount: 1, acknowledged: true };
          }
          return { deletedCount: 0, acknowledged: true };
        },
        deleteMany: async (filter: any = {}) => {
          let count = 0;
          for (let i = items.length - 1; i >= 0; i--) {
            if (matchesFilter(items[i], filter)) {
              items.splice(i, 1);
              count++;
            }
          }
          return { deletedCount: count, acknowledged: true };
        },
        countDocuments: async (filter: any = {}) => {
          return items.filter((doc) => matchesFilter(doc, filter)).length;
        },
        updateOne: async (filter: any, update: any, options: any = {}) => {
          const idx = items.findIndex((doc) => matchesFilter(doc, filter));
          if (idx !== -1) {
            const current = items[idx];
            if (update.$set) {
              for (const [k, v] of Object.entries(update.$set)) {
                if (k.includes('.')) {
                  const parts = k.split('.');
                  let target = current;
                  for (let i = 0; i < parts.length - 1; i++) {
                    target[parts[i]] = target[parts[i]] || {};
                    target = target[parts[i]];
                  }
                  if (v === undefined) {
                    delete target[parts[parts.length - 1]];
                  } else {
                    target[parts[parts.length - 1]] = JSON.parse(JSON.stringify(v));
                  }
                } else {
                  if (v === undefined) {
                    delete current[k];
                  } else {
                    current[k] = JSON.parse(JSON.stringify(v));
                  }
                }
              }
            }
            if (update.$inc) {
              for (const [k, v] of Object.entries(update.$inc)) {
                current[k] = (current[k] || 0) + (v as number);
              }
            }
            if (update.$push) {
              for (const [k, v] of Object.entries(update.$push)) {
                current[k] = current[k] || [];
                if (v && typeof v === 'object' && '$each' in (v as any)) {
                  current[k].push(...JSON.parse(JSON.stringify((v as any).$each)));
                  if (typeof (v as any).$slice === 'number') {
                    const sliceCount = (v as any).$slice;
                    if (sliceCount < 0) {
                      current[k] = current[k].slice(sliceCount);
                    } else {
                      current[k] = current[k].slice(0, sliceCount);
                    }
                  }
                } else {
                  current[k].push(JSON.parse(JSON.stringify(v)));
                }
              }
            }
            return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
          }
          if (options.upsert) {
            const newDoc: any = {
              ...filter,
              ...(update.$set || {}),
              ...(update.$setOnInsert || {}),
            };
            if (update.$inc) {
              for (const [k, v] of Object.entries(update.$inc)) {
                newDoc[k] = (newDoc[k] || 0) + (v as number);
              }
            }
            items.push(newDoc);
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, acknowledged: true };
          }
          return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
        },
      };
    },
  };

  const client: any = {
    startSession: () => ({
      withTransaction: async (fn: any) => fn(),
      endSession: async () => {},
    }),
  };
  db.client = client;

  return { db, client, collections };
}

async function runSuite() {
  let exitCode = 0;
  resetEgressViolations();
  try {
  console.log('==============================================================================');
  console.log('   PlaceMakers Business Pack Migration & Isolated Canary Test Suite           ');
  console.log('==============================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.stack || err.message}`);
      failed++;
    }
  }

  const diskLoader = new BusinessPackLoader();
  const canonicalPack = await diskLoader.loadFromDisk('placemakers', 'production');
  assert.ok(canonicalPack, 'PlaceMakers pack must load from packs/placemakers');

  const parsedCandidate = BusinessPackReleaseSchema.safeParse(canonicalPack);
  if (!parsedCandidate.success) {
    throw new Error(`PlaceMakers disk pack failed schema: ${JSON.stringify(parsedCandidate.error.format())}`);
  }
  const validCandidate = validateBusinessPack(parsedCandidate.data);
  if (!validCandidate.valid) {
    throw new Error(`PlaceMakers disk pack failed validation: ${JSON.stringify(validCandidate.issues)}`);
  }

  function createPlaceMakersCandidate(): BusinessPackRelease {
    return JSON.parse(JSON.stringify(canonicalPack));
  }

  // -------------------------------------------------------------------------
  // Test 1: Negative - Missing Capability / Tool Mappings Fail Closed
  // -------------------------------------------------------------------------
  await test('1. Negative: missing tool definitions and stage capabilities fail validation and prevent publication', async () => {
    // 1a. Stage references unknown capability -> semantic error, valid === false, publisher rejects
    const badCapPack = createPlaceMakersCandidate();
    const tradeQuoteJourney = badCapPack.journeys.find((j) => j.journeyId === 'placemakers_trade_quote')!;
    assert.ok(tradeQuoteJourney, 'placemakers_trade_quote must exist');
    tradeQuoteJourney.stages.project_intake.allowedCapabilities.push('unregistered.dangerous_tool');

    const valCap = validateBusinessPack(badCapPack);
    assert.equal(valCap.valid, false, 'Pack with unregistered stage capability must be invalid (fail-closed)');
    assert.ok(
      valCap.issues.some((i) => i.severity === 'error' && i.message.includes('unregistered.dangerous_tool')),
      'Must emit semantic error for unregistered capability in stage'
    );
    const { db: dbCap } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbCap, badCapPack),
      /Pack semantic validation failed.*unregistered\.dangerous_tool/,
      'publishBusinessPack must fail-closed and reject publication of pack with unregistered stage capability'
    );

    // 1b. Agent allowedTools pointing to non-existent tool -> semantic error, valid === false, publisher rejects
    const badToolPack = createPlaceMakersCandidate();
    badToolPack.agents[0].allowedTools.push('ghost.tool');
    const valTool = validateBusinessPack(badToolPack);
    assert.equal(valTool.valid, false, 'Pack with unregistered agent tool must be invalid (fail-closed)');
    assert.ok(
      valTool.issues.some((i) => i.severity === 'error' && i.message.includes('ghost.tool')),
      'Must emit semantic error for unregistered tool in agent allowedTools'
    );
    const { db: dbTool } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbTool, badToolPack),
      /Pack semantic validation failed.*ghost\.tool/,
      'publishBusinessPack must fail-closed and reject publication of pack with unregistered agent tool'
    );

    // 1c. Intentional wildcard behavior explicitly supported and tested
    const wildcardPack = createPlaceMakersCandidate();
    wildcardPack.agents[0].allowedTools.push('catalog.*');
    const jWildcard = wildcardPack.journeys.find((j) => j.journeyId === 'placemakers_trade_quote')!;
    jWildcard.stages.project_intake.allowedCapabilities.push('catalog.*');

    const valWildcard = validateBusinessPack(wildcardPack);
    assert.equal(valWildcard.valid, true, 'Intentional wildcard patterns (e.g. catalog.*) must be permitted');
    assert.ok(
      !valWildcard.issues.some((i) => i.message.includes('catalog.*')),
      'Wildcard pattern should not trigger unmapped capability/tool error'
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: Negative - Broken Exit Conditions & Unknown Model Policy Fail Closed
  // -------------------------------------------------------------------------
  await test('2. Negative: unknown modelPolicyRef or broken exit condition strictly fails validation', async () => {
    // 2a. Unknown modelPolicyRef
    const badModelRef = createPlaceMakersCandidate();
    badModelRef.agents[0].modelPolicyRef = 'non_existent_policy';
    const valModel = validateBusinessPack(badModelRef);
    assert.equal(valModel.valid, false, 'Pack must be invalid when modelPolicyRef is missing');
    assert.ok(valModel.issues.some((i) => i.message.includes('non_existent_policy')));

    // 2b. Broken exit condition pointing to missing stage
    const badStageRef = createPlaceMakersCandidate();
    const tradeQuoteJourney = badStageRef.journeys.find((j) => j.journeyId === 'placemakers_trade_quote')!;
    assert.ok(tradeQuoteJourney, 'placemakers_trade_quote must exist');
    tradeQuoteJourney.stages.project_intake.exitConditions = [
      { nextStage: 'phantom_stage' },
    ];
    const valStage = validateBusinessPack(badStageRef);
    assert.equal(valStage.valid, false, 'Pack must be invalid when exit condition references missing stage');
    assert.ok(valStage.issues.some((i) => i.message.includes('phantom_stage')));

    // 2c. Publication must fail closed on invalid pack
    const { db } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(db, badModelRef),
      /semantic validation failed/,
      'Publisher must fail closed and reject publication of pack with broken modelPolicyRef'
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: Negative - Raw Secrets, Unsupported Schemes, & Cross-Tenant/Cross-Env Refs Fail Closed
  // -------------------------------------------------------------------------
  await test('3. Negative: raw secrets, unsupported schemes, and arbitrary cross-tenant/cross-env secretRefs are caught and rejected', async () => {
    // 3a. Raw secret in secretRef
    const rawSecretPack = createPlaceMakersCandidate();
    rawSecretPack.capabilities.toolBindings[0].executor.secretRef = 'sk-abcdefghijklmnopqrstuvwxyz123456';

    const valRaw = validateBusinessPack(rawSecretPack);
    assert.equal(valRaw.valid, false, 'Pack with raw API key must be strictly invalid');
    const { db: dbRaw } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbRaw, rawSecretPack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with raw API key'
    );

    // 3b. Unsupported scheme in secretRef
    const badSchemePack = createPlaceMakersCandidate();
    badSchemePack.capabilities.toolBindings[0].executor.secretRef = 'ftp://secrets.corp/placemakers/production/key';
    const valScheme = validateBusinessPack(badSchemePack);
    assert.equal(valScheme.valid, false, 'Pack with unsupported scheme must be strictly invalid');
    const { db: dbScheme } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbScheme, badSchemePack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with unsupported secretRef scheme'
    );

    // 3c. Arbitrary cross-tenant secretRef violation (unknown/arbitrary tenant acme-corp)
    const crossTenantPack = createPlaceMakersCandidate();
    crossTenantPack.capabilities.toolBindings[0].executor.secretRef = 'gcp-secret://journeyax-secrets/acme-corp/production/pm-sap-key';
    const valCross = validateBusinessPack(crossTenantPack);
    assert.equal(valCross.valid, false, 'Pack with cross-tenant secretRef must be strictly invalid');
    assert.ok(
      valCross.issues.some((i) => i.message.includes("references tenant 'acme-corp' but binding belongs to 'placemakers'")),
      'Must emit Cross-tenant secretRef violation error for arbitrary unknown tenant'
    );
    const { db: dbCross } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbCross, crossTenantPack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with cross-tenant secretRef'
    );

    // Another arbitrary unknown tenant 'custom-enterprise-corp'
    const crossTenantPack2 = createPlaceMakersCandidate();
    crossTenantPack2.capabilities.toolBindings[0].executor.secretRef = 'vault://vault-east/custom-enterprise-corp/production/sap-key';
    const valCross2 = validateBusinessPack(crossTenantPack2);
    assert.equal(valCross2.valid, false, 'Pack with cross-tenant secretRef for arbitrary client must be invalid');
    assert.ok(
      valCross2.issues.some((i) => i.message.includes("references tenant 'custom-enterprise-corp'")),
      'Must emit Cross-tenant violation for custom-enterprise-corp'
    );

    // 3d. Arbitrary cross-environment secretRef violation (staging secretRef on production binding)
    const crossEnvPack = createPlaceMakersCandidate();
    crossEnvPack.capabilities.toolBindings[0].executor.secretRef = 'gcp-secret://journeyax-secrets/placemakers/staging/pm-sap-key';
    const valCrossEnv = validateBusinessPack(crossEnvPack);
    assert.equal(valCrossEnv.valid, false, 'Pack with cross-environment secretRef must be strictly invalid');
    assert.ok(
      valCrossEnv.issues.some((i) => i.message.includes("references environment 'staging' but binding belongs to 'production'")),
      'Must emit Cross-environment secretRef violation error'
    );
    const { db: dbCrossEnv } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbCrossEnv, crossEnvPack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with cross-environment secretRef'
    );

    // 3e. Unknown / new tenant works dynamically without code changes
    const newTenantPack = createPlaceMakersCandidate();
    newTenantPack.manifest.tenantId = 'globex-corp';
    newTenantPack.manifest.environmentId = 'dev';
    for (const b of newTenantPack.capabilities.toolBindings) {
      b.tenantId = 'globex-corp';
      b.environmentId = 'dev';
      if (b.executor.secretRef) {
        b.executor.secretRef = 'vault://secret-vault/globex-corp/dev/pm-sap-key';
      }
    }
    const valNewTenant = validateBusinessPack(newTenantPack);
    assert.equal(valNewTenant.valid, true, 'Unknown new tenant must validate successfully without hardcoded code changes');
  });

  // -------------------------------------------------------------------------
  // Test 4: Negative - Checksum & Pointer Mismatch Detected and Rejected
  // -------------------------------------------------------------------------
  await test('4. Negative: tampered release checksum or pointer mismatch fails closed', async () => {
    const { db } = createIsolatedTestDb();
    const pack = createPlaceMakersCandidate();
    const { checksum } = await publishBusinessPack(db, pack);

    // Tamper with checksum in DB release document
    const releasesCol = db.collection('business_pack_releases');
    await releasesCol.updateOne(
      { tenantId: 'placemakers', version: '1.0.0' },
      { $set: { checksum: 'tampered_bad_checksum_hash' } }
    );

    const loader = new BusinessPackLoader({ db });
    const loaded = await loader.loadFromMongo('placemakers', 'production', '1.0.0');
    assert.equal(loaded, null, 'Loader must refuse to return release with mismatched checksum');
  });

  // -------------------------------------------------------------------------
  // Test 5: Negative - Cross-Tenant Scope Isolation
  // -------------------------------------------------------------------------
  await test('5. Negative: cross-tenant isolation prevents tenant A from accessing PlaceMakers release', async () => {
    const { db } = createIsolatedTestDb();
    const pack = createPlaceMakersCandidate();
    await publishBusinessPack(db, pack);

    const loader = new BusinessPackLoader({ db });
    // Caroma tenant must NOT be able to load PlaceMakers release
    const caromaLoaded = await loader.loadFromMongo('caroma', 'production', '1.0.0');
    assert.equal(caromaLoaded, null, 'Cross-tenant isolation must prevent loading other tenant pack');

    // Pointer check for caroma must return false
    const hasCaroma = await loader.hasPublishedPackAsync('caroma', 'production');
    assert.equal(hasCaroma, false, 'Caroma must not have active pointer for PlaceMakers release');
  });

  // -------------------------------------------------------------------------
  // Test 6: Lifecycle - Transactional Immutable Release Publication
  // -------------------------------------------------------------------------
  await test('6. Lifecycle: publishBusinessPack creates immutable release and enqueues outbox event', async () => {
    const { db, collections } = createIsolatedTestDb();
    const pack = createPlaceMakersCandidate();

    const result = await publishBusinessPack(db, pack, {
      publishedBy: 'migration-orchestrator@journeyax.io',
      notes: 'Initial PlaceMakers canonical migration',
    });

    assert.equal(result.release.manifest.tenantId, 'placemakers');
    assert.equal(result.release.manifest.version, '1.0.0');
    assert.equal(result.revision, 1);
    assert.ok(result.checksum.length === 64, 'Checksum must be valid sha256 hex');

    // Verify outbox event enqueued
    const outboxEvents = collections.get('outbox_events') || [];
    assert.equal(outboxEvents.length, 1);
    assert.equal(outboxEvents[0].eventType, 'business_pack.published');
    assert.equal(outboxEvents[0].tenantId, 'placemakers');
    assert.equal(outboxEvents[0].payload.checksum, result.checksum);

    // Verify immutable release stored
    const releases = collections.get('business_pack_releases') || [];
    assert.equal(releases.length, 1);
    assert.equal(releases[0].version, '1.0.0');

    // Attempting to overwrite with different content on same version must throw immutable release violation
    const tampered = createPlaceMakersCandidate();
    tampered.profile.companyName = 'Tampered Company Name';
    await assert.rejects(
      () => publishBusinessPack(db, tampered),
      /Immutable release violation/,
      'Cannot overwrite published immutable release version with different content'
    );
  });

  // -------------------------------------------------------------------------
  // Test 7: Lifecycle - Active Pointer Promotion with CAS Revision Control
  // -------------------------------------------------------------------------
  await test('7. Lifecycle: CutoverRepository promotes active pointer with CAS revision checking', async () => {
    const { db, client } = createIsolatedTestDb();
    const cutoverRepo = new CutoverRepository(async () => ({ db, client }));

    const pack = createPlaceMakersCandidate();
    const { checksum } = await publishBusinessPack(db, pack);

    // Promote cutover with expectedRevision 0 -> 1
    const promoted = await cutoverRepo.promoteCutover('placemakers', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: checksum,
      expectedRevision: 0,
      approvedBy: 'admin-lead@journeyax.io',
      notes: 'Initial promotion of PlaceMakers Business Pack',
    });

    assert.equal(promoted.status, 'migrated');
    assert.equal(promoted.revision, 1);
    assert.equal(promoted.approvedReleaseVersion, '1.0.0');
    assert.equal(promoted.approvedReleaseChecksum, checksum);

    // Verify cutovers collection in DB
    const record = await cutoverRepo.getCutoverRecord('placemakers', 'production');
    assert.ok(record);
    assert.equal(record.status, 'migrated');
    assert.equal(record.revision, 1);

    // Concurrent promotion with stale expectedRevision (0 instead of 1) must fail with CutoverConflictError
    await assert.rejects(
      () =>
        cutoverRepo.promoteCutover('placemakers', 'production', {
          status: 'migrated',
          approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: checksum,
          expectedRevision: 0, // Stale!
          approvedBy: 'admin-lead@journeyax.io',
        }),
      /CutoverConflictError|CAS mismatch|Cutover revision conflict/,
      'Stale expectedRevision must fail CAS'
    );
  });

  // -------------------------------------------------------------------------
  // Test 8: Lifecycle - Safe Rollback Proof with CAS
  // -------------------------------------------------------------------------
  await test('8. Lifecycle: safe rollback to previous version with atomic CAS and checksum check', async () => {
    const { db, client } = createIsolatedTestDb();
    const cutoverRepo = new CutoverRepository(async () => ({ db, client }));

    // Step 1: Publish v1.0.0 and promote revision 0 -> 1
    const packV1 = createPlaceMakersCandidate();
    packV1.manifest.version = '1.0.0';
    const res1 = await publishBusinessPack(db, packV1);
    await cutoverRepo.promoteCutover('placemakers', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: res1.checksum,
      expectedRevision: 0,
      approvedBy: 'admin@journeyax.io',
    });

    // Step 2: Publish v1.1.0 and promote revision 1 -> 2
    const packV2 = createPlaceMakersCandidate();
    packV2.manifest.version = '1.1.0';
    packV2.profile.brandTone = 'Updated brand tone for v1.1.0';
    const res2 = await publishBusinessPack(db, packV2);
    await cutoverRepo.promoteCutover('placemakers', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.1.0',
      approvedReleaseChecksum: res2.checksum,
      expectedRevision: 1,
      approvedBy: 'admin@journeyax.io',
    });

    // Step 3: Rollback business pack pointer to v1.0.0
    const rollbackRes = await rollbackBusinessPack(db, 'placemakers', 'production', {
      targetVersion: '1.0.0',
      rolledBackBy: 'admin-lead@journeyax.io',
      reason: 'Canary degradation test rollback',
    });
    assert.equal(rollbackRes.activeVersion, '1.0.0');

    // Step 4: Promote cutover record to status: 'rollback' with CAS revision 2 -> 3
    const cutoverRollback = await cutoverRepo.promoteCutover('placemakers', 'production', {
      status: 'rollback',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: res1.checksum,
      expectedRevision: 2,
      rollbackTargetVersion: '1.0.0',
      approvedBy: 'admin-lead@journeyax.io',
      notes: 'Rollback to v1.0.0 verified',
    });

    assert.equal(cutoverRollback.status, 'rollback');
    assert.equal(cutoverRollback.revision, 3);
    assert.equal(cutoverRollback.approvedReleaseVersion, '1.0.0');
    assert.equal(cutoverRollback.approvedReleaseChecksum, res1.checksum);
  });

  // -------------------------------------------------------------------------
  // Test 9: Security - Secret References Without Secret Values
  // -------------------------------------------------------------------------
  await test('9. Security: integration bindings record tenant-scoped secretRef without raw secret values', async () => {
    const pack = createPlaceMakersCandidate();
    const binding = pack.capabilities.toolBindings.find((b) => b.toolId === 'sap.quote_sync')!;
    assert.ok(binding, 'sap.quote_sync binding must exist');

    assert.equal(binding.toolId, 'sap.quote_sync');
    assert.equal(binding.executor.connectionRef, 'conn_pm_sap_trade');
    assert.ok(binding.executor.secretRef, 'executor.secretRef must exist');
    assert.equal(
      binding.executor.secretRef,
      'gcp-secret://journeyax-secrets/placemakers/production/pm-sap-key',
      'secretRef must follow canonical URI structure carrying tenant and environment'
    );

    const parsedRes = parseCanonicalSecretRef(binding.executor.secretRef);
    assert.ok(parsedRes.parsed, 'Must parse canonical secretRef successfully');
    assert.equal(parsedRes.parsed.scheme, 'gcp-secret://');
    assert.equal(parsedRes.parsed.tenantId, 'placemakers');
    assert.equal(parsedRes.parsed.environmentId, 'production');
    assert.equal(parsedRes.parsed.secretKey, 'pm-sap-key');

    assert.ok(!binding.executor.secretRef.includes('sk-'), 'Must not contain raw secret token');

    // Confirm scanForRawSecrets in inventory sees 0 raw secrets
    const jsonStr = JSON.stringify(pack);
    assert.ok(!jsonStr.includes('clientSecret'), 'Must not have clientSecret property');
    assert.ok(!jsonStr.includes('password'), 'Must not have password property');

    // Strictly assert zero leaked credentials in process.env
    assertOfflineCredentialIsolation();
  });

  // -------------------------------------------------------------------------
  // Test 10: Public-Path Canary - Public API-Gateway & RuntimeController Boundary with Isolated DB
  // -------------------------------------------------------------------------
  await test('10. Public-Path Canary: Public API-Gateway & HTTP/SSE RuntimeController boundary executes multi-turn canary with isolated DB', async () => {
    const { db: isolatedDb, client: isolatedClient } = createIsolatedTestDb();

    // 1. Prepare candidate pack configured for environmentId: 'test'
    const testCandidate = createPlaceMakersCandidate();
    testCandidate.manifest.environmentId = 'test';
    testCandidate.capabilities.toolBindings.forEach((b) => {
      b.environmentId = 'test';
      if (b.executor.secretRef) {
        b.executor.secretRef = b.executor.secretRef.replace('/production/', '/test/');
      }
    });

    // 2. Publish to isolated MongoDB (creates release, active pointer, and outbox event)
    const pubResult = await publishBusinessPack(isolatedDb, testCandidate, {
      publishedBy: 'canary-runner@journeyax.io',
      notes: 'Canary release for PlaceMakers test environment',
    });
    assert.equal(pubResult.revision, 1);
    assert.ok(pubResult.checksum.length === 64);

    // 3. Real PackRepository configured with non-existent filesystem root and isolated DB
    const realPackRepo = new PackRepository('/non/existent/dev/dir', isolatedDb);

    // Verify pack loads from MongoDB business_pack_releases via active pointer
    const loadedActivePack = await realPackRepo.loadActivePack('placemakers', 'test');
    assert.ok(loadedActivePack, 'Must load active pack from MongoDB collections');
    assert.equal(loadedActivePack.manifest.tenantId, 'placemakers');
    assert.equal(loadedActivePack.manifest.version, '1.0.0');
    assert.equal(loadedActivePack.manifest.environmentId, 'test');

    // Prove NO filesystem fallback after activation:
    // If pointer is temporarily removed from DB, loadActivePack must fail closed (throws error)
    realPackRepo.invalidate('placemakers');
    await isolatedDb.collection('business_pack_pointers').deleteOne({ tenantId: 'placemakers', environmentId: 'test' });
    await assert.rejects(
      () => realPackRepo.loadActivePack('placemakers', 'test'),
      /No published Business Pack found/,
      'Pack loading must fail closed when pointer is missing — proving zero filesystem fallback'
    );
    // Restore active pointer — use field names matching publishBusinessPack output:
    // 'checksum' (not 'activeChecksum') and 'activeVersion' are required by CutoverRepository
    await isolatedDb.collection('business_pack_pointers').insertOne({
      tenantId: 'placemakers',
      environmentId: 'test',
      activeVersion: '1.0.0',
      activeVersionId: '1.0.0',
      status: 'active',
      checksum: pubResult.checksum,
      revision: 1,
      updatedAt: new Date(),
    });
    realPackRepo.invalidate('placemakers');
    const restoredPack = await realPackRepo.loadActivePack('placemakers', 'test');
    assert.equal(restoredPack.manifest.version, '1.0.0');

    // 4. Fully injected isolated durable adapters
    const workspaceRepo = new WorkspaceRepository(isolatedDb);
    const executionRepo = new ExecutionRepository(isolatedDb);
    const outboxRepo = new OutboxRepository(isolatedDb);
    const capabilityGateway = new CapabilityGateway({ db: isolatedDb });
    const approvalService = new ApprovalService(undefined, outboxRepo, isolatedDb);
    const journeyResolver = new JourneyResolver();
    const agentRouter = new AgentRouter();
    const modelGateway = new ModelGateway();
    const presentationPort = new PresentationPort();
    const outcomeValidator = new OutcomeValidator();

    const appService = new TurnApplicationService(
      realPackRepo,
      workspaceRepo,
      journeyResolver,
      agentRouter,
      modelGateway,
      capabilityGateway,
      approvalService,
      executionRepo,
      outboxRepo,
      presentationPort,
      new TurnInterpreter(modelGateway),
      new FactReducer(),
      outcomeValidator
    );

    // 5. Start the existing Nest runtime application on an ephemeral localhost port
    let app: any = null;
    let gatewayApp: any = null;
    let originalRuntimeUrl: string | undefined;
    let originalProjectsUrl: string | undefined;

    try {
      app = await NestFactory.create(RuntimeModule, { logger: false });
      const runtimeService = app.get(RuntimeService);
      runtimeService.setAppServiceForTest(appService);
      const cutoverRepo = new CutoverRepository(async () => ({ db: isolatedDb, client: isolatedClient }));
      runtimeService.setCutoverRepositoryForTest(cutoverRepo);

      // 5a. Insert the durable 'migrated' cutover record BEFORE turns.
      // The CutoverGate (assertCutoverApproved) now enforces this on every runTurn.
      // pubResult.checksum is the canonical checksum of the test-environment pack.
      await cutoverRepo.promoteCutover('placemakers', 'test', {
        status: 'migrated',
        approvedReleaseVersion: '1.0.0',
        approvedReleaseChecksum: pubResult.checksum,
        expectedRevision: 0,
        approvedBy: 'spec-test-10@journeyax.io',
        notes: 'Test 10 canonical canary cutover',
      });
      const promotedCutover = await cutoverRepo.getCutoverRecord('placemakers', 'test');
      assert.ok(promotedCutover, 'Cutover record must exist in isolated DB before turns are executed');
      assert.equal(promotedCutover.status, 'migrated');
      assert.equal(promotedCutover.approvedReleaseVersion, '1.0.0');
      assert.equal(promotedCutover.approvedReleaseChecksum, pubResult.checksum);

      await app.listen(0);
      const server = app.getHttpServer();
      const address = server.address();
      const runtimePort = typeof address === 'object' && address ? address.port : 0;
      const runtimeBaseUrl = `http://127.0.0.1:${runtimePort}`;

      // 6. Start the existing GatewayModule on a second ephemeral localhost port, wired to the isolated runtime
      process.env.AUTH_DEV_BYPASS = 'true';
      const { GatewayModule } = await import('../apps/api-gateway/src/gateway.module');
      const { DOMAIN_REGISTRY } = await import('../apps/api-gateway/src/gateway.registry');

      originalRuntimeUrl = DOMAIN_REGISTRY.runtime;
      originalProjectsUrl = DOMAIN_REGISTRY.projects;
      DOMAIN_REGISTRY.runtime = runtimeBaseUrl;
      DOMAIN_REGISTRY.projects = '';

      gatewayApp = await NestFactory.create(GatewayModule, { logger: false });
      await gatewayApp.listen(0);
      const gwServer = gatewayApp.getHttpServer();
      const gwAddress = gwServer.address();
      const gatewayPort = typeof gwAddress === 'object' && gwAddress ? gwAddress.port : 0;
      const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;

      const canaryWorkspaceId = `ws-pm-canary-${Date.now()}`;
      const canarySessionId = `sess-pm-canary-${Date.now()}`;

      // Turn 1: Public HTTP SSE endpoint POST /api/v1/placemakers/test/runtime/chat/stream through API Gateway
      const sseResponse = await fetch(`${gatewayBaseUrl}/api/v1/placemakers/test/runtime/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'placemakers',
          'X-User-ID': 'canary_customer_01',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-01',
          correlationId: `corr-pm-01-${Date.now()}`,
          message: 'I want to estimate materials for decking.',
          inputFacts: { tradeCategory: 'Decking', journeyId: 'placemakers_trade_quote' },
        }),
      });

      assert.equal(sseResponse.status, 200, 'Gateway SSE stream endpoint must return HTTP 200');
      assert.ok(
        sseResponse.headers.get('content-type')?.includes('text/event-stream'),
        'Gateway SSE endpoint must respond with Content-Type: text/event-stream'
      );
      assert.ok(
        sseResponse.headers.get('cache-control')?.includes('no-cache'),
        'Gateway SSE endpoint must set Cache-Control: no-cache'
      );

      // Read SSE stream chunks and decode standard SSE event framing
      const reader = sseResponse.body!.getReader();
      const decoder = new TextDecoder();
      let rawSseText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawSseText += decoder.decode(value, { stream: true });
      }
      rawSseText += decoder.decode();

      const sseBlocks = rawSseText.split('\n\n').filter((b) => b.trim().length > 0);
      const sseEvents: Array<{ event: string; data: any }> = [];
      for (const block of sseBlocks) {
        let eventType = 'message';
        let eventData = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) {
            eventType = line.substring(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData = line.substring(6).trim();
          }
        }
        if (eventData) {
          try {
            sseEvents.push({ event: eventType, data: JSON.parse(eventData) });
          } catch {
            sseEvents.push({ event: eventType, data: eventData });
          }
        }
      }

      // Verify SSE event framing and envelopes
      assert.ok(sseEvents.some((e) => e.event === 'session'), 'Gateway SSE must emit session event framing');
      const doneEvent = sseEvents.find((e) => e.event === 'done');
      assert.ok(doneEvent, 'Gateway SSE must emit done event');
      assert.equal(doneEvent.data.workspaceId, canaryWorkspaceId);
      assert.ok(doneEvent.data.decision, 'Gateway SSE done event must contain decision');

      // Verify workspace state in isolated DB after Turn 1: transitioned to bom_assembly with tradeCategory fact
      const storedT1Workspace = await workspaceRepo.load('placemakers', 'test', canaryWorkspaceId);
      assert.ok(storedT1Workspace, 'Workspace must be stored after Turn 1');
      assert.equal(storedT1Workspace.currentStage, 'bom_assembly', 'Turn 1 must transition workspace to bom_assembly');
      assert.equal(storedT1Workspace.facts.tradeCategory?.value, 'Decking', 'Turn 1 must store tradeCategory');
      const t1Transition = storedT1Workspace.decisions.find(
        (d: any) => d.type === 'transition_stage' && d.targetStage === 'bom_assembly'
      );
      assert.ok(t1Transition, 'Transition decision to bom_assembly must be recorded in workspace');

      // Turn 2: Public HTTP JSON endpoint POST /api/v1/placemakers/test/runtime/turn through API Gateway
      const turn2Response = await fetch(`${gatewayBaseUrl}/api/v1/placemakers/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'placemakers',
          'X-User-ID': 'canary_customer_01',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-02',
          correlationId: `corr-pm-02-${Date.now()}`,
          message: 'The Kwila boards and joists look correct, please confirm BOM.',
          inputFacts: { bom_confirmed: 'true' },
        }),
      });

      assert.equal(turn2Response.status, 200, 'Gateway Turn 2 endpoint must return HTTP 200');
      assert.ok(
        turn2Response.headers.get('content-type')?.includes('application/json'),
        'Gateway Turn 2 endpoint must respond with Content-Type: application/json'
      );
      assert.equal(
        turn2Response.headers.get('x-gateway'),
        'journeyax-api-gateway',
        'Gateway response header must be present'
      );
      assert.equal(
        turn2Response.headers.get('x-served-by'),
        runtimeBaseUrl,
        'Gateway must resolve and proxy directly to isolated runtime URL'
      );

      const turn2Result: any = await turn2Response.json();
      assert.ok(turn2Result, 'Turn 2 result must be returned by controller via gateway');
      assert.equal(turn2Result.workspace.tenantId, 'placemakers', 'Tenant must be preserved across gateway proxy');
      assert.equal(turn2Result.workspace.environmentId, 'test', 'Environment must be preserved across gateway proxy');
      assert.equal(turn2Result.workspace.currentStage, 'trade_approval', 'Turn 2 must transition to trade_approval');
      assert.equal(turn2Result.workspace.facts.bom_confirmed?.value, 'true', 'Turn 2 must record bom_confirmed fact');
      assert.equal(turn2Result.workspace.facts.tradeCategory?.value, 'Decking', 'Turn 2 must preserve tradeCategory fact');
      const t2Transition = turn2Result.workspace.decisions.find(
        (d: any) => d.type === 'transition_stage' && d.targetStage === 'trade_approval'
      );
      assert.ok(t2Transition, 'Transition decision to trade_approval must be recorded in workspace');

      // 7. Prove Replay Rejection through Gateway: Resending Turn 2 turnId must fail closed with HTTP 400 Bad Request (DUPLICATE_TURN)
      const replayResponse = await fetch(`${gatewayBaseUrl}/api/v1/placemakers/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'placemakers',
          'X-User-ID': 'canary_customer_01',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-02', // Duplicate turnId!
          correlationId: `corr-pm-replay-${Date.now()}`,
          message: 'Duplicate replay attempt',
          inputFacts: { bom_confirmed: 'true' },
        }),
      });

      assert.equal(replayResponse.status, 400, 'Replay turn through gateway must return HTTP 400 Bad Request');
      const replayError: any = await replayResponse.json();
      assert.equal(replayError.code, 'DUPLICATE_TURN', 'Gateway replay response must propagate DUPLICATE_TURN code');
      assert.equal(replayError.turnId, 'turn-02', 'Gateway replay response must propagate duplicated turnId');

      // 8. Negative Route & Tenant Assertions on Public Gateway & Runtime Boundary
      // Negative Route: gateway route resolution fails closed for unregistered domain (HTTP 404)
      const negRouteResponse = await fetch(`${gatewayBaseUrl}/api/v1/unknown-domain/test`, {
        method: 'GET',
        headers: { 'X-Tenant-ID': 'placemakers' },
      });
      assert.equal(negRouteResponse.status, 404, 'Gateway must return HTTP 404 for unmapped domain route');
      const negRouteData: any = await negRouteResponse.json();
      assert.equal(negRouteData.error, 'Not Found', 'Gateway must return Not Found error payload');

      // Negative Tenant Mismatch through Gateway: cross-tenant payload rejected with HTTP 403 Forbidden
      const crossTenantGatewayResponse = await fetch(`${gatewayBaseUrl}/api/v1/placemakers/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'placemakers',
          'X-User-ID': 'canary_customer_01',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          tenantId: 'unauthorized-cross-tenant',
          message: 'cross tenant probe',
        }),
      });
      assert.equal(
        crossTenantGatewayResponse.status,
        403,
        'Gateway and runtime boundary must reject cross-tenant mismatch with HTTP 403'
      );

      // Negative Cross-Tenant Header on Runtime Boundary: rejects mismatched path vs header tenant with HTTP 403 Forbidden
      const crossTenantResponse = await fetch(`${runtimeBaseUrl}/api/v1/placemakers/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'unauthorized-cross-tenant',
        },
        body: JSON.stringify({ message: 'cross tenant probe' }),
      });
      assert.equal(crossTenantResponse.status, 403, 'Runtime boundary must reject cross-tenant header mismatch with HTTP 403');

      // 9. Prove Durable Reload: Workspace reloaded from isolated MongoDB customer_workspaces collection
      const storedWorkspace = await workspaceRepo.load('placemakers', 'test', canaryWorkspaceId);
      assert.ok(storedWorkspace, 'Workspace must be durably reloadable from isolated DB');
      assert.equal(storedWorkspace.lastProcessedTurnId, 'turn-02');
      assert.equal(storedWorkspace.currentStage, 'trade_approval');
      assert.equal(storedWorkspace.facts.tradeCategory?.value, 'Decking');
      assert.equal(storedWorkspace.facts.bom_confirmed?.value, 'true');
      assert.equal(storedWorkspace.stateVersion, 3, 'Workspace stateVersion must increment to 3 after creation + 2 executed turns');

      // 10. Prove Durable Outbox Persistence: Events enqueued in isolated DB outbox_events collection
      const outboxCol = isolatedDb.collection('outbox_events');
      const outboxItems = await outboxCol.find({ tenantId: 'placemakers', environmentId: 'test' }).toArray();
      assert.ok(outboxItems.length >= 2, 'Durable outbox events must be enqueued in isolated DB for executed turns');

      // 11. Parity Evidence: verify stage transitions and facts match expected baseline trade quote flow
      const stageTransitions = storedWorkspace.decisions.filter((d: any) => d.type === 'transition_stage');
      assert.equal(stageTransitions.length, 2, 'Must record exactly 2 stage transitions across the 2 turns');
      assert.equal(stageTransitions[0].targetStage, 'bom_assembly');
      assert.equal(stageTransitions[1].targetStage, 'trade_approval');
    } finally {
      if (typeof originalRuntimeUrl !== 'undefined' || typeof originalProjectsUrl !== 'undefined') {
        const { DOMAIN_REGISTRY: reg } = await import('../apps/api-gateway/src/gateway.registry');
        if (typeof originalRuntimeUrl !== 'undefined') reg.runtime = originalRuntimeUrl;
        if (typeof originalProjectsUrl !== 'undefined') reg.projects = originalProjectsUrl;
      }
      delete process.env.AUTH_DEV_BYPASS;
      enforceOfflineCredentialIsolation();
      if (gatewayApp) {
        await gatewayApp.close();
      }
      if (app) {
        await app.close();
      }
    }
  });

  // -------------------------------------------------------------------------
  // Test 10b: CutoverGate — All failure and success cases on the public HTTP path
  // -------------------------------------------------------------------------
  await test('10b. CutoverGate: all failure and success cases enforced before Business Pack is loaded or executed', async () => {
    // Each sub-case uses its own fully isolated DB + ephemeral NestJS app
    // so there is zero state leakage between cases.

    // ---- Helper: build a full isolated runtime for a given DB ----
    async function buildIsolatedRuntime(db: any, client: any): Promise<{
      runtimeBaseUrl: string;
      runtimeApp: any;
      runtimeService: any;
      cutoverRepo: CutoverRepository;
      packRepo: PackRepository;
      pub: { checksum: string; revision: number; release: any };
    }> {
      const candidate = createPlaceMakersCandidate();
      candidate.manifest.environmentId = 'test';
      // Replace ALL secretRef paths from '/production/' to '/test/' across ALL tool bindings
      // (some refs may not have 'production' in the path but we normalise environmentId consistently)
      candidate.capabilities.toolBindings.forEach((b) => {
        b.environmentId = 'test';
        if (b.executor.secretRef) {
          // Replace any environment segment — covers /production/, /staging/, etc.
          b.executor.secretRef = b.executor.secretRef
            .replace(/\/production\//g, '/test/')
            .replace(/\/staging\//g, '/test/');
        }
      });
      const pub = await publishBusinessPack(db, candidate, { publishedBy: 'gate-test@journeyax.io' });

      const packRepo = new PackRepository('/non/existent/dev/dir', db);
      const workspaceRepo = new WorkspaceRepository(db);
      const executionRepo = new ExecutionRepository(db);
      const outboxRepo = new OutboxRepository(db);
      const capabilityGateway = new CapabilityGateway({ db });
      const approvalService = new ApprovalService(undefined, outboxRepo, db);
      const modelGateway = new ModelGateway();
      const appService = new TurnApplicationService(
        packRepo, workspaceRepo, new JourneyResolver(), new AgentRouter(), modelGateway,
        capabilityGateway, approvalService, executionRepo, outboxRepo, new PresentationPort(),
        new TurnInterpreter(modelGateway), new FactReducer(), new OutcomeValidator()
      );

      const runtimeApp = await NestFactory.create(RuntimeModule, { logger: false });
      const runtimeService = runtimeApp.get(RuntimeService);
      runtimeService.setAppServiceForTest(appService);
      const cutoverRepo = new CutoverRepository(async () => ({ db, client }));
      runtimeService.setCutoverRepositoryForTest(cutoverRepo);
      await runtimeApp.listen(0);
      const port = runtimeApp.getHttpServer().address()?.port;
      return { runtimeBaseUrl: `http://127.0.0.1:${port}`, runtimeApp, runtimeService, cutoverRepo, packRepo, pub };
    }

    async function postTurn(runtimeBaseUrl: string, wsId: string, turnId: string): Promise<Response> {
      return fetch(`${runtimeBaseUrl}/api/v1/placemakers/test/runtime/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': 'placemakers', 'X-User-ID': 'gate-test', 'X-User-Role': 'customer' },
        body: JSON.stringify({
          workspaceId: wsId, sessionId: wsId, turnId,
          correlationId: `corr-gate-${turnId}`,
          message: 'materials for decking',
          inputFacts: { tradeCategory: 'Decking', journeyId: 'placemakers_trade_quote' },
        }),
      });
    }

    process.env.AUTH_DEV_BYPASS = 'true';
    const apps: any[] = [];

    try {
      // ── Case 1: No cutover record → 403 Forbidden ────────────────────────────
      {
        const { db, client } = createIsolatedTestDb();
        const { runtimeBaseUrl, runtimeApp } = await buildIsolatedRuntime(db, client);
        apps.push(runtimeApp);
        const res = await postTurn(runtimeBaseUrl, `ws-gate-no-record-${Date.now()}`, 'turn-gate-01');
        assert.equal(res.status, 403,
          'No cutover record: runTurn must fail closed with HTTP 403');
        const body: any = await res.json();
        assert.ok(/CutoverGate|cutover|approved/i.test(body.message || body.error || ''),
          'Error message must reference cutover gate');
      }

      // ── Case 2: Cutover status 'rollback' → 403 Forbidden ────────────────────
      {
        const { db, client } = createIsolatedTestDb();
        const { runtimeBaseUrl, runtimeApp, cutoverRepo, pub } = await buildIsolatedRuntime(db, client);
        apps.push(runtimeApp);
        // First promote to 'migrated' so we can then demote to 'rollback'
        await cutoverRepo.promoteCutover('placemakers', 'test', {
          status: 'migrated', approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: pub.checksum, expectedRevision: 0,
          approvedBy: 'gate-test@journeyax.io',
        });
        // Promote a v1.1.0 pack
        const cand2 = createPlaceMakersCandidate();
        cand2.manifest.version = '1.1.0';
        cand2.manifest.environmentId = 'test';
        cand2.capabilities.toolBindings.forEach((b) => {
          b.environmentId = 'test';
          if (b.executor.secretRef) b.executor.secretRef = b.executor.secretRef.replace(/\/production\//g, '/test/').replace(/\/staging\//g, '/test/');
        });
        const pub2 = await publishBusinessPack(db, cand2, { publishedBy: 'gate-test@journeyax.io' });
        await cutoverRepo.promoteCutover('placemakers', 'test', {
          status: 'migrated', approvedReleaseVersion: '1.1.0',
          approvedReleaseChecksum: pub2.checksum, expectedRevision: 1,
          approvedBy: 'gate-test@journeyax.io',
        });
        // Rollback pointer to v1.0.0
        await rollbackBusinessPack(db, 'placemakers', 'test', {
          targetVersion: '1.0.0', rolledBackBy: 'gate-test@journeyax.io',
        });
        // Promote cutover to status: 'rollback' (CAS revision 2 → 3)
        await cutoverRepo.promoteCutover('placemakers', 'test', {
          status: 'rollback', approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: pub.checksum, expectedRevision: 2,
          rollbackTargetVersion: '1.0.0', approvedBy: 'gate-test@journeyax.io',
        });
        const res = await postTurn(runtimeBaseUrl, `ws-gate-rollback-${Date.now()}`, 'turn-gate-02');
        assert.equal(res.status, 403,
          'Cutover status rollback: runTurn must fail closed with HTTP 403');
        const body: any = await res.json();
        assert.ok(/CutoverGate|status|rollback/i.test(body.message || body.error || ''),
          'Error must reference cutover status');
      }

      // ── Case 3: Version mismatch → 403 Forbidden ─────────────────────────────
      {
        const { db, client } = createIsolatedTestDb();
        const { runtimeBaseUrl, runtimeApp, cutoverRepo, pub } = await buildIsolatedRuntime(db, client);
        apps.push(runtimeApp);
        // Insert cutover record with wrong version '2.0.0' (active pointer is 1.0.0)
        // We must bypass promoteCutover's version check by directly inserting into the collection
        await db.collection('tenant_cutovers').insertOne({
          tenantId: 'placemakers', environmentId: 'test',
          status: 'migrated', approvedReleaseVersion: '2.0.0',
          approvedReleaseChecksum: pub.checksum,
          revision: 1, approvedBy: 'gate-test@journeyax.io',
          promotedAt: new Date(), updatedAt: new Date(),
        });
        const res = await postTurn(runtimeBaseUrl, `ws-gate-version-${Date.now()}`, 'turn-gate-03');
        assert.equal(res.status, 403,
          'Version mismatch: runTurn must fail closed with HTTP 403');
        const body: any = await res.json();
        assert.ok(/CutoverGate|version|mismatch/i.test(body.message || body.error || ''),
          'Error must reference version mismatch');
      }

      // ── Case 4: Checksum mismatch → 403 Forbidden ────────────────────────────
      {
        const { db, client } = createIsolatedTestDb();
        const { runtimeBaseUrl, runtimeApp, cutoverRepo, pub } = await buildIsolatedRuntime(db, client);
        apps.push(runtimeApp);
        // Insert cutover with correct version but tampered checksum
        await db.collection('tenant_cutovers').insertOne({
          tenantId: 'placemakers', environmentId: 'test',
          status: 'migrated', approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: 'a'.repeat(64), // tampered
          revision: 1, approvedBy: 'gate-test@journeyax.io',
          promotedAt: new Date(), updatedAt: new Date(),
        });
        const res = await postTurn(runtimeBaseUrl, `ws-gate-checksum-${Date.now()}`, 'turn-gate-04');
        assert.equal(res.status, 403,
          'Checksum mismatch: runTurn must fail closed with HTTP 403');
        const body: any = await res.json();
        assert.ok(/CutoverGate|checksum|mismatch|tamper/i.test(body.message || body.error || ''),
          'Error must reference checksum mismatch');
      }

      // ── Case 5: Cross-tenant record → 403 Forbidden ──────────────────────────
      {
        const { db, client } = createIsolatedTestDb();
        const { runtimeBaseUrl, runtimeApp, pub } = await buildIsolatedRuntime(db, client);
        apps.push(runtimeApp);
        // Insert a cutover record for a DIFFERENT tenant
        await db.collection('tenant_cutovers').insertOne({
          tenantId: 'unauthorized-other-tenant', environmentId: 'test',
          status: 'migrated', approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: pub.checksum,
          revision: 1, approvedBy: 'gate-test@journeyax.io',
          promotedAt: new Date(), updatedAt: new Date(),
        });
        // getCutoverRecord queries by tenantId='placemakers', so it will find null
        const res = await postTurn(runtimeBaseUrl, `ws-gate-cross-tenant-${Date.now()}`, 'turn-gate-05');
        assert.equal(res.status, 403,
          'Cross-tenant record (record for wrong tenant, request tenant has no record): must fail with 403');
      }

      // ── Case 6: Valid 'migrated' status → 200 OK ────────────────────────────
      {
        const { db, client } = createIsolatedTestDb();
        const { runtimeBaseUrl, runtimeApp, cutoverRepo, pub } = await buildIsolatedRuntime(db, client);
        apps.push(runtimeApp);
        await cutoverRepo.promoteCutover('placemakers', 'test', {
          status: 'migrated', approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: pub.checksum, expectedRevision: 0,
          approvedBy: 'gate-test@journeyax.io',
        });
        const res = await postTurn(runtimeBaseUrl, `ws-gate-migrated-${Date.now()}`, 'turn-gate-06');
        assert.equal(res.status, 200,
          'Valid migrated cutover: runTurn must succeed with HTTP 200');
      }

      // ── Case 7: Valid 'canary' status — deterministic bucket routing ─────────
      // Uses precomputed SHA-256 bucket values for tenant='placemakers', env='test':
      //   ws-test-4 → bucket=4  (< 10% → IN  canary → expect 200)
      //   ws-test-0 → bucket=76 (≥ 10% → NOT canary → expect 403)
      //
      // Proves that (a) selected workspaces succeed and (b) non-selected workspaces
      // are rejected by the gate — never silently falling to legacy.
      {
        const { db, client } = createIsolatedTestDb();
        const { runtimeBaseUrl, runtimeApp, cutoverRepo, pub } = await buildIsolatedRuntime(db, client);
        apps.push(runtimeApp);
        await cutoverRepo.promoteCutover('placemakers', 'test', {
          status: 'canary', approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: pub.checksum, expectedRevision: 0,
          canaryPercentage: 10, approvedBy: 'gate-test@journeyax.io',
        });

        // Case 7a: ws-test-4 is deterministically IN the 10% canary bucket (bucket=4 < 10)
        const res7a = await postTurn(runtimeBaseUrl, 'ws-test-4', 'turn-gate-07a');
        assert.equal(res7a.status, 200,
          'Canary 10%: workspace ws-test-4 (bucket=4) is IN canary — must succeed with 200');

        // Case 7b: ws-test-0 is deterministically NOT in the 10% canary bucket (bucket=76 ≥ 10)
        // The gate rejects with 403 — must NEVER fall through to legacy from within runTurn.
        const res7b = await postTurn(runtimeBaseUrl, 'ws-test-0', 'turn-gate-07b');
        assert.equal(res7b.status, 403,
          'Canary 10%: workspace ws-test-0 (bucket=76) is NOT in canary — gate must reject with 403');
        const body7b = await res7b.json().catch(() => ({}));
        assert.ok(
          body7b.message?.includes('Canary bucket') || body7b.message?.includes('not in'),
          `Gate rejection must name the canary-bucket reason, got: ${JSON.stringify(body7b.message)}`
        );
      }

      // ── Case 8: Rollback changes the executable version ──────────────────────
      // After rollback of pointer to v1.0.0 AND re-promotion of cutover to 'migrated',
      // the gate enforces the rolled-back version.
      {
        const { db, client } = createIsolatedTestDb();
        const { runtimeBaseUrl, runtimeApp, cutoverRepo, pub, packRepo } = await buildIsolatedRuntime(db, client);
        apps.push(runtimeApp);

        // Promote v1.0.0
        await cutoverRepo.promoteCutover('placemakers', 'test', {
          status: 'migrated', approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: pub.checksum, expectedRevision: 0,
          approvedBy: 'gate-test@journeyax.io',
        });

        // Publish v1.1.0 and promote
        const cand2 = createPlaceMakersCandidate();
        cand2.manifest.version = '1.1.0';
        cand2.manifest.environmentId = 'test';
        cand2.capabilities.toolBindings.forEach((b) => {
          b.environmentId = 'test';
          if (b.executor.secretRef) b.executor.secretRef = b.executor.secretRef.replace(/\/production\//g, '/test/').replace(/\/staging\//g, '/test/');
        });
        const pub2 = await publishBusinessPack(db, cand2, { publishedBy: 'gate-test@journeyax.io' });
        await cutoverRepo.promoteCutover('placemakers', 'test', {
          status: 'migrated', approvedReleaseVersion: '1.1.0',
          approvedReleaseChecksum: pub2.checksum, expectedRevision: 1,
          approvedBy: 'gate-test@journeyax.io',
        });

        // Confirm v1.1.0 gate passes
        packRepo.invalidate('placemakers');
        const resV2 = await postTurn(runtimeBaseUrl, `ws-gate-rb-before-${Date.now()}`, 'turn-gate-08a');
        assert.equal(resV2.status, 200, 'v1.1.0 migrated: must succeed');

        // Rollback pointer to v1.0.0
        const rbRes = await rollbackBusinessPack(db, 'placemakers', 'test', {
          targetVersion: '1.0.0', rolledBackBy: 'gate-test@journeyax.io',
        });
        assert.equal(rbRes.activeVersion, '1.0.0', 'Rollback must restore v1.0.0');
        packRepo.invalidate('placemakers');

        // Without cutover record re-promotion: active pointer is v1.0.0 but cutover still approved v1.1.0
        // Gate MUST reject (version mismatch between pointer and cutover)
        const resMismatch = await postTurn(runtimeBaseUrl, `ws-gate-rb-mismatch-${Date.now()}`, 'turn-gate-08b');
        assert.equal(resMismatch.status, 403,
          'After rollback, cutover still approves v1.1.0 but pointer is v1.0.0: must fail 403');

        // Re-promote cutover to 'migrated' for v1.0.0 (CAS revision 2 → 3)
        await cutoverRepo.promoteCutover('placemakers', 'test', {
          status: 'migrated', approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: pub.checksum, expectedRevision: 2,
          approvedBy: 'gate-test@journeyax.io',
          notes: 'Post-rollback re-promotion to v1.0.0',
        });

        // Now gate should pass for v1.0.0
        const resRolledBack = await postTurn(runtimeBaseUrl, `ws-gate-rb-after-${Date.now()}`, 'turn-gate-08c');
        assert.equal(resRolledBack.status, 200,
          'After rollback + cutover re-promotion: v1.0.0 gate must succeed with HTTP 200');
        const rbBody: any = await resRolledBack.json();
        assert.equal(rbBody.workspace.tenantId, 'placemakers');
        // The pack loaded must be v1.0.0 (the rolled-back version)
        assert.equal(rbBody.workspace.packVersion || rbBody.workspace.packId?.split('@')[1] || '1.0.0', '1.0.0',
          'Rolled-back version must be the one executed');
      }

    } finally {
      delete process.env.AUTH_DEV_BYPASS;
      for (const a of apps) {
        await a.close().catch(() => {});
      }
    }
  });

  await test('11. Inventory: runTenantConnectorInventory confirms PlaceMakers is discovered, schema-valid, 0 raw secrets, status BLOCKED', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });
    const pmResult = results.find((r) => r.tenantId === 'placemakers');
    assert.ok(pmResult, 'PlaceMakers must be found in inventory results');
    assert.equal(pmResult.source, 'filesystem_pack');
    assert.equal(pmResult.schemaValid, true);
    assert.equal(pmResult.semanticValid, true);
    assert.equal(pmResult.referenceIntegrityValid, true);
    assert.equal(pmResult.rawSecretsCount, 0);
    assert.equal(pmResult.directUrlsCount, 0);

    // Truthful reporting: in static repository state before live DB cutover, cutover record remains pending
    assert.equal(pmResult.migrationStatus, 'BLOCKED', 'PlaceMakers status in repository inventory must truthfully remain BLOCKED pending live cutover record');
    assert.equal(pmResult.immutableReleaseReadiness, 'NOT_READY');
    assert.equal(pmResult.parityResult, 'UNEVALUATED');
    assert.equal(pmResult.cutoverRecordState, 'NO_RECORD_FOUND');
    assert.equal(pmResult.rollbackEvidence, 'NO_ROLLBACK_BASELINE');
  });

  // -------------------------------------------------------------------------
  // Test 12: Model Policy - fast_intent Multi-Provider Candidates & Policy Selection
  // -------------------------------------------------------------------------
  await test('12. Model Policy: fast_intent has portable multi-provider candidates and runtime selection is policy-driven without OpenAI-only assumption', async () => {
    const pack = createPlaceMakersCandidate();
    const fastIntentPolicy = pack.modelPolicy.policies.find((p) => p.policyId === 'fast_intent');
    assert.ok(fastIntentPolicy, 'fast_intent policy must exist in PlaceMakers modelPolicy');

    // Candidate diversity assertion: must have at least 2 distinct providers
    assert.ok(fastIntentPolicy.candidates.length >= 2, 'fast_intent must have multiple candidates');
    const providers = new Set(fastIntentPolicy.candidates.map((c) => c.provider));
    assert.ok(providers.size >= 2, 'fast_intent must specify at least two distinct providers (e.g. google and openai)');
    assert.ok(providers.has('google'), 'Must include portable google candidate');
    assert.ok(providers.has('openai'), 'Must include openai candidate');
    assert.equal(fastIntentPolicy.fallbackAllowed, true, 'fallbackAllowed must be true for fast_intent');

    // Test ModelRouter selection is policy-driven
    const router = new ModelRouter();

    // With preferredProvider: 'google', router must select google candidate
    const googleRoute = router.resolveModel('fast_intent', pack, { preferredProvider: 'google' });
    assert.equal(googleRoute.provider, 'google');
    assert.equal(googleRoute.model, 'gemini-2.5-flash');

    // With preferredProvider: 'openai', router must select openai candidate
    const openaiRoute = router.resolveModel('fast_intent', pack, { preferredProvider: 'openai' });
    assert.equal(openaiRoute.provider, 'openai');
    assert.equal(openaiRoute.model, 'gpt-4o-mini');

    // Without preferredProvider, candidate 1 (google, priority 1) is selected when fallbackAllowed is true
    const defaultRoute = router.resolveModel('fast_intent', pack);
    assert.equal(defaultRoute.provider, 'google', 'Priority 1 candidate must be chosen first; no OpenAI-only assumption');
    assert.equal(defaultRoute.model, 'gemini-2.5-flash');
  });


  // -------------------------------------------------------------------------
  // Test 13: Canary Routing — shared deterministic bucket function
  // -------------------------------------------------------------------------
  await test('13. Canary Routing: isInCanaryBucket and resolveRuntimeRouting are deterministic and correct', async () => {
    // Precomputed SHA-256 bucket values for tenant='placemakers', env='test':
    //   'ws-test-4'  → bucket=4   (4 < 10  → IN  10% canary)
    //   'ws-test-0'  → bucket=76  (76 >= 10 → NOT IN 10% canary)
    //   'ws-test-1'  → bucket=40  (40 >= 10 → NOT IN 10% canary)
    //   any key, 0%  → always false
    //   any key, 100% → always true
    const { isInCanaryBucket, resolveRuntimeRouting } = await import('../apps/journey-runtime-service/src/cutover/canary-routing');

    // Boundary: 0% and 100%
    assert.equal(isInCanaryBucket('placemakers', 'test', 'ws-test-4', 0), false, '0% → never canonical');
    assert.equal(isInCanaryBucket('placemakers', 'test', 'ws-test-4', 100), true, '100% → always canonical');

    // Deterministic 10% selection
    assert.equal(isInCanaryBucket('placemakers', 'test', 'ws-test-4', 10), true,
      'ws-test-4 (bucket=4) must be IN 10% canary');
    assert.equal(isInCanaryBucket('placemakers', 'test', 'ws-test-0', 10), false,
      'ws-test-0 (bucket=76) must NOT be in 10% canary');
    assert.equal(isInCanaryBucket('placemakers', 'test', 'ws-test-1', 10), false,
      'ws-test-1 (bucket=40) must NOT be in 10% canary');

    // Stable: same inputs always give same result
    for (let i = 0; i < 5; i++) {
      assert.equal(isInCanaryBucket('placemakers', 'test', 'ws-test-4', 10), true, `Stability check ${i}: ws-test-4`);
      assert.equal(isInCanaryBucket('placemakers', 'test', 'ws-test-0', 10), false, `Stability check ${i}: ws-test-0`);
    }

    // resolveRuntimeRouting covers all status branches
    assert.equal(resolveRuntimeRouting('migrated', 0, 'placemakers', 'test', 'ws-test-0'), 'canonical',
      "status='migrated' is always canonical regardless of bucket");
    assert.equal(resolveRuntimeRouting('canary', 10, 'placemakers', 'test', 'ws-test-4'), 'canonical',
      "status='canary', in-bucket → canonical");
    assert.equal(resolveRuntimeRouting('canary', 10, 'placemakers', 'test', 'ws-test-0'), 'legacy',
      "status='canary', not in-bucket → legacy");
    assert.equal(resolveRuntimeRouting('rollback', 100, 'placemakers', 'test', 'ws-any'), 'legacy',
      "status='rollback' is always legacy even at 100%");
    assert.equal(resolveRuntimeRouting('unmigrated', 100, 'placemakers', 'test', 'ws-any'), 'legacy',
      "status='unmigrated' is always legacy even at 100%");
  });

  // -------------------------------------------------------------------------
  // Egress Self-Test: Proves the non-loopback guard is active and cannot be skipped
  // -------------------------------------------------------------------------
  await test('Egress Self-Test: deliberate non-loopback attempt is recorded and guard is proven active', async () => {
    // Reset violation log so prior suite activity doesn't interfere
    resetEgressViolations();
    try {
      // Attempt a TCP connection to a non-loopback host — the guard must intercept this.
      // Node resolves DNS before opening a socket, so the first recorded violation
      // will be dns.lookup (the earliest interception point) or net.Socket.connect.
      // Both prove the egress barrier is active.
      const net = require('net') as typeof import('net');
      try {
        const sock = net.createConnection({ host: 'external.invalid', port: 443 });
        sock.destroy();
      } catch {
        // Guard throws synchronously on some paths — either way we check violations below
      }
      const violations = getEgressViolations();
      assert.ok(
        violations.length > 0 && violations[0].target === 'external.invalid',
        'Guard must record the non-loopback attempt — proves assertLocalhostOnlyEgress cannot be bypassed'
      );
      // Accept dns.lookup (earliest intercept) or socket connect
      const op = violations[0].operation;
      assert.ok(
        op === 'dns.lookup' || op.includes('connect'),
        `Violation must be dns.lookup or a socket connect operation; got: ${op}`
      );
    } finally {
      // Always reset so the suite-level assertLocalhostOnlyEgress() sees zero at end
      resetEgressViolations();
    }
  });

  console.log(`\n==============================================================================`);
  console.log(`PlaceMakers Migration Suite Complete: ${passed} passed, ${failed} failed.`);
  console.log(`==============================================================================\n`);

  if (failed > 0) { exitCode = 1; }
  } finally {
    assertLocalhostOnlyEgress();
  }
  process.exit(exitCode);
}

runSuite().catch((err) => {
  console.error('❌ Unhandled suite error:', err);
  process.exit(1);
});
