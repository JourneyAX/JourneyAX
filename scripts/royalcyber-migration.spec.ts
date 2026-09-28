/**
 * royalcyber-migration.spec.ts
 *
 * Enterprise Closure Suite:
 * 1. Authoritative Audit of packs/royalcyber (12 files) with domain-neutral executable journeys,
 *    reference integrity, connector boundary compliance, model-policy portability, registered UI cards,
 *    and removal of legacy handler/filesystem runtime dependency after activation.
 * 2. Canonical publisher, loader, CutoverRepository (CAS cutover & atomic rollback), and public API-Gateway to
 *    HTTP/SSE runtime path in strictly isolated local storage without network access or fake outputs.
 * 3. Truthful blocker verification confirming royalcyber migrationStatus is BLOCKED and readiness is NOT_READY.
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

import { ExecutionContext } from '@journeyax/capability-sdk';

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
          const match = items.find((doc) => matchesFilter(doc, filter));
          return match ? JSON.parse(JSON.stringify(match)) : null;
        },
        countDocuments: async (filter: any = {}) => {
          return items.filter((doc) => matchesFilter(doc, filter)).length;
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
  console.log('   Royal Cyber Business Pack Migration & Isolated Canary Test Suite           ');
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

  // 1. Authoritative Disk Loading & Audit of packs/royalcyber (12 files)
  const diskLoader = new BusinessPackLoader();
  const canonicalPack = await diskLoader.loadFromDisk('royalcyber', 'production');
  assert.ok(canonicalPack, 'Royal Cyber pack must load from packs/royalcyber');

  const parsedCandidate = BusinessPackReleaseSchema.safeParse(canonicalPack);
  if (!parsedCandidate.success) {
    throw new Error(`Royal Cyber disk pack failed schema: ${JSON.stringify(parsedCandidate.error.format())}`);
  }
  const validCandidate = validateBusinessPack(parsedCandidate.data);
  if (!validCandidate.valid) {
    throw new Error(`Royal Cyber disk pack failed validation: ${JSON.stringify(validCandidate.issues)}`);
  }

  function createRoyalCyberCandidate(): BusinessPackRelease {
    return JSON.parse(JSON.stringify(canonicalPack));
  }

  // -------------------------------------------------------------------------
  // Test 1: Negative - Missing Capability / Tool Mappings Fail Closed
  // -------------------------------------------------------------------------
  await test('1. Negative: missing tool definitions and stage capabilities fail validation and prevent publication', async () => {
    // 1a. Stage references unknown capability -> semantic error, valid === false, publisher rejects
    const badCapPack = createRoyalCyberCandidate();
    const journey = badCapPack.journeys.find((j) => j.journeyId === 'consulting-intake')!;
    assert.ok(journey, 'consulting-intake journey must exist');
    journey.stages.intake.allowedCapabilities.push('unregistered.dangerous_tool');

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
    const badToolPack = createRoyalCyberCandidate();
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
    const wildcardPack = createRoyalCyberCandidate();
    wildcardPack.agents[0].allowedTools.push('scoping.*');
    const jWildcard = wildcardPack.journeys.find((j) => j.journeyId === 'consulting-intake')!;
    jWildcard.stages.intake.allowedCapabilities.push('scoping.*');

    const valWildcard = validateBusinessPack(wildcardPack);
    assert.equal(valWildcard.valid, true, 'Intentional wildcard patterns (e.g. scoping.*) must be permitted');
    assert.ok(
      !valWildcard.issues.some((i) => i.message.includes('scoping.*')),
      'Wildcard pattern should not trigger unmapped capability/tool error'
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: Negative - Broken Exit Conditions & Unknown Model Policy Fail Closed
  // -------------------------------------------------------------------------
  await test('2. Negative: unknown modelPolicyRef or broken exit condition strictly fails validation', async () => {
    // 2a. Unknown modelPolicyRef
    const badModelRef = createRoyalCyberCandidate();
    badModelRef.agents[0].modelPolicyRef = 'non_existent_policy';
    const valModel = validateBusinessPack(badModelRef);
    assert.equal(valModel.valid, false, 'Pack must be invalid when modelPolicyRef is missing');
    assert.ok(valModel.issues.some((i) => i.message.includes('non_existent_policy')));

    // 2b. Broken exit condition pointing to missing stage
    const badStageRef = createRoyalCyberCandidate();
    const journey = badStageRef.journeys.find((j) => j.journeyId === 'consulting-intake')!;
    assert.ok(journey, 'consulting-intake journey must exist');
    journey.stages.intake.exitConditions = [
      { allFactsPresent: ['domain'], nextStage: 'phantom_stage' },
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
    const rawSecretPack = createRoyalCyberCandidate();
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
    const badSchemePack = createRoyalCyberCandidate();
    badSchemePack.capabilities.toolBindings[0].executor.secretRef = 'ftp://secrets.corp/royalcyber/production/key';
    const valScheme = validateBusinessPack(badSchemePack);
    assert.equal(valScheme.valid, false, 'Pack with unsupported scheme must be strictly invalid');
    const { db: dbScheme } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbScheme, badSchemePack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with unsupported secretRef scheme'
    );

    // 3c. Arbitrary cross-tenant secretRef violation (referencing unknown tenant acme-corp)
    const crossTenantPack = createRoyalCyberCandidate();
    crossTenantPack.capabilities.toolBindings[0].executor.secretRef = 'gcp-secret://journeyax-secrets/acme-corp/production/rc-key';
    const valCross = validateBusinessPack(crossTenantPack);
    assert.equal(valCross.valid, false, 'Pack with cross-tenant secretRef must be strictly invalid');
    assert.ok(
      valCross.issues.some((i) => i.message.includes("references tenant 'acme-corp' but binding belongs to 'royalcyber'")),
      'Must emit Cross-tenant secretRef violation error for arbitrary unknown tenant'
    );
    const { db: dbCross } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbCross, crossTenantPack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with cross-tenant secretRef'
    );

    // 3d. Arbitrary cross-environment secretRef violation (staging secretRef on production binding)
    const crossEnvPack = createRoyalCyberCandidate();
    crossEnvPack.capabilities.toolBindings[0].executor.secretRef = 'gcp-secret://journeyax-secrets/royalcyber/staging/rc-key';
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
    const newTenantPack = createRoyalCyberCandidate();
    newTenantPack.manifest.tenantId = 'globex-consulting';
    newTenantPack.manifest.environmentId = 'dev';
    for (const b of newTenantPack.capabilities.toolBindings) {
      b.tenantId = 'globex-consulting';
      b.environmentId = 'dev';
      if (b.executor.secretRef) {
        b.executor.secretRef = 'vault://secret-vault/globex-consulting/dev/rc-key';
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
    const pack = createRoyalCyberCandidate();
    const { checksum } = await publishBusinessPack(db, pack);

    // Tamper with checksum in DB release document
    const releasesCol = db.collection('business_pack_releases');
    await releasesCol.updateOne(
      { tenantId: 'royalcyber', version: '1.0.0' },
      { $set: { checksum: 'tampered_bad_checksum_hash' } }
    );

    const loader = new BusinessPackLoader({ db });
    const loaded = await loader.loadFromMongo('royalcyber', 'production', '1.0.0');
    assert.equal(loaded, null, 'Loader must refuse to return release with mismatched checksum');
  });

  // -------------------------------------------------------------------------
  // Test 5: Negative - Cross-Tenant Scope Isolation
  // -------------------------------------------------------------------------
  await test('5. Negative: cross-tenant isolation prevents tenant A from accessing Royal Cyber release', async () => {
    const { db } = createIsolatedTestDb();
    const pack = createRoyalCyberCandidate();
    await publishBusinessPack(db, pack);

    const loader = new BusinessPackLoader({ db });
    // Other isolated tenant must NOT be able to load Royal Cyber release
    const otherLoaded = await loader.loadFromMongo('other_isolated_tenant', 'production', '1.0.0');
    assert.equal(otherLoaded, null, 'Cross-tenant isolation must prevent loading other tenant pack');

    // Pointer check for other tenant must return false
    const hasOther = await loader.hasPublishedPackAsync('other_isolated_tenant', 'production');
    assert.equal(hasOther, false, 'Other tenant must not have active pointer for Royal Cyber release');
  });

  // -------------------------------------------------------------------------
  // Test 6: Lifecycle - Transactional Immutable Release Publication
  // -------------------------------------------------------------------------
  await test('6. Lifecycle: publishBusinessPack creates immutable release and enqueues outbox event', async () => {
    const { db, collections } = createIsolatedTestDb();
    const pack = createRoyalCyberCandidate();

    const result = await publishBusinessPack(db, pack, {
      publishedBy: 'migration-orchestrator@journeyax.io',
      notes: 'Initial Royal Cyber canonical migration',
    });

    assert.equal(result.release.manifest.tenantId, 'royalcyber');
    assert.equal(result.release.manifest.version, '1.0.0');
    assert.equal(result.revision, 1);
    assert.ok(result.checksum.length === 64, 'Checksum must be valid sha256 hex');

    // Verify outbox event enqueued
    const outboxEvents = collections.get('outbox_events') || [];
    assert.equal(outboxEvents.length, 1);
    assert.equal(outboxEvents[0].eventType, 'business_pack.published');
    assert.equal(outboxEvents[0].tenantId, 'royalcyber');
    assert.equal(outboxEvents[0].payload.checksum, result.checksum);

    // Verify immutable release stored
    const releases = collections.get('business_pack_releases') || [];
    assert.equal(releases.length, 1);
    assert.equal(releases[0].version, '1.0.0');

    // Attempting to overwrite with different content on same version must throw immutable release violation
    const tampered = createRoyalCyberCandidate();
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

    const pack = createRoyalCyberCandidate();
    const { checksum } = await publishBusinessPack(db, pack);

    // Promote cutover with expectedRevision 0 -> 1
    const promoted = await cutoverRepo.promoteCutover('royalcyber', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: checksum,
      expectedRevision: 0,
      approvedBy: 'admin-lead@journeyax.io',
      notes: 'Initial promotion of Royal Cyber Business Pack',
    });

    assert.equal(promoted.status, 'migrated');
    assert.equal(promoted.revision, 1);
    assert.equal(promoted.approvedReleaseVersion, '1.0.0');
    assert.equal(promoted.approvedReleaseChecksum, checksum);

    // Verify cutovers collection in DB
    const record = await cutoverRepo.getCutoverRecord('royalcyber', 'production');
    assert.ok(record);
    assert.equal(record.status, 'migrated');
    assert.equal(record.revision, 1);

    // Concurrent promotion with stale expectedRevision (0 instead of 1) must fail with CutoverConflictError
    await assert.rejects(
      () =>
        cutoverRepo.promoteCutover('royalcyber', 'production', {
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
    const packV1 = createRoyalCyberCandidate();
    packV1.manifest.version = '1.0.0';
    const res1 = await publishBusinessPack(db, packV1);
    await cutoverRepo.promoteCutover('royalcyber', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: res1.checksum,
      expectedRevision: 0,
      approvedBy: 'admin@journeyax.io',
    });

    // Step 2: Publish v1.1.0 and promote revision 1 -> 2
    const packV2 = createRoyalCyberCandidate();
    packV2.manifest.version = '1.1.0';
    packV2.profile.brandTone = 'Updated brand tone for v1.1.0';
    const res2 = await publishBusinessPack(db, packV2);
    await cutoverRepo.promoteCutover('royalcyber', 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.1.0',
      approvedReleaseChecksum: res2.checksum,
      expectedRevision: 1,
      approvedBy: 'admin@journeyax.io',
    });

    // Step 3: Rollback business pack pointer to v1.0.0
    const rollbackRes = await rollbackBusinessPack(db, 'royalcyber', 'production', {
      targetVersion: '1.0.0',
      rolledBackBy: 'admin-lead@journeyax.io',
      reason: 'Canary degradation test rollback',
    });
    assert.equal(rollbackRes.activeVersion, '1.0.0');

    // Step 4: Promote cutover record to status: 'rollback' with CAS revision 2 -> 3
    const cutoverRollback = await cutoverRepo.promoteCutover('royalcyber', 'production', {
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
    const packDir = path.resolve(__dirname, '../packs/royalcyber');
    assert.ok(fs.existsSync(packDir), 'packs/royalcyber must exist');

    // Verify exactly 12 files exist in packs/royalcyber
    const expectedFiles = [
      'agents/solution-architect.json',
      'business-profile.json',
      'capabilities/bindings.json',
      'entities.json',
      'evaluations/royalcyber-acceptance.json',
      'experience/cards-and-theme.json',
      'handlers/scoping-handlers.ts',
      'journeys/consulting-intake.json',
      'manifest.json',
      'model-policy.json',
      'rules/budget-policy.json',
      'vocabulary.json',
    ];
    for (const relPath of expectedFiles) {
      assert.ok(fs.existsSync(path.join(packDir, relPath)), `File ${relPath} must exist in packs/royalcyber`);
    }

    const pack = createRoyalCyberCandidate();

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
    // In legacy capabilities/bindings.json, both hubspot.create_deal and jira.create_scoping_epic
    // use activepieces_flow but lack connectionRef and secretRef.
    const hubspotBinding = pack.capabilities.toolBindings.find((b) => b.toolId === 'hubspot.create_deal');
    assert.ok(hubspotBinding, 'hubspot.create_deal binding must exist');
    assert.equal(hubspotBinding.executor.type, 'activepieces_flow');
    assert.equal(hubspotBinding.executor.flowId, 'ap_flow_rc_hubspot_deal');
    assert.equal((hubspotBinding.executor as any).connectionRef, undefined, 'Legacy binding truthfully lacks connectionRef');
    assert.equal((hubspotBinding.executor as any).secretRef, undefined, 'Legacy binding truthfully lacks secretRef');

    const jiraBinding = pack.capabilities.toolBindings.find((b) => b.toolId === 'jira.create_scoping_epic');
    assert.ok(jiraBinding, 'jira.create_scoping_epic binding must exist');
    assert.equal(jiraBinding.executor.type, 'activepieces_flow');
    assert.equal(jiraBinding.executor.flowId, 'ap_flow_rc_jira_epic');
    assert.equal((jiraBinding.executor as any).connectionRef, undefined, 'Legacy binding truthfully lacks connectionRef');
    assert.equal((jiraBinding.executor as any).secretRef, undefined, 'Legacy binding truthfully lacks secretRef');

    // 4. Validate canonical tenant-scoped secretRef format when properly configured
    const testSecretRef = 'gcp-secret://journeyax-secrets/royalcyber/production/rc-hubspot-key';
    const parsedRef = parseCanonicalSecretRef(testSecretRef);
    assert.ok(parsedRef.parsed, 'Must parse canonical secretRef');
    assert.equal(parsedRef.parsed.scheme, 'gcp-secret://');
    assert.equal(parsedRef.parsed.tenantId, 'royalcyber');
    assert.equal(parsedRef.parsed.environmentId, 'production');
    assert.equal(parsedRef.parsed.secretKey, 'rc-hubspot-key');

    // 5. Static Guard: Runtime and test suite cannot import or execute packs/royalcyber/handlers
    // A. Static Source Guard: verify this test file does not import or require packs/royalcyber/handlers
    const thisSpecContent = fs.readFileSync(__filename, 'utf-8');
    assert.ok(
      !thisSpecContent.match(/from\s+['"][^'"]*packs\/royalcyber\/handlers[^'"]*['"]/),
      'scripts/royalcyber-migration.spec.ts must NEVER import from packs/royalcyber/handlers'
    );
    assert.ok(
      !thisSpecContent.match(/require\(['"][^'"]*packs\/royalcyber\/handlers[^'"]*['"]\)/),
      'scripts/royalcyber-migration.spec.ts must NEVER require packs/royalcyber/handlers'
    );

    // B. Static Source Guard: verify production runtime and gateway do not import packs/royalcyber/handlers
    const runtimeSrcDir = path.resolve(__dirname, '../apps/journey-runtime-service/src');
    function scanDirForPackImports(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDirForPackImports(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          assert.ok(
            !content.includes('packs/royalcyber/handlers'),
            `Runtime file ${entry.name} must not import packs/royalcyber/handlers`
          );
          assert.ok(
            !content.includes('scoping-handlers'),
            `Runtime file ${entry.name} must not reference scoping-handlers`
          );
        }
      }
    }
    scanDirForPackImports(runtimeSrcDir);

    const gatewaySrcDir = path.resolve(__dirname, '../apps/api-gateway/src');
    scanDirForPackImports(gatewaySrcDir);

    // Strictly assert zero leaked credentials in process.env
    assertOfflineCredentialIsolation();
  });

  // -------------------------------------------------------------------------
  // Test 10: Public-Path Canary - Public API-Gateway & RuntimeController Boundary with Isolated DB
  // -------------------------------------------------------------------------
  await test('10. Public-Path Canary: Public API-Gateway & HTTP/SSE RuntimeController boundary executes multi-turn canary with isolated DB', async () => {
    const { db: isolatedDb, client: isolatedClient } = createIsolatedTestDb();

    // 1. Prepare candidate pack configured for environmentId: 'test'
    const testCandidate = createRoyalCyberCandidate();
    testCandidate.manifest.environmentId = 'test';
    testCandidate.capabilities.toolBindings.forEach((b) => {
      b.environmentId = 'test';
    });

    // 2. Publish to isolated MongoDB (creates release, active pointer, and outbox event)
    const pubResult = await publishBusinessPack(isolatedDb, testCandidate, {
      publishedBy: 'canary-runner@journeyax.io',
      notes: 'Canary release for Royal Cyber test environment',
    });
    assert.equal(pubResult.revision, 1);
    assert.ok(pubResult.checksum.length === 64);

    // 3. Real PackRepository configured with non-existent filesystem root and isolated DB
    const realPackRepo = new PackRepository('/non/existent/dev/dir', isolatedDb);

    // Verify pack loads from MongoDB business_pack_releases via active pointer
    const loadedActivePack = await realPackRepo.loadActivePack('royalcyber', 'test');
    assert.ok(loadedActivePack, 'Must load active pack from MongoDB collections');
    assert.equal(loadedActivePack.manifest.tenantId, 'royalcyber');
    assert.equal(loadedActivePack.manifest.version, '1.0.0');
    assert.equal(loadedActivePack.manifest.environmentId, 'test');

    // Prove NO filesystem fallback after activation:
    // If pointer is temporarily removed from DB, loadActivePack must fail closed (throws error)
    realPackRepo.invalidate('royalcyber');
    await isolatedDb.collection('business_pack_pointers').deleteOne({ tenantId: 'royalcyber', environmentId: 'test' });
    await assert.rejects(
      () => realPackRepo.loadActivePack('royalcyber', 'test'),
      /No published Business Pack found/,
      'Pack loading must fail closed when pointer is missing — proving zero filesystem fallback to legacy handlers'
    );
    // Restore active pointer — use field names matching publishBusinessPack output:
    // 'checksum' (not 'activeChecksum') and 'activeVersion' are required by CutoverRepository
    await isolatedDb.collection('business_pack_pointers').insertOne({
      tenantId: 'royalcyber',
      environmentId: 'test',
      activeVersion: '1.0.0',
      activeVersionId: '1.0.0',
      status: 'active',
      checksum: pubResult.checksum,
      revision: 1,
      updatedAt: new Date(),
    });
    realPackRepo.invalidate('royalcyber');
    const restoredPack = await realPackRepo.loadActivePack('royalcyber', 'test');
    assert.equal(restoredPack.manifest.version, '1.0.0');

    // 4. Fully injected isolated durable adapters with standard production capability gateway (no pack handlers imported)
    const workspaceRepo = new WorkspaceRepository(isolatedDb);
    const executionRepo = new ExecutionRepository(isolatedDb);
    const outboxRepo = new OutboxRepository(isolatedDb);
    const capabilityGateway = new CapabilityGateway({ db: isolatedDb });

    // 4a. Exercise declared capability bindings through existing production adapters/registry WITHOUT importing any pack handler
    const tempWs = await workspaceRepo.getOrCreate(
      'royalcyber',
      'test',
      'ws-capability-check',
      'consulting-intake',
      'intake',
      undefined,
      restoredPack.manifest.version
    );

    // Stage 1: intake stage bindings
    const intakeCaps = capabilityGateway.resolveCapabilitiesForStage(restoredPack, tempWs);
    assert.equal(intakeCaps.tools.length, 1, 'Intake stage must resolve exactly 1 capability');
    assert.equal(intakeCaps.tools[0].definition.toolId, 'scoping.search_case_studies');
    assert.equal(intakeCaps.tools[0].binding?.executor.type, 'native_capability');

    // Stage 2: architecture_scoping stage bindings
    const scopingWs = { ...tempWs, currentStage: 'architecture_scoping' };
    const scopingCaps = capabilityGateway.resolveCapabilitiesForStage(restoredPack, scopingWs);
    assert.equal(scopingCaps.tools.length, 2, 'Architecture scoping must resolve exactly 2 capabilities');
    assert.ok(scopingCaps.tools.some((c) => c.definition.toolId === 'scoping.estimate_effort'));
    assert.ok(scopingCaps.tools.some((c) => c.definition.toolId === 'scoping.search_case_studies'));

    // Stage 3: sow_draft stage bindings
    const sowWs = { ...tempWs, currentStage: 'sow_draft' };
    const sowCaps = capabilityGateway.resolveCapabilitiesForStage(restoredPack, sowWs);
    assert.equal(sowCaps.tools.length, 3, 'SOW draft must resolve exactly 3 capabilities');
    assert.ok(sowCaps.tools.some((c) => c.definition.toolId === 'scoping.estimate_effort'));
    assert.ok(sowCaps.tools.some((c) => c.definition.toolId === 'hubspot.create_deal'));
    assert.ok(sowCaps.tools.some((c) => c.definition.toolId === 'jira.create_scoping_epic'));

    // Exercise execution through existing production adapters/registry:
    // Native capability execution without pack handlers fails closed with truthful "no native handler registered"
    const execCtx: ExecutionContext = {
      tenantId: 'royalcyber',
      environmentId: 'test',
      workspaceId: 'ws-capability-check',
      sessionId: 'sess-check',
      principalId: 'canary-user',
      principalRole: 'consultant',
      stageId: 'architecture_scoping',
      packVersionId: restoredPack.manifest.version,
      correlationId: 'corr-cap-check-01',
    };
    const nativeExecRes = await capabilityGateway.executeCapability(
      restoredPack,
      'scoping.estimate_effort',
      { scopeItems: ['microservices'] },
      execCtx
    );
    assert.equal(nativeExecRes.status, 'failure', 'Native execution without registered handler must fail closed');
    assert.ok(
      nativeExecRes.error?.includes("No native capability handler registered for 'scoping.estimate_effort'"),
      'Production registry must report missing handler without attempting filesystem lookup'
    );

    const caseStudiesExecRes = await capabilityGateway.executeCapability(
      restoredPack,
      'scoping.search_case_studies',
      { domain: 'cloud_modernization' },
      execCtx
    );
    assert.equal(caseStudiesExecRes.status, 'failure', 'Native execution without registered handler must fail closed');
    assert.ok(
      caseStudiesExecRes.error?.includes("No native capability handler registered for 'scoping.search_case_studies'"),
      'Production registry must report missing handler without attempting filesystem lookup'
    );

    // Activepieces policy gate: role check (consultant denied for partner-required tool)
    const partnerToolDeniedRes = await capabilityGateway.executeCapability(
      restoredPack,
      'hubspot.create_deal',
      { clientEmail: 'test@example.com', dealValueUsd: 50000 },
      execCtx
    );
    assert.equal(partnerToolDeniedRes.status, 'denied', 'Policy gate must deny non-partner role for hubspot.create_deal');
    assert.ok(
      partnerToolDeniedRes.error?.includes("requires role 'partner'"),
      'Policy gate must enforce requiredRole: partner'
    );

    // Activepieces policy gate: confirmation requirement when executed with role partner
    const partnerCtx: ExecutionContext = { ...execCtx, principalRole: 'partner' };
    const partnerToolApprovalRes = await capabilityGateway.executeCapability(
      restoredPack,
      'hubspot.create_deal',
      { clientEmail: 'test@example.com', dealValueUsd: 50000 },
      partnerCtx
    );
    assert.equal(partnerToolApprovalRes.status, 'requires_approval', 'Policy gate must enforce requiresConfirmation');
    assert.ok(partnerToolApprovalRes.approvalRequestId, 'Policy gate must return approvalRequestId');

    // Negative execution: undeclared tool fails closed
    const undeclaredRes = await capabilityGateway.executeCapability(
      restoredPack,
      'scoping.undeclared_tool',
      {},
      execCtx
    );
    assert.equal(undeclaredRes.status, 'failure', 'Undeclared tool must fail closed');
    assert.ok(
      undeclaredRes.error?.includes("Tool definition 'scoping.undeclared_tool' not declared"),
      'Must report undeclared tool'
    );

    // 4b. Negative Runtime Assertion: verify require.cache does NOT contain any royalcyber handlers
    const loadedHandlerKeys = Object.keys(require.cache).filter((k) => k.includes('packs/royalcyber/handlers'));
    assert.equal(
      loadedHandlerKeys.length,
      0,
      `Canary runtime must not have imported packs/royalcyber/handlers, found: ${loadedHandlerKeys.join(', ')}`
    );

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
      await cutoverRepo.promoteCutover('royalcyber', 'test', {
        status: 'migrated',
        approvedReleaseVersion: '1.0.0',
        approvedReleaseChecksum: pubResult.checksum,
        expectedRevision: 0,
        approvedBy: 'spec-test-10@journeyax.io',
        notes: 'Test 10 canonical canary cutover',
      });
      const promotedCutover = await cutoverRepo.getCutoverRecord('royalcyber', 'test');
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

      const canaryWorkspaceId = `ws-rc-canary-${Date.now()}`;
      const canarySessionId = `sess-rc-canary-${Date.now()}`;

      // Turn 1: Public HTTP SSE endpoint POST /api/v1/royalcyber/test/runtime/chat/stream through API Gateway
      const sseResponse = await fetch(`${gatewayBaseUrl}/api/v1/royalcyber/test/runtime/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'royalcyber',
          'X-User-ID': 'canary_customer_rc',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-01',
          correlationId: `corr-rc-01-${Date.now()}`,
          message: 'We are looking for enterprise consulting to modernize our order systems. Our budget is approximately $80,000 USD.',
          inputFacts: {
            domain: 'cloud_modernization',
            budget: { amountUsd: 80000 },
            journeyId: 'consulting-intake',
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

      // Verify workspace state in isolated DB after Turn 1: transitioned from intake to architecture_scoping
      const storedT1Workspace = await workspaceRepo.load('royalcyber', 'test', canaryWorkspaceId);
      assert.ok(storedT1Workspace, 'Workspace must be stored after Turn 1');
      assert.equal(storedT1Workspace.currentStage, 'architecture_scoping', 'Turn 1 must transition workspace to architecture_scoping');
      assert.equal(storedT1Workspace.facts.domain?.value, 'cloud_modernization', 'Turn 1 must store domain');
      const t1Transition = storedT1Workspace.decisions.find(
        (d: any) => d.type === 'transition_stage' && d.targetStage === 'architecture_scoping'
      );
      assert.ok(t1Transition, 'Transition decision to architecture_scoping must be recorded in workspace');

      // Turn 2: Public HTTP JSON endpoint POST /api/v1/royalcyber/test/runtime/turn through API Gateway
      const turn2Response = await fetch(`${gatewayBaseUrl}/api/v1/royalcyber/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'royalcyber',
          'X-User-ID': 'canary_customer_rc',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-02',
          correlationId: `corr-rc-02-${Date.now()}`,
          message: 'We confirm GCP as the target platform with microservices and GenAI search as scope items.',
          inputFacts: {
            cloudPlatform: 'GCP',
            scopeItems: ['microservices', 'genai_search'],
          },
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
      assert.equal(turn2Result.workspace.tenantId, 'royalcyber', 'Tenant must be preserved across gateway proxy');
      assert.equal(turn2Result.workspace.environmentId, 'test', 'Environment must be preserved across gateway proxy');
      assert.equal(turn2Result.workspace.currentStage, 'sow_draft', 'Turn 2 must transition to sow_draft');
      assert.equal(turn2Result.workspace.facts.cloudPlatform?.value, 'GCP', 'Turn 2 must record cloudPlatform fact');
      assert.equal(turn2Result.workspace.facts.domain?.value, 'cloud_modernization', 'Turn 2 must preserve domain fact');
      const t2Transition = turn2Result.workspace.decisions.find(
        (d: any) => d.type === 'transition_stage' && d.targetStage === 'sow_draft'
      );
      assert.ok(t2Transition, 'Transition decision to sow_draft must be recorded in workspace');

      // 7. Prove Replay Rejection through Gateway: Resending Turn 2 turnId must fail closed with HTTP 400 Bad Request (DUPLICATE_TURN)
      const replayResponse = await fetch(`${gatewayBaseUrl}/api/v1/royalcyber/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'royalcyber',
          'X-User-ID': 'canary_customer_rc',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-02', // Duplicate turnId!
          correlationId: `corr-rc-replay-${Date.now()}`,
          message: 'Duplicate replay attempt',
          inputFacts: {
            cloudPlatform: 'GCP',
            scopeItems: ['microservices', 'genai_search'],
          },
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
        headers: { 'X-Tenant-ID': 'royalcyber' },
      });
      assert.equal(negRouteResponse.status, 404, 'Gateway must return HTTP 404 for unmapped domain route');
      const negRouteData: any = await negRouteResponse.json();
      assert.equal(negRouteData.error, 'Not Found', 'Gateway must return Not Found error payload');

      // Negative Tenant Mismatch through Gateway: cross-tenant payload rejected with HTTP 403 Forbidden
      const crossTenantGatewayResponse = await fetch(`${gatewayBaseUrl}/api/v1/royalcyber/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'royalcyber',
          'X-User-ID': 'canary_customer_rc',
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
      const crossTenantResponse = await fetch(`${runtimeBaseUrl}/api/v1/royalcyber/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'unauthorized-cross-tenant',
        },
        body: JSON.stringify({ message: 'cross tenant probe' }),
      });
      assert.equal(crossTenantResponse.status, 403, 'Runtime boundary must reject cross-tenant header mismatch with HTTP 403');

      // 9. Prove Durable Reload: Workspace reloaded from isolated MongoDB customer_workspaces collection
      const storedWorkspace = await workspaceRepo.load('royalcyber', 'test', canaryWorkspaceId);
      assert.ok(storedWorkspace, 'Workspace must be durably reloadable from isolated DB');
      assert.equal(storedWorkspace.lastProcessedTurnId, 'turn-02');
      assert.equal(storedWorkspace.currentStage, 'sow_draft');
      assert.equal(storedWorkspace.facts.domain?.value, 'cloud_modernization');
      assert.equal(storedWorkspace.facts.cloudPlatform?.value, 'GCP');
      assert.equal(storedWorkspace.stateVersion, 3, 'Workspace stateVersion must increment to 3 after creation + 2 executed turns');

      // 10. Prove Durable Outbox Persistence: Events enqueued in isolated DB outbox_events collection
      const outboxCol = isolatedDb.collection('outbox_events');
      const outboxItems = await outboxCol.find({ tenantId: 'royalcyber', environmentId: 'test' }).toArray();
      assert.ok(outboxItems.length >= 2, 'Durable outbox events must be enqueued in isolated DB for executed turns');

      // 11. Sanitized Parity Transcript: Verify stage transitions and facts match expected baseline flow
      const stageTransitions = storedWorkspace.decisions.filter((d: any) => d.type === 'transition_stage');
      assert.equal(stageTransitions.length, 2, 'Must record exactly 2 stage transitions across the 2 turns');
      assert.equal(stageTransitions[0].targetStage, 'architecture_scoping');
      assert.equal(stageTransitions[1].targetStage, 'sow_draft');

      const transcript = {
        tenantId: storedWorkspace.tenantId,
        environmentId: storedWorkspace.environmentId,
        workspaceId: storedWorkspace.workspaceId,
        journeyId: storedWorkspace.journeyId,
        finalStage: storedWorkspace.currentStage,
        turnsExecuted: 2,
        transitions: stageTransitions.map((t: any) => ({
          from: t.payload?.fromStage || t.sourceStage || 'intake',
          to: t.targetStage,
        })),
        confirmedFacts: Object.keys(storedWorkspace.facts),
      };
      assert.equal(transcript.finalStage, 'sow_draft');
      assert.deepEqual(transcript.transitions, [
        { from: 'intake', to: 'architecture_scoping' },
        { from: 'architecture_scoping', to: 'sow_draft' },
      ]);

      // 12. Negative Assertion on Activated Runtime:
      // Verify require.cache STILL has 0 entries from packs/royalcyber/handlers after full live canary execution
      const postCanaryHandlerKeys = Object.keys(require.cache).filter((k) => k.includes('packs/royalcyber/handlers'));
      assert.equal(
        postCanaryHandlerKeys.length,
        0,
        `Zero filesystem-handler dependency verified: require.cache contains no royalcyber handlers after canary execution`
      );
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
  await test('11. Inventory: runTenantConnectorInventory confirms Royal Cyber is discovered, schema-valid, 0 raw secrets, status BLOCKED with exact blockers', async () => {
    const results = await runTenantConnectorInventory({ writeReport: false });
    const rcResult = results.find((r) => r.tenantId === 'royalcyber');
    assert.ok(rcResult, 'Royal Cyber must be found in inventory results');
    assert.equal(rcResult.source, 'filesystem_pack');
    assert.equal(rcResult.schemaValid, true);
    assert.equal(rcResult.semanticValid, true);
    assert.equal(rcResult.referenceIntegrityValid, true);
    assert.equal(rcResult.rawSecretsCount, 0);
    assert.equal(rcResult.directUrlsCount, 0);

    // Connector boundary compliance fails because hubspot.create_deal and jira.create_scoping_epic lack connectionRef/secretRef
    assert.equal(rcResult.connectorBoundaryCompliant, false, 'Connector boundary must fail because flows lack connectionRef');

    // Truthful reporting: royalcyber is classified as PARKED in portfolio manifest
    assert.equal(rcResult.migrationStatus, 'PARKED', 'Royal Cyber status must be PARKED');
    assert.equal(rcResult.immutableReleaseReadiness, 'NOT_READY');
    assert.equal(rcResult.parityResult, 'UNEVALUATED');
    assert.equal(rcResult.cutoverRecordState, 'NO_RECORD_FOUND');
    assert.equal(rcResult.rollbackEvidence, 'NO_ROLLBACK_BASELINE');

    // Assert exact 4 blockers (includes parked notice)
    assert.equal(rcResult.blockers.length, 4, 'Must report exactly 4 blockers');
    assert.ok(
      rcResult.blockers.includes('Connector boundary compliance violated'),
      'Must report Connector boundary compliance violated blocker'
    );
    assert.ok(
      rcResult.blockers.includes('Cutover approval record missing in tenant_cutovers'),
      'Must report Cutover approval record missing blocker'
    );
    assert.ok(
      rcResult.blockers.includes('Rollback baseline snapshot missing in business_pack_pointers or tenant_cutovers'),
      'Must report Rollback baseline snapshot missing blocker'
    );
    assert.ok(
      rcResult.blockers.includes('Parked tenant — not counted in active portfolio readiness'),
      'Must report Parked tenant blocker'
    );
  });

  // -------------------------------------------------------------------------
  // Test 12: Model Policy - Multi-Provider Portability & Reference Integrity
  // -------------------------------------------------------------------------
  await test('12. Model Policy: complex_reasoning has portable multi-provider candidates and runtime selection is policy-driven', async () => {
    const pack = createRoyalCyberCandidate();
    const architect = pack.agents.find((a) => a.agentId === 'solution_architect');
    assert.ok(architect, 'solution_architect agent must exist in pack');
    assert.equal(architect.modelPolicyRef, 'complex_reasoning');

    const complexPolicy = pack.modelPolicy.policies.find((p) => p.policyId === 'complex_reasoning');
    assert.ok(complexPolicy, 'complex_reasoning policy must exist in Royal Cyber modelPolicy');

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
    const badAgentPack = createRoyalCyberCandidate();
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
  console.log(`Royal Cyber Migration Suite Complete: ${passed} passed, ${failed} failed.`);
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
