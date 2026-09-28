/**
 * workweargroup-migration.spec.ts
 *
 * Enterprise Closure Suite:
 * 1. Authoritative Audit of packs/workweargroup (12 files) with domain-neutral executable journeys,
 *    reference integrity, connector boundary compliance, model-policy portability, registered UI cards,
 *    and removal of legacy handler/filesystem runtime dependency after activation.
 * 2. Canonical publisher, loader, CutoverRepository (CAS cutover & atomic rollback), and public API-Gateway to
 *    HTTP/SSE runtime path in strictly isolated local storage without network access or fake outputs.
 * 3. Truthful blocker verification confirming workweargroup migrationStatus is BLOCKED and readiness is NOT_READY.
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
import fs from 'node:fs';
import path from 'node:path';
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
import { CARD_TYPE_NAMES } from '@journeyax/ui-cards';
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

function getNestedValue(obj: any, pathStr: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (pathStr in obj) return obj[pathStr];
  const parts = pathStr.split('.');
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

/**
 * Isolated in-memory database implementation conforming to Mongo Db & MongoClient interface
 */
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
          const found = items.find((doc) => matchesFilter(doc, filter));
          return found ? JSON.parse(JSON.stringify(found)) : null;
        },
        countDocuments: async (filter: any = {}) => {
          return items.filter((doc) => matchesFilter(doc, filter)).length;
        },
        insertOne: async (doc: any) => {
          const copy = JSON.parse(JSON.stringify(doc));
          if (!copy._id) copy._id = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          items.push(copy);
          return { insertedId: copy._id, acknowledged: true };
        },
        insertMany: async (docs: any[]) => {
          for (const doc of docs) {
            const copy = JSON.parse(JSON.stringify(doc));
            if (!copy._id) copy._id = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            items.push(copy);
          }
          return { acknowledged: true, insertedCount: docs.length };
        },
        deleteOne: async (filter: any) => {
          const idx = items.findIndex((doc) => matchesFilter(doc, filter));
          if (idx >= 0) {
            items.splice(idx, 1);
            return { deletedCount: 1, acknowledged: true };
          }
          return { deletedCount: 0, acknowledged: true };
        },
        deleteMany: async (filter: any) => {
          let count = 0;
          for (let i = items.length - 1; i >= 0; i--) {
            if (matchesFilter(items[i], filter)) {
              items.splice(i, 1);
              count++;
            }
          }
          return { deletedCount: count, acknowledged: true };
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
  console.log('   Workwear Group Business Pack Migration & Isolated Canary Test Suite        ');
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

  // 1. Authoritative Disk Loading & Audit of packs/workweargroup (12 files)
  const diskLoader = new BusinessPackLoader();
  const canonicalPack = await diskLoader.loadFromDisk('workweargroup', 'production');
  assert.ok(canonicalPack, 'Workwear Group pack must load from packs/workweargroup');

  const parsedCandidate = BusinessPackReleaseSchema.safeParse(canonicalPack);
  if (!parsedCandidate.success) {
    throw new Error(`Workwear Group disk pack failed schema: ${JSON.stringify(parsedCandidate.error.format())}`);
  }
  const validCandidate = validateBusinessPack(parsedCandidate.data);
  if (!validCandidate.valid) {
    throw new Error(`Workwear Group disk pack failed validation: ${JSON.stringify(validCandidate.issues)}`);
  }

  function createWorkwearGroupCandidate(): BusinessPackRelease {
    return JSON.parse(JSON.stringify(canonicalPack));
  }

  // -------------------------------------------------------------------------
  // Test 1: Negative - Missing Capability / Tool Mappings Fail Closed
  // -------------------------------------------------------------------------
  await test('1. Negative: missing tool definitions and stage capabilities fail validation and prevent publication', async () => {
    // 1a. Stage references unknown capability -> semantic error, valid === false, publisher rejects
    const badCapPack = createWorkwearGroupCandidate();
    const journey = badCapPack.journeys.find((j) => j.journeyId === 'workwear-solution')!;
    assert.ok(journey, 'workwear-solution journey must exist');
    journey.stages.understand_need.allowedCapabilities.push('unregistered.dangerous_tool');

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
    const badToolPack = createWorkwearGroupCandidate();
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
    const wildcardPack = createWorkwearGroupCandidate();
    wildcardPack.agents[0].allowedTools.push('catalog.*');
    const jWildcard = wildcardPack.journeys.find((j) => j.journeyId === 'workwear-solution')!;
    jWildcard.stages.understand_need.allowedCapabilities.push('catalog.*');

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
    const badModelRef = createWorkwearGroupCandidate();
    badModelRef.agents[0].modelPolicyRef = 'non_existent_policy';
    const valModel = validateBusinessPack(badModelRef);
    assert.equal(valModel.valid, false, 'Pack must be invalid when modelPolicyRef is missing');
    assert.ok(valModel.issues.some((i) => i.message.includes('non_existent_policy')));

    // 2b. Broken exit condition pointing to missing stage
    const badStageRef = createWorkwearGroupCandidate();
    const journey = badStageRef.journeys.find((j) => j.journeyId === 'workwear-solution')!;
    assert.ok(journey, 'workwear-solution journey must exist');
    journey.stages.understand_need.exitConditions = [
      { allFactsPresent: ['occupation'], nextStage: 'phantom_stage' },
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
    const rawSecretPack = createWorkwearGroupCandidate();
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
    const badSchemePack = createWorkwearGroupCandidate();
    badSchemePack.capabilities.toolBindings[0].executor.secretRef = 'ftp://secrets.corp/workweargroup/production/key';
    const valScheme = validateBusinessPack(badSchemePack);
    assert.equal(valScheme.valid, false, 'Pack with unsupported scheme must be strictly invalid');
    const { db: dbScheme } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbScheme, badSchemePack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with unsupported secretRef scheme'
    );

    // 3c. Arbitrary cross-tenant secretRef violation (referencing unknown tenant acme-corp)
    const crossTenantPack = createWorkwearGroupCandidate();
    crossTenantPack.capabilities.toolBindings[0].executor.secretRef = 'gcp-secret://journeyax-secrets/acme-corp/production/wwg-key';
    const valCross = validateBusinessPack(crossTenantPack);
    assert.equal(valCross.valid, false, 'Pack with cross-tenant secretRef must be strictly invalid');
    assert.ok(
      valCross.issues.some((i) => i.message.includes("references tenant 'acme-corp' but binding belongs to 'workweargroup'")),
      'Must emit Cross-tenant secretRef violation error for arbitrary unknown tenant'
    );
    const { db: dbCross } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbCross, crossTenantPack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with cross-tenant secretRef'
    );

    // 3d. Arbitrary cross-environment secretRef violation (staging secretRef on production binding)
    const crossEnvPack = createWorkwearGroupCandidate();
    crossEnvPack.capabilities.toolBindings[0].executor.secretRef = 'gcp-secret://journeyax-secrets/workweargroup/staging/wwg-key';
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
    const newTenantPack = createWorkwearGroupCandidate();
    newTenantPack.manifest.tenantId = 'globex-industrial';
    newTenantPack.manifest.environmentId = 'dev';
    for (const b of newTenantPack.capabilities.toolBindings) {
      b.tenantId = 'globex-industrial';
      b.environmentId = 'dev';
      if (b.executor.secretRef) {
        b.executor.secretRef = 'vault://secret-vault/globex-industrial/dev/wwg-key';
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
    const pack = createWorkwearGroupCandidate();
    const { checksum } = await publishBusinessPack(db, pack);

    // Tamper with checksum in DB release document
    const releasesCol = db.collection('business_pack_releases');
    await releasesCol.updateOne(
      { tenantId: 'workweargroup', version: '1.0.0' },
      { $set: { checksum: 'tampered_bad_checksum_hash' } }
    );

    const loader = new BusinessPackLoader({ db });
    const loaded = await loader.loadFromMongo('workweargroup', 'production', '1.0.0');
    assert.equal(loaded, null, 'Loader must refuse to return release with mismatched checksum');
  });

  // -------------------------------------------------------------------------
  // Test 5: Negative - Cross-Tenant Scope Isolation
  // -------------------------------------------------------------------------
  await test('5. Negative: cross-tenant isolation prevents tenant A from accessing Workwear Group release', async () => {
    const { db } = createIsolatedTestDb();
    const pack = createWorkwearGroupCandidate();
    await publishBusinessPack(db, pack);

    const loader = new BusinessPackLoader({ db });
    // Other isolated tenant must NOT be able to load Workwear Group release
    const otherLoaded = await loader.loadFromMongo('other_isolated_tenant', 'production', '1.0.0');
    assert.equal(otherLoaded, null, 'Cross-tenant isolation must prevent loading other tenant pack');

    // Pointer check for other tenant must return false
    const hasOther = await loader.hasPublishedPackAsync('other_isolated_tenant', 'production');
    assert.equal(hasOther, false, 'Other tenant must not have active pointer for Workwear Group release');
  });

  // -------------------------------------------------------------------------
  // Test 6: Lifecycle - Transactional Immutable Release Publication
  // -------------------------------------------------------------------------
  await test('6. Lifecycle: publishBusinessPack creates immutable release and enqueues outbox event', async () => {
    const { db, collections } = createIsolatedTestDb();
    const pack = createWorkwearGroupCandidate();

    const result = await publishBusinessPack(db, pack, {
      publishedBy: 'migration-orchestrator@journeyax.io',
      notes: 'Initial Workwear Group canonical migration',
    });

    assert.equal(result.release.manifest.tenantId, 'workweargroup');
    assert.equal(result.release.manifest.version, '1.0.0');
    assert.equal(result.revision, 1);
    assert.ok(result.checksum.length === 64, 'Checksum must be valid sha256 hex');

    // Verify outbox event enqueued
    const outboxEvents = collections.get('outbox_events') || [];
    assert.equal(outboxEvents.length, 1);
    assert.equal(outboxEvents[0].eventType, 'business_pack.published');
    assert.equal(outboxEvents[0].tenantId, 'workweargroup');
    assert.equal(outboxEvents[0].payload.checksum, result.checksum);

    // Verify immutable release stored
    const releases = collections.get('business_pack_releases') || [];
    assert.equal(releases.length, 1);
    assert.equal(releases[0].version, '1.0.0');

    // Attempting to overwrite with different content on same version must throw immutable release violation
    const tampered = createWorkwearGroupCandidate();
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

    const pack = createWorkwearGroupCandidate();
    const { checksum } = await publishBusinessPack(db, pack);

    // Promote cutover with expectedRevision 0 -> 1
    const promoted = await cutoverRepo.promoteCutover('workweargroup', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: checksum,
      expectedRevision: 0,
      approvedBy: 'admin-lead@journeyax.io',
      notes: 'Initial promotion of Workwear Group Business Pack',
    });

    assert.equal(promoted.status, 'migrated');
    assert.equal(promoted.revision, 1);
    assert.equal(promoted.approvedReleaseVersion, '1.0.0');
    assert.equal(promoted.approvedReleaseChecksum, checksum);

    // Verify cutovers collection in DB
    const record = await cutoverRepo.getCutoverRecord('workweargroup', 'production');
    assert.ok(record);
    assert.equal(record.status, 'migrated');
    assert.equal(record.revision, 1);

    // Concurrent promotion with stale expectedRevision (0 instead of 1) must fail with CutoverConflictError
    await assert.rejects(
      () =>
        cutoverRepo.promoteCutover('workweargroup', 'production', {
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
    const packV1 = createWorkwearGroupCandidate();
    packV1.manifest.version = '1.0.0';
    const res1 = await publishBusinessPack(db, packV1);
    await cutoverRepo.promoteCutover('workweargroup', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: res1.checksum,
      expectedRevision: 0,
      approvedBy: 'admin@journeyax.io',
    });

    // Step 2: Publish v1.1.0 and promote revision 1 -> 2
    const packV2 = createWorkwearGroupCandidate();
    packV2.manifest.version = '1.1.0';
    packV2.profile.brandTone = 'Updated brand tone for v1.1.0';
    const res2 = await publishBusinessPack(db, packV2);
    await cutoverRepo.promoteCutover('workweargroup', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.1.0',
      approvedReleaseChecksum: res2.checksum,
      expectedRevision: 1,
      approvedBy: 'admin@journeyax.io',
    });

    // Step 3: Rollback business pack pointer to v1.0.0
    const rollbackRes = await rollbackBusinessPack(db, 'workweargroup', 'production', {
      targetVersion: '1.0.0',
      rolledBackBy: 'admin-lead@journeyax.io',
      reason: 'Canary degradation test rollback',
    });
    assert.equal(rollbackRes.activeVersion, '1.0.0');

    // Step 4: Promote cutover record to status: 'rollback' with CAS revision 2 -> 3
    const cutoverRollback = await cutoverRepo.promoteCutover('workweargroup', 'production', {
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
  // Test 9: Security & Audit - 12 Files Inspection, Connector Boundary, & UI Cards
  // -------------------------------------------------------------------------
  await test('9. Security & Audit: audit all 12 files for registered UI cards, zero raw secrets, and truthful connector boundary compliance', async () => {
    const packDir = path.resolve(__dirname, '../packs/workweargroup');
    assert.ok(fs.existsSync(packDir), 'packs/workweargroup must exist');

    // Verify exactly 12 files exist in packs/workweargroup
    const expectedFiles = [
      'agents/advisor.json',
      'business-profile.json',
      'capabilities/bindings.json',
      'entities.json',
      'evaluations/workwear-acceptance.json',
      'experience/cards-and-theme.json',
      'handlers/workwear-solution.handler.ts',
      'journeys/workwear-solution.json',
      'manifest.json',
      'model-policy.json',
      'rules/budget-and-safety.json',
      'vocabulary.json',
    ];
    for (const relPath of expectedFiles) {
      assert.ok(fs.existsSync(path.join(packDir, relPath)), `File ${relPath} must exist in packs/workweargroup`);
    }

    const pack = createWorkwearGroupCandidate();

    // 1. Registered UI Cards: verify cards in experience/cards-and-theme.json are registered in @journeyax/ui-cards
    const allowedCards = pack.experience.cards.allowedCardTypes;
    assert.ok(Array.isArray(allowedCards) && allowedCards.length > 0, 'Allowed cards must be defined');
    for (const cardType of allowedCards) {
      assert.ok(
        (CARD_TYPE_NAMES as readonly string[]).includes(cardType),
        `Card type '${cardType}' must be registered in CARD_TYPE_NAMES of @journeyax/ui-cards`
      );
    }
    assert.equal(pack.experience.cards.defaultCardRenderer, '@journeyax/ui-cards');

    // 2. Zero raw secrets in pack candidate
    const packJson = JSON.stringify(pack);
    assert.ok(!packJson.includes('clientSecret'), 'Must not have clientSecret property');
    assert.ok(!packJson.includes('password'), 'Must not have password property');
    assert.ok(!packJson.includes('sk-'), 'Must not contain raw secret tokens');

    // 3. Truthful Connector Boundary Audit:
    // In legacy capabilities/bindings.json, crm.create_lead uses activepieces_flow ('ap_lead_flow_wwg')
    // but lacks connectionRef and secretRef.
    const leadBinding = pack.capabilities.toolBindings.find((b) => b.toolId === 'crm.create_lead');
    assert.ok(leadBinding, 'crm.create_lead binding must exist');
    assert.equal(leadBinding.executor.type, 'activepieces_flow');
    assert.equal(leadBinding.executor.flowId, 'ap_lead_flow_wwg');
    assert.equal((leadBinding.executor as any).connectionRef, undefined, 'Legacy binding truthfully lacks connectionRef');
    assert.equal((leadBinding.executor as any).secretRef, undefined, 'Legacy binding truthfully lacks secretRef');

    // 4. Validate canonical tenant-scoped secretRef format when properly configured
    const testSecretRef = 'gcp-secret://journeyax-secrets/workweargroup/production/wwg-lead-key';
    const parsedRef = parseCanonicalSecretRef(testSecretRef);
    assert.ok(parsedRef.parsed, 'Must parse canonical secretRef');
    assert.equal(parsedRef.parsed.scheme, 'gcp-secret://');
    assert.equal(parsedRef.parsed.tenantId, 'workweargroup');
    assert.equal(parsedRef.parsed.environmentId, 'production');
    assert.equal(parsedRef.parsed.secretKey, 'wwg-lead-key');

    // Strictly assert zero leaked credentials in process.env
    assertOfflineCredentialIsolation();
  });

  // -------------------------------------------------------------------------
  // Test 10: Public-Path Canary - Public API-Gateway & RuntimeController Boundary with Isolated DB
  // -------------------------------------------------------------------------
  await test('10. Public-Path Canary: Public API-Gateway & HTTP/SSE RuntimeController boundary executes multi-turn canary with isolated DB', async () => {
    const { db: isolatedDb, client: isolatedClient } = createIsolatedTestDb();

    // 1. Prepare candidate pack configured for environmentId: 'test'
    const testCandidate = createWorkwearGroupCandidate();
    testCandidate.manifest.environmentId = 'test';
    testCandidate.capabilities.toolBindings.forEach((b) => {
      b.environmentId = 'test';
    });

    // 2. Publish to isolated MongoDB (creates release, active pointer, and outbox event)
    const pubResult = await publishBusinessPack(isolatedDb, testCandidate, {
      publishedBy: 'canary-runner@journeyax.io',
      notes: 'Canary release for Workwear Group test environment',
    });
    assert.equal(pubResult.revision, 1);
    assert.ok(pubResult.checksum.length === 64);

    // 3. Real PackRepository configured with non-existent filesystem root and isolated DB
    const realPackRepo = new PackRepository('/non/existent/dev/dir', isolatedDb);

    // Verify pack loads from MongoDB business_pack_releases via active pointer
    const loadedActivePack = await realPackRepo.loadActivePack('workweargroup', 'test');
    assert.ok(loadedActivePack, 'Must load active pack from MongoDB collections');
    assert.equal(loadedActivePack.manifest.tenantId, 'workweargroup');
    assert.equal(loadedActivePack.manifest.version, '1.0.0');
    assert.equal(loadedActivePack.manifest.environmentId, 'test');

    // Prove NO filesystem fallback after activation:
    // If pointer is temporarily removed from DB, loadActivePack must fail closed (throws error)
    realPackRepo.invalidate('workweargroup');
    await isolatedDb.collection('business_pack_pointers').deleteOne({ tenantId: 'workweargroup', environmentId: 'test' });
    await assert.rejects(
      () => realPackRepo.loadActivePack('workweargroup', 'test'),
      /No published Business Pack found/,
      'Pack loading must fail closed when pointer is missing — proving zero filesystem fallback to legacy handlers'
    );
    // Restore active pointer — use field names matching publishBusinessPack output:
    // 'checksum' (not 'activeChecksum') and 'activeVersion' are required by CutoverRepository
    await isolatedDb.collection('business_pack_pointers').insertOne({
      tenantId: 'workweargroup',
      environmentId: 'test',
      activeVersion: '1.0.0',
      activeVersionId: '1.0.0',
      status: 'active',
      checksum: pubResult.checksum,
      revision: 1,
      updatedAt: new Date(),
    });
    realPackRepo.invalidate('workweargroup');
    const restoredPack = await realPackRepo.loadActivePack('workweargroup', 'test');
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
      // The CutoverGate (assertCutoverApproved) enforces this on every runTurn.
      await cutoverRepo.promoteCutover('workweargroup', 'test', {
        status: 'migrated',
        approvedReleaseVersion: '1.0.0',
        approvedReleaseChecksum: pubResult.checksum,
        expectedRevision: 0,
        approvedBy: 'spec-test-10@journeyax.io',
        notes: 'Test 10 canonical canary cutover',
      });
      const promotedCutover = await cutoverRepo.getCutoverRecord('workweargroup', 'test');
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

      const canaryWorkspaceId = `ws-wwg-canary-${Date.now()}`;
      const canarySessionId = `sess-wwg-canary-${Date.now()}`;

      // Turn 1: Public HTTP SSE endpoint POST /api/v1/workweargroup/test/runtime/chat/stream through API Gateway
      const sseResponse = await fetch(`${gatewayBaseUrl}/api/v1/workweargroup/test/runtime/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'workweargroup',
          'X-User-ID': 'canary_customer_wwg',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-01',
          correlationId: `corr-wwg-01-${Date.now()}`,
          message: 'I am an apprentice electrician looking for summer pants and composite-toe boots under $250.',
          inputFacts: {
            occupation: 'apprentice electrician',
            required_item_types: ['pants', 'boots'],
            budget: { amountCents: 25000, currency: 'AUD' },
            journeyId: 'workwear-solution',
          },
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
      rawSseText += decoder.decode(); console.log("RAW_SSE:", rawSseText);

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

      // Verify workspace state in isolated DB after Turn 1: transitioned from understand_need to build_solution
      const storedT1Workspace = await workspaceRepo.load('workweargroup', 'test', canaryWorkspaceId);
      assert.ok(storedT1Workspace, 'Workspace must be stored after Turn 1');
      assert.equal(storedT1Workspace.currentStage, 'build_solution', 'Turn 1 must transition workspace to build_solution');
      assert.equal(storedT1Workspace.facts.occupation?.value, 'apprentice electrician', 'Turn 1 must store occupation');
      const t1Transition = storedT1Workspace.decisions.find(
        (d: any) => d.type === 'transition_stage' && d.targetStage === 'build_solution'
      );
      assert.ok(t1Transition, 'Transition decision to build_solution must be recorded in workspace');

      // Turn 2: Public HTTP JSON endpoint POST /api/v1/workweargroup/test/runtime/turn through API Gateway
      const turn2Response = await fetch(`${gatewayBaseUrl}/api/v1/workweargroup/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'workweargroup',
          'X-User-ID': 'canary_customer_wwg',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-02',
          correlationId: `corr-wwg-02-${Date.now()}`,
          message: 'The recommended solution bundle looks great, please proceed.',
          inputFacts: { solution_bundle_accepted: 'true' },
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
      assert.equal(turn2Result.workspace.tenantId, 'workweargroup', 'Tenant must be preserved across gateway proxy');
      assert.equal(turn2Result.workspace.environmentId, 'test', 'Environment must be preserved across gateway proxy');
      assert.equal(turn2Result.workspace.currentStage, 'purchase', 'Turn 2 must transition to purchase');
      assert.equal(turn2Result.workspace.facts.solution_bundle_accepted?.value, 'true', 'Turn 2 must record solution_bundle_accepted fact');
      assert.equal(turn2Result.workspace.facts.occupation?.value, 'apprentice electrician', 'Turn 2 must preserve occupation fact');
      const t2Transition = turn2Result.workspace.decisions.find(
        (d: any) => d.type === 'transition_stage' && d.targetStage === 'purchase'
      );
      assert.ok(t2Transition, 'Transition decision to purchase must be recorded in workspace');

      // 7. Prove Replay Rejection through Gateway: Resending Turn 2 turnId must fail closed with HTTP 400 Bad Request (DUPLICATE_TURN)
      const replayResponse = await fetch(`${gatewayBaseUrl}/api/v1/workweargroup/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'workweargroup',
          'X-User-ID': 'canary_customer_wwg',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-02', // Duplicate turnId!
          correlationId: `corr-wwg-replay-${Date.now()}`,
          message: 'Duplicate replay attempt',
          inputFacts: { solution_bundle_accepted: 'true' },
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
        headers: { 'X-Tenant-ID': 'workweargroup' },
      });
      assert.equal(negRouteResponse.status, 404, 'Gateway must return HTTP 404 for unmapped domain route');
      const negRouteData: any = await negRouteResponse.json();
      assert.equal(negRouteData.error, 'Not Found', 'Gateway must return Not Found error payload');

      // Negative Tenant Mismatch through Gateway: cross-tenant payload rejected with HTTP 403 Forbidden
      const crossTenantGatewayResponse = await fetch(`${gatewayBaseUrl}/api/v1/workweargroup/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'workweargroup',
          'X-User-ID': 'canary_customer_wwg',
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
      const crossTenantResponse = await fetch(`${runtimeBaseUrl}/api/v1/workweargroup/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'unauthorized-cross-tenant',
        },
        body: JSON.stringify({ message: 'cross tenant probe' }),
      });
      assert.equal(crossTenantResponse.status, 403, 'Runtime boundary must reject cross-tenant header mismatch with HTTP 403');

      // 9. Prove Durable Reload: Workspace reloaded from isolated MongoDB customer_workspaces collection
      const storedWorkspace = await workspaceRepo.load('workweargroup', 'test', canaryWorkspaceId);
      assert.ok(storedWorkspace, 'Workspace must be durably reloadable from isolated DB');
      assert.equal(storedWorkspace.lastProcessedTurnId, 'turn-02');
      assert.equal(storedWorkspace.currentStage, 'purchase');
      assert.equal(storedWorkspace.facts.occupation?.value, 'apprentice electrician');
      assert.equal(storedWorkspace.facts.solution_bundle_accepted?.value, 'true');
      assert.equal(storedWorkspace.stateVersion, 3, 'Workspace stateVersion must increment to 3 after creation + 2 executed turns');

      // 10. Prove Durable Outbox Persistence: Events enqueued in isolated DB outbox_events collection
      const outboxCol = isolatedDb.collection('outbox_events');
      const outboxItems = await outboxCol.find({ tenantId: 'workweargroup', environmentId: 'test' }).toArray();
      assert.ok(outboxItems.length >= 2, 'Durable outbox events must be enqueued in isolated DB for executed turns');

      // 11. Sanitized Parity Transcript: Verify stage transitions and facts match expected baseline flow
      const stageTransitions = storedWorkspace.decisions.filter((d: any) => d.type === 'transition_stage');
      assert.equal(stageTransitions.length, 2, 'Must record exactly 2 stage transitions across the 2 turns');
      assert.equal(stageTransitions[0].targetStage, 'build_solution');
      assert.equal(stageTransitions[1].targetStage, 'purchase');

      const transcript = {
        tenantId: storedWorkspace.tenantId,
        environmentId: storedWorkspace.environmentId,
        workspaceId: storedWorkspace.workspaceId,
        journeyId: storedWorkspace.journeyId,
        finalStage: storedWorkspace.currentStage,
        turnsExecuted: 2,
        transitions: stageTransitions.map((t: any) => ({
          from: t.payload?.fromStage || t.sourceStage || 'understand_need',
          to: t.targetStage,
        })),
        confirmedFacts: Object.keys(storedWorkspace.facts),
      };
      assert.equal(transcript.finalStage, 'purchase');
      assert.deepEqual(transcript.transitions, [
        { from: 'understand_need', to: 'build_solution' },
        { from: 'build_solution', to: 'purchase' },
      ]);
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
  // Test 11: Inventory - Truthful Readiness Report Audit & Exact Blockers
  // -------------------------------------------------------------------------
  await test('11. Inventory: runTenantConnectorInventory confirms Workwear Group is discovered, schema-valid, 0 raw secrets, status BLOCKED with exact blockers', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });
    const wwgResult = results.find((r) => r.tenantId === 'workweargroup');
    assert.ok(wwgResult, 'Workwear Group must be found in inventory results');
    assert.equal(wwgResult.source, 'filesystem_pack');
    assert.equal(wwgResult.schemaValid, true);
    assert.equal(wwgResult.semanticValid, true);
    assert.equal(wwgResult.referenceIntegrityValid, true);
    assert.equal(wwgResult.rawSecretsCount, 0);
    assert.equal(wwgResult.directUrlsCount, 0);

    // Connector boundary compliance fails because crm.create_lead lacks connectionRef/secretRef
    assert.equal(wwgResult.connectorBoundaryCompliant, false, 'Connector boundary must fail because crm.create_lead lacks connectionRef');

    // Truthful reporting: in static repository state before live DB cutover, cutover record remains pending
    assert.equal(wwgResult.migrationStatus, 'BLOCKED', 'Workwear Group status must truthfully remain BLOCKED pending live cutover record');
    assert.equal(wwgResult.immutableReleaseReadiness, 'NOT_READY');
    assert.equal(wwgResult.parityResult, 'UNEVALUATED');
    assert.equal(wwgResult.cutoverRecordState, 'NO_RECORD_FOUND');
    assert.equal(wwgResult.rollbackEvidence, 'NO_ROLLBACK_BASELINE');

    // Assert exact 3 blockers
    assert.equal(wwgResult.blockers.length, 3, 'Must report exactly 3 blockers');
    assert.ok(
      wwgResult.blockers.includes('Connector boundary compliance violated'),
      'Must report Connector boundary compliance violated blocker'
    );
    assert.ok(
      wwgResult.blockers.includes('Cutover approval record missing in tenant_cutovers'),
      'Must report Cutover approval record missing blocker'
    );
    assert.ok(
      wwgResult.blockers.includes('Rollback baseline snapshot missing in business_pack_pointers or tenant_cutovers'),
      'Must report Rollback baseline snapshot missing blocker'
    );
  });

  // -------------------------------------------------------------------------
  // Test 12: Model Policy - Multi-Provider Portability & Reference Integrity
  // -------------------------------------------------------------------------
  await test('12. Model Policy: complex_reasoning has portable multi-provider candidates and runtime selection is policy-driven', async () => {
    const pack = createWorkwearGroupCandidate();
    const advisor = pack.agents.find((a) => a.agentId === 'trades_advisor');
    assert.ok(advisor, 'trades_advisor agent must exist in pack');
    assert.equal(advisor.modelPolicyRef, 'complex_reasoning');

    const complexPolicy = pack.modelPolicy.policies.find((p) => p.policyId === 'complex_reasoning');
    assert.ok(complexPolicy, 'complex_reasoning policy must exist in Workwear Group modelPolicy');

    // Candidate diversity assertion: must have at least 2 distinct providers
    assert.ok(complexPolicy.candidates.length >= 2, 'complex_reasoning must have multiple candidates');
    const providers = new Set(complexPolicy.candidates.map((c) => c.provider));
    assert.ok(providers.size >= 2, 'complex_reasoning must specify at least two distinct providers (openai and google)');
    assert.ok(providers.has('openai'), 'Must include openai candidate');
    assert.ok(providers.has('google'), 'Must include portable google candidate');
    assert.equal(complexPolicy.fallbackAllowed, true, 'fallbackAllowed must be true for complex_reasoning');

    // Test ModelRouter selection is policy-driven
    const router = new ModelRouter();

    // With preferredProvider: 'google', router must select google candidate
    const googleRoute = router.resolveModel('complex_reasoning', pack, { preferredProvider: 'google' });
    assert.equal(googleRoute.provider, 'google');
    assert.equal(googleRoute.model, 'gemini-1.5-pro');

    // With preferredProvider: 'openai', router must select openai candidate
    const openaiRoute = router.resolveModel('complex_reasoning', pack, { preferredProvider: 'openai' });
    assert.equal(openaiRoute.provider, 'openai');
    assert.equal(openaiRoute.model, 'gpt-4o');

    // Without preferredProvider, candidate 1 (openai, priority 1) is selected
    const defaultRoute = router.resolveModel('complex_reasoning', pack);
    assert.equal(defaultRoute.provider, 'openai');
    assert.equal(defaultRoute.model, 'gpt-4o');

    // Negative check: referencing non-existent policy in agent fails validation
    const badAgentPack = createWorkwearGroupCandidate();
    badAgentPack.agents[0].modelPolicyRef = 'non_existent_policy';
    const valBadAgent = validateBusinessPack(badAgentPack);
    assert.equal(valBadAgent.valid, false, 'Referencing non-existent model policy must fail validation');
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
  console.log(`Workwear Group Migration Suite Complete: ${passed} passed, ${failed} failed.`);
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
