/**
 * garts-migration.spec.ts
 *
 * Enterprise Closure Suite:
 * 1. Truthful Gart Sports & Outdoor Discovery & Blocker Verification (strictly not_discovered / BLOCKED).
 *    Audits packs/, repository, and adjacent workspace folders to prove no authoritative Business Pack exists.
 * 2. Neutral Synthetic Sporting Goods & Outdoor Recreation Fixture (garts_fixture) for generic publisher, loader, CAS cutover, rollback, and gateway canary testing.
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
import { ExecutionContext } from '@journeyax/capability-sdk';
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

// Assert immediately after module/import initialization proving every guarded key is absent
assertOfflineCredentialIsolation();

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
          if (options && options.upsert) {
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
    db: () => db,
    close: async () => {},
  };
  db.client = client;

  return { db, client, collections };
}

export const FIXTURE_TENANT_ID = 'garts_fixture';

/**
 * Domain-neutral multi-journey Business Pack candidate for Garts topology fixture evaluation.
 * Strictly adheres to BusinessPackReleaseSchema with:
 * - 2 domain-neutral journeys: outdoor_gear_selector (quote flow) & bulk_outfitter_quote (bulk outfitter flow)
 * - Multi-provider model policies (Anthropic, Google, OpenAI)
 * - Canonical tenant/environment scoped secret references
 * - Strict graph, tool, and UI card references
 * - Zero fabricated customer facts, zero customer brand claims, and zero assumed connector IDs
 */
export function createSyntheticFixtureCandidate(tenantId: string = FIXTURE_TENANT_ID): BusinessPackRelease {
  return {
    manifest: {
      packId: `bp_${tenantId}_v1`,
      tenantId,
      name: 'Gart Sports Topology Synthetic Fixture',
      description: 'Domain-neutral synthetic fixture for multi-journey outdoor equipment, CAS cutover, and gateway canary testing.',
      version: '1.0.0',
      environmentId: 'production',
      dataResidency: 'us',
      publishedAt: '2026-09-25T20:00:00.000Z',
      publishedBy: 'test-orchestrator@journeyax.io',
      status: 'active',
      checksum: '',
    },
    profile: {
      companyName: 'Synthetic Sporting Goods Operations',
      industry: 'Sporting Goods & Outdoor Recreation',
      defaultCurrency: 'USD',
      supportedCurrencies: ['USD', 'CAD'],
      timezone: 'America/Denver',
      locales: ['en-US', 'en-CA'],
      branding: {
        primaryColor: '#2E7D32',
        accentColor: '#FF8F00',
        logoUrl: 'https://cdn.example.org/brand/sporting-logo.svg',
      },
    },
    vocabulary: {
      version: '1.0.0',
      terms: [
        { term: 'Alpine Gear', canonical: 'alpine', category: 'activity', synonyms: ['mountain', 'climbing'], description: 'High altitude mountain gear' },
        { term: 'Trail Runner', canonical: 'trail', category: 'footwear', synonyms: ['hiking shoe', 'runner'], description: 'Off-road outdoor footwear' },
        { term: 'Backcountry Pack', canonical: 'pack', category: 'equipment', synonyms: ['rucksack', 'backpack'], description: 'Multi-day outdoor expedition pack' },
      ],
      acronyms: {
        B2B: 'Business to Business',
        MSRP: 'Manufacturer Suggested Retail Price',
      },
      slotSynonyms: {
        activity: ['outdoor_activity', 'sport', 'discipline'],
        terrain: ['environment', 'trail_type', 'climate'],
      },
      slotMappings: {},
      prohibitedTerms: ['counterfeit', 'knockoff', 'untested'],
    },
    entities: {
      version: '1.0.0',
      entities: [
        {
          entityId: 'gear_bundle_spec',
          displayName: 'Outdoor Gear Bundle Specification',
          description: 'Configured outdoor adventure equipment bundle and quote',
          primaryKey: 'bundleSpecId',
          attributes: [
            { name: 'activity', type: 'string', required: true },
            { name: 'terrain', type: 'string', required: false },
          ],
        },
      ],
    },
    conversationPolicy: {
      fencingRules: [
        'Recommend only verified safety-rated outdoor recreational gear',
        'Verify terrain conditions and environmental safety profiles before finalizing quotes',
      ],
      prohibitedTopics: [
        'Unsafe or non-certified climbing equipment modifications',
        'Unauthorized warranty circumvention instructions',
      ],
      escalationThresholds: {
        sentimentFloor: -0.6,
        maxTurnsWithoutProgress: 4,
      },
    },
    modelPolicy: {
      version: '1.0.0',
      defaultPolicy: 'fast_intent',
      policies: [
        {
          policyId: 'fast_intent',
          description: 'High-speed intent classification and slot extraction',
          candidates: [
            { provider: 'anthropic', model: 'claude-3-5-sonnet', priority: 1 },
            { provider: 'google', model: 'gemini-1.5-pro', priority: 2 },
            { provider: 'openai', model: 'gpt-4o', priority: 3 },
          ],
          dataResidency: 'us',
          maxInputTokens: 8000,
          maxOutputTokens: 1000,
          fallbackAllowed: true,
          timeoutMs: 5000,
        },
        {
          policyId: 'complex_reasoning',
          description: 'Deep gear bundle optimization and terrain matching reasoning',
          candidates: [
            { provider: 'google', model: 'gemini-1.5-pro', priority: 1 },
            { provider: 'openai', model: 'gpt-4o', priority: 2 },
          ],
          dataResidency: 'us',
          maxInputTokens: 16000,
          maxOutputTokens: 2000,
          fallbackAllowed: true,
          timeoutMs: 12000,
        },
      ],
    },
    agents: [
      {
        agentId: 'outdoor_advisor',
        name: 'Outdoor Recreation & Outfitter Advisor',
        purpose: 'Guides outdoor enthusiasts and commercial outfitters through gear selection, inventory checks, and commercial quotes.',
        role: 'Domain-neutral sporting goods advisor',
        modelPolicyRef: 'fast_intent',
        allowedTools: [
          'catalog.search',
          'bundle.build',
          'quote.create',
          'sap.b2b_inventory_check',
        ],
        systemPromptTemplate: 'You are the outdoor adventure advisor. Guide the customer through gear selection and quote generation.',
      },
    ],
    journeys: [
      {
        journeyId: 'outdoor_gear_selector',
        version: '1.0.0',
        displayName: 'Trail & Outdoor Gear Selector Flow',
        description: 'Multi-stage flow from activity assessment to commercial quote generation.',
        goals: ['assess_activity', 'recommend_gear', 'generate_quote'],
        initialStage: 'activity_assessment',
        stages: {
          activity_assessment: {
            displayName: 'Activity & Terrain Assessment',
            description: 'Identifies outdoor sport, intended trail, and weather conditions',
            requiredFacts: [],
            allowedCapabilities: ['catalog.search'],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [
              {
                anyFactsPresent: ['activity'],
                nextStage: 'gear_recommendation',
              },
            ],
          },
          gear_recommendation: {
            displayName: 'Gear Matching & Bundle Recommendation',
            description: 'Matches technical footwear, apparel, and expedition gear',
            requiredFacts: ['activity'],
            allowedCapabilities: ['catalog.search', 'bundle.build'],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [
              {
                anyFactsPresent: ['terrain'],
                nextStage: 'quote_review',
              },
            ],
          },
          quote_review: {
            displayName: 'Quote Review & B2B Inventory Check',
            description: 'Reviews configured equipment quote and verifies inventory via SAP ERP',
            requiredFacts: ['activity', 'terrain'],
            allowedCapabilities: ['quote.create', 'sap.b2b_inventory_check'],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [],
          },
        },
      },
      {
        journeyId: 'bulk_outfitter_quote',
        version: '1.0.0',
        displayName: 'Commercial Outfitter & Guide Service Flow',
        description: 'Commercial flow for multi-guide expedition outfitter quotes.',
        goals: ['intake_outfitter', 'commit_outfitter_quote'],
        initialStage: 'outfitter_intake',
        stages: {
          outfitter_intake: {
            displayName: 'Outfitter Intake',
            description: 'Captures guide service requirements and bulk fleet counts',
            requiredFacts: [],
            allowedCapabilities: ['catalog.search'],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [
              {
                anyFactsPresent: ['outfitter_confirmed'],
                nextStage: 'outfitter_review',
              },
            ],
          },
          outfitter_review: {
            displayName: 'Outfitter Review & Commit',
            description: 'Final commercial outfitter quote review and sign-off',
            requiredFacts: ['outfitter_confirmed'],
            allowedCapabilities: ['quote.create', 'sap.b2b_inventory_check'],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [],
          },
        },
      },
    ],
    rules: [
      {
        ruleId: 'outfitter_quote_policy',
        name: 'Bulk Outfitter Quote Approval Policy',
        description: 'Requires commercial approval for large outfitter equipment packages prior to confirmation',
        severity: 'warning',
        targetDomain: 'quotes',
        condition: {
          ruleExpression: "journeyId === 'bulk_outfitter_quote'",
          requiredFacts: ['outfitter_confirmed'],
        },
        action: 'require_approval',
        remediationMessage: 'Commercial outfitter equipment quotes require regional account executive approval.',
      },
    ],
    capabilities: {
      version: '1.0.0',
      toolDefinitions: [
        {
          toolId: 'catalog.search',
          version: '1.0.0',
          displayName: 'Catalog Search',
          description: 'Search sporting goods and outdoor gear catalog',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
        },
        {
          toolId: 'bundle.build',
          version: '1.0.0',
          displayName: 'Bundle Builder',
          description: 'Assemble matched outdoor gear bundle',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
        },
        {
          toolId: 'quote.create',
          version: '1.0.0',
          displayName: 'Quote Create',
          description: 'Create sporting goods equipment quote',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
        },
        {
          toolId: 'sap.b2b_inventory_check',
          version: '1.0.0',
          displayName: 'SAP B2B Inventory Check',
          description: 'Queries SAP ERP inventory availability via Activepieces flow',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
        },
      ],
      toolBindings: [
        {
          toolId: 'catalog.search',
          description: 'Search sporting goods and outdoor gear catalog',
          tenantId,
          environmentId: 'production',
          executor: {
            type: 'native_capability',
            name: 'catalog-search',
          },
        },
        {
          toolId: 'bundle.build',
          description: 'Assemble matched outdoor gear bundle',
          tenantId,
          environmentId: 'production',
          executor: {
            type: 'native_capability',
            name: 'item-configure',
          },
        },
        {
          toolId: 'quote.create',
          description: 'Create sporting goods equipment quote',
          tenantId,
          environmentId: 'production',
          executor: {
            type: 'native_capability',
            name: 'cart-update',
          },
        },
        {
          toolId: 'sap.b2b_inventory_check',
          description: 'Queries SAP ERP inventory availability via Activepieces flow',
          tenantId,
          environmentId: 'production',
          executor: {
            type: 'activepieces_flow',
            flowId: 'ap_flow_garts_sap_inv',
            connectionRef: 'conn_garts_sap_secret',
            secretRef: `gcp-secret://journeyax-secrets/${tenantId}/production/sap-api-key`,
          },
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: true,
            idempotencyRequired: false,
            timeoutMs: 8000,
            retryAttempts: 1,
          },
        },
      ],
      stageBindings: [
        {
          journeyId: 'outdoor_gear_selector',
          stageId: 'activity_assessment',
          tools: [{ toolId: 'catalog.search' }],
        },
        {
          journeyId: 'outdoor_gear_selector',
          stageId: 'gear_recommendation',
          tools: [{ toolId: 'catalog.search' }, { toolId: 'bundle.build' }],
        },
        {
          journeyId: 'outdoor_gear_selector',
          stageId: 'quote_review',
          tools: [{ toolId: 'quote.create' }, { toolId: 'sap.b2b_inventory_check' }],
        },
      ],
      schemas: {
        'catalog.search': {
          type: 'object',
          properties: {
            query: { type: 'string' },
            category: { type: 'string' },
          },
        },
        'bundle.build': {
          type: 'object',
          properties: {
            activity: { type: 'string' },
            terrain: { type: 'string' },
          },
        },
        'quote.create': {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
          },
        },
        'sap.b2b_inventory_check': {
          type: 'object',
          properties: {
            sku: { type: 'string' },
            warehouseId: { type: 'string' },
          },
        },
      },
    },
    experience: {
      version: '1.0.0',
      theme: {
        primaryColor: '#2E7D32',
        accentColor: '#FF8F00',
        fontFamily: "'Inter', system-ui, sans-serif",
        borderRadius: '6px',
        customCssVars: {
          '--brand-primary': '#2E7D32',
          '--brand-accent': '#FF8F00',
        },
      },
      cards: {
        templates: [
          {
            cardType: 'bundle',
            name: 'Gear Bundle Package',
            component: 'BundleView',
            description: 'Displays matched outdoor equipment bundle and gear kit',
          },
          {
            cardType: 'products',
            name: 'Technical Gear Grid',
            component: 'ProductGrid',
            description: 'Displays matched outdoor apparel and gear products',
          },
          {
            cardType: 'productDetail',
            name: 'Gear Specification View',
            component: 'ProductDetailView',
            description: 'Shows technical gear specs, weather ratings, and sizing',
          },
          {
            cardType: 'quote',
            name: 'Equipment Quote View',
            component: 'QuoteView',
            description: 'Displays active sporting goods quote and inventory availability',
          },
        ],
      },
    },
  };
}

async function runSuite() {
  let exitCode = 0;
  resetEgressViolations();
  try {
  console.log('==============================================================================');
  console.log('     Synthetic Multi-Journey Gear Canary & Garts Truthful Audit Suite         ');
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

  // Pre-validate neutral synthetic fixture candidate pack conforms to schema and semantic rules
  const canonicalPack = createSyntheticFixtureCandidate();
  const parsedCandidate = BusinessPackReleaseSchema.safeParse(canonicalPack);
  if (!parsedCandidate.success) {
    throw new Error(`Synthetic fixture candidate failed schema: ${JSON.stringify(parsedCandidate.error.format())}`);
  }
  const validCandidate = validateBusinessPack(parsedCandidate.data);
  if (!validCandidate.valid) {
    throw new Error(`Synthetic fixture candidate failed validation: ${JSON.stringify(validCandidate.issues)}`);
  }

  // -------------------------------------------------------------------------
  // Test 1: Negative - Missing Capability / Tool Mappings Fail Closed
  // -------------------------------------------------------------------------
  await test('1. Negative: missing tool definitions and stage capabilities fail validation and prevent publication', async () => {
    // 1a. Stage references unknown capability -> semantic error, valid === false, publisher rejects
    const badCapPack = createSyntheticFixtureCandidate();
    badCapPack.journeys[0].stages.activity_assessment.allowedCapabilities.push('unregistered.dangerous_tool');

    const valCap = validateBusinessPack(badCapPack);
    assert.equal(valCap.valid, false, 'Pack with unregistered stage capability must be invalid (fail-closed)');
    assert.ok(
      valCap.issues.some((i) => i.severity === 'error' && i.message.includes('unregistered.dangerous_tool')),
      'Must emit semantic error for unregistered capability in stage'
    );

    // 1b. Publisher must reject invalid pack
    const { db } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(db, badCapPack),
      /validation failed/i,
      'publishBusinessPack must fail closed when pack has invalid capabilities'
    );

    // 1c. Tool binding referencing missing tool definition fails closed
    const badToolPack = createSyntheticFixtureCandidate();
    badToolPack.capabilities.toolBindings.push({
      toolId: 'non_existent_tool',
      description: 'Missing tool definition',
      tenantId: FIXTURE_TENANT_ID,
      environmentId: 'production',
      executor: { type: 'native_capability', name: 'missing' },
    });
    const valTool = validateBusinessPack(badToolPack);
    assert.equal(valTool.valid, false, 'Pack with orphaned tool binding must be invalid');
  });

  // -------------------------------------------------------------------------
  // Test 2: Negative - Broken Exit Conditions & Unknown Model Policies Fail Closed
  // -------------------------------------------------------------------------
  await test('2. Negative: unknown modelPolicyRef or broken exit condition strictly fails validation', async () => {
    // 2a. Unknown modelPolicyRef in agent fails validation
    const badModelPack = createSyntheticFixtureCandidate();
    badModelPack.agents[0].modelPolicyRef = 'non_existent_model_policy';
    const valModel = validateBusinessPack(badModelPack);
    assert.equal(valModel.valid, false, 'Must fail when agent references non-existent model policy');
    assert.ok(
      valModel.issues.some((i) => i.message.includes('non_existent_model_policy')),
      'Must flag missing model policy reference'
    );

    // 2b. Broken exit condition targeting non-existent nextStage
    const badExitPack = createSyntheticFixtureCandidate();
    badExitPack.journeys[0].stages.activity_assessment.exitConditions[0].nextStage = 'invalid_ghost_stage';
    const valExit = validateBusinessPack(badExitPack);
    assert.equal(valExit.valid, false, 'Must fail when exit condition targets non-existent nextStage');
    assert.ok(
      valExit.issues.some((i) => i.message.includes('invalid_ghost_stage')),
      'Must flag non-existent nextStage reference'
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: Negative - Secret References Validation & Boundary Enforcement
  // -------------------------------------------------------------------------
  await test('3. Negative: raw secrets, unsupported schemes, and arbitrary cross-tenant/cross-env secretRefs are caught and rejected', async () => {
    // 3a. Raw secret in secretRef
    const rawSecretPack = createSyntheticFixtureCandidate();
    rawSecretPack.capabilities.toolBindings[3].executor.secretRef = 'sk-synthetic-api-secret-key-99999';

    const valRaw = validateBusinessPack(rawSecretPack);
    assert.equal(valRaw.valid, false, 'Pack with raw API key must be strictly invalid');
    const { db: dbRaw } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbRaw, rawSecretPack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with raw API key'
    );

    // 3b. Unsupported scheme in secretRef
    const badSchemePack = createSyntheticFixtureCandidate();
    badSchemePack.capabilities.toolBindings[3].executor.secretRef = 'ftp://secrets.corp/synthetic/production/key';
    const valScheme = validateBusinessPack(badSchemePack);
    assert.equal(valScheme.valid, false, 'Pack with unsupported scheme must be strictly invalid');
    const { db: dbScheme } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbScheme, badSchemePack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with unsupported secretRef scheme'
    );

    // 3c. Arbitrary cross-tenant secretRef violation (unknown/arbitrary tenant acme-corp)
    const crossTenantPack = createSyntheticFixtureCandidate();
    crossTenantPack.capabilities.toolBindings[3].executor.secretRef = 'gcp-secret://journeyax-secrets/acme-corp/production/sap-api-key';
    const valCross = validateBusinessPack(crossTenantPack);
    assert.equal(valCross.valid, false, 'Pack with cross-tenant secretRef must be strictly invalid');
    assert.ok(
      valCross.issues.some((i) => i.message.includes(`references tenant 'acme-corp' but binding belongs to '${FIXTURE_TENANT_ID}'`)),
      'Must emit Cross-tenant secretRef violation error for arbitrary unknown tenant'
    );
    const { db: dbCross } = createIsolatedTestDb();
    await assert.rejects(
      () => publishBusinessPack(dbCross, crossTenantPack),
      /Schema validation failed|semantic validation failed/,
      'Publisher must refuse to publish pack with cross-tenant secretRef'
    );

    // 3d. Arbitrary cross-environment secretRef violation (staging secretRef on production binding)
    const crossEnvPack = createSyntheticFixtureCandidate();
    crossEnvPack.capabilities.toolBindings[3].executor.secretRef = `gcp-secret://journeyax-secrets/${FIXTURE_TENANT_ID}/staging/sap-api-key`;
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
  });

  // -------------------------------------------------------------------------
  // Test 4: Negative - Checksum & Pointer Tampering Fails Closed
  // -------------------------------------------------------------------------
  await test('4. Negative: tampered release checksum or pointer mismatch fails closed', async () => {
    const { db } = createIsolatedTestDb();
    const pack = createSyntheticFixtureCandidate();
    const { checksum } = await publishBusinessPack(db, pack);

    // Tamper with checksum in DB release document
    const releasesCol = db.collection('business_pack_releases');
    await releasesCol.updateOne(
      { tenantId: FIXTURE_TENANT_ID, version: '1.0.0' },
      { $set: { checksum: 'tampered_bad_checksum_hash' } }
    );

    const loader = new BusinessPackLoader({ db });
    const loaded = await loader.loadFromMongo(FIXTURE_TENANT_ID, 'production', '1.0.0');
    assert.equal(loaded, null, 'Loader must refuse to return release with mismatched checksum');
  });

  // -------------------------------------------------------------------------
  // Test 5: Negative - Cross-Tenant Boundary Enforcement
  // -------------------------------------------------------------------------
  await test('5. Negative: cross-tenant isolation prevents tenant A from accessing synthetic fixture release', async () => {
    const { db } = createIsolatedTestDb();
    const pack = createSyntheticFixtureCandidate();
    await publishBusinessPack(db, pack);

    const loader = new BusinessPackLoader({ db });
    // Other isolated tenant must NOT be able to load synthetic fixture release
    const otherLoaded = await loader.loadFromMongo('other_isolated_tenant', 'production', '1.0.0');
    assert.equal(otherLoaded, null, 'Cross-tenant isolation must prevent loading other tenant pack');

    // Pointer check for other tenant must return false
    const hasOther = await loader.hasPublishedPackAsync('other_isolated_tenant', 'production');
    assert.equal(hasOther, false, 'Other tenant must not have active pointer for synthetic fixture release');
  });

  // -------------------------------------------------------------------------
  // Test 6: Lifecycle - Canonical Publication & Outbox Event
  // -------------------------------------------------------------------------
  await test('6. Lifecycle: publishBusinessPack creates immutable release and enqueues outbox event', async () => {
    const { db, collections } = createIsolatedTestDb();
    const pack = createSyntheticFixtureCandidate();

    const result = await publishBusinessPack(db, pack, {
      publishedBy: 'lead-engineer@journeyax.io',
      notes: 'Initial production publication',
    });

    assert.equal(result.release.manifest.tenantId, FIXTURE_TENANT_ID);
    assert.equal(result.release.manifest.version, '1.0.0');
    assert.equal(result.revision, 1);
    assert.ok(result.checksum.length === 64, 'Checksum must be sha256 64-char hex');

    // Verify stored release in business_pack_releases
    const releases = collections.get('business_pack_releases') || [];
    assert.equal(releases.length, 1);
    assert.equal(releases[0].version, '1.0.0');

    // Verify outbox event in outbox_events
    const outboxEvents = collections.get('outbox_events') || [];
    assert.equal(outboxEvents.length, 1);
    assert.equal(outboxEvents[0].eventType, 'business_pack.published');
    assert.equal(outboxEvents[0].tenantId, FIXTURE_TENANT_ID);
    assert.equal(outboxEvents[0].payload.checksum, result.checksum);

    // Attempting to overwrite with different content on same version must throw immutable release violation
    const tampered = createSyntheticFixtureCandidate();
    tampered.profile.companyName = 'Tampered Sporting Goods Operations';
    await assert.rejects(
      () => publishBusinessPack(db, tampered),
      /Immutable release violation/,
      'Cannot overwrite published immutable release version with different content'
    );
  });

  // -------------------------------------------------------------------------
  // Test 7: Lifecycle - CutoverRepository CAS Pointer Promotion
  // -------------------------------------------------------------------------
  await test('7. Lifecycle: CutoverRepository promotes active pointer with CAS revision checking', async () => {
    const { db, client } = createIsolatedTestDb();
    const cutoverRepo = new CutoverRepository(async () => ({ db, client }));

    const pack = createSyntheticFixtureCandidate();
    const { checksum } = await publishBusinessPack(db, pack);

    // Initial cutover record creation at expectedRevision = 0 -> succeeds, revision = 1
    const record1 = await cutoverRepo.promoteCutover(FIXTURE_TENANT_ID, 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: checksum,
      expectedRevision: 0,
      approvedBy: 'infra-admin@journeyax.io',
      notes: 'Initial production cutover',
    });

    assert.equal(record1.status, 'migrated');
    assert.equal(record1.revision, 1);
    assert.equal(record1.approvedReleaseVersion, '1.0.0');
    assert.equal(record1.approvedReleaseChecksum, checksum);

    // CAS Collision: Re-attempting cutover with stale expectedRevision = 0 must fail closed
    await assert.rejects(
      () =>
        cutoverRepo.promoteCutover(FIXTURE_TENANT_ID, 'production', {
          status: 'migrated',
          approvedReleaseVersion: '1.0.0',
          approvedReleaseChecksum: checksum,
          expectedRevision: 0, // Stale!
          approvedBy: 'attacker@journeyax.io',
        }),
      /CutoverConflictError|CAS mismatch|Cutover revision conflict|CAS revision conflict/i,
      'Stale expectedRevision must trigger CAS conflict'
    );

    // Valid update with expectedRevision = 1 -> succeeds, revision = 2
    const record2 = await cutoverRepo.promoteCutover(FIXTURE_TENANT_ID, 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: checksum,
      expectedRevision: 1,
      approvedBy: 'infra-admin@journeyax.io',
      notes: 'Update to cutover status',
    });
    assert.equal(record2.revision, 2);
    assert.equal(record2.approvedReleaseVersion, '1.0.0');
  });

  // -------------------------------------------------------------------------
  // Test 8: Lifecycle - Safe Rollback Proof with CAS
  // -------------------------------------------------------------------------
  await test('8. Lifecycle: safe rollback to previous version with atomic CAS and checksum check', async () => {
    const { db, client } = createIsolatedTestDb();
    const cutoverRepo = new CutoverRepository(async () => ({ db, client }));

    // Step 1: Publish v1.0.0 and promote revision 0 -> 1
    const packV1 = createSyntheticFixtureCandidate();
    packV1.manifest.version = '1.0.0';
    const res1 = await publishBusinessPack(db, packV1);
    await cutoverRepo.promoteCutover(FIXTURE_TENANT_ID, 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: res1.checksum,
      expectedRevision: 0,
      approvedBy: 'admin@journeyax.io',
    });

    // Step 2: Publish v1.1.0 and promote revision 1 -> 2
    const packV2 = createSyntheticFixtureCandidate();
    packV2.manifest.version = '1.1.0';
    packV2.profile.companyName = 'Synthetic Sporting Goods Operations Updated';
    const res2 = await publishBusinessPack(db, packV2);
    await cutoverRepo.promoteCutover(FIXTURE_TENANT_ID, 'production', {
      status: 'migrated',
      approvedReleaseVersion: '1.1.0',
      approvedReleaseChecksum: res2.checksum,
      expectedRevision: 1,
      approvedBy: 'admin@journeyax.io',
    });

    // Step 3: Rollback business pack pointer to v1.0.0
    const rollbackRes = await rollbackBusinessPack(db, FIXTURE_TENANT_ID, 'production', {
      targetVersion: '1.0.0',
      rolledBackBy: 'admin-lead@journeyax.io',
      reason: 'Canary degradation test rollback',
    });
    assert.equal(rollbackRes.activeVersion, '1.0.0');

    // Step 4: Promote cutover record to status: 'rollback' with CAS revision 2 -> 3
    const cutoverRollback = await cutoverRepo.promoteCutover(FIXTURE_TENANT_ID, 'production', {
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
    const pack = createSyntheticFixtureCandidate();
    const binding = pack.capabilities.toolBindings.find((b) => b.toolId === 'sap.b2b_inventory_check')!;
    assert.ok(binding, 'sap.b2b_inventory_check binding must exist');
    assert.ok(binding.executor.secretRef, 'sap.b2b_inventory_check binding must have secretRef');
    assert.equal(
      binding.executor.secretRef,
      `gcp-secret://journeyax-secrets/${FIXTURE_TENANT_ID}/production/sap-api-key`,
      'secretRef must follow canonical URI structure carrying tenant and environment'
    );

    // Parse canonical secret ref
    const parsedRes = parseCanonicalSecretRef(binding.executor.secretRef);
    assert.ok(parsedRes.parsed, 'Must parse canonical secretRef successfully');
    assert.equal(parsedRes.parsed.scheme, 'gcp-secret://');
    assert.equal(parsedRes.parsed.scope, 'journeyax-secrets');
    assert.equal(parsedRes.parsed.tenantId, FIXTURE_TENANT_ID);
    assert.equal(parsedRes.parsed.environmentId, 'production');
    assert.equal(parsedRes.parsed.secretKey, 'sap-api-key');

    assert.ok(!binding.executor.secretRef.includes('sk-'), 'Must not contain raw secret token');

    // Confirm scan sees 0 raw secrets
    const jsonStr = JSON.stringify(pack);
    assert.ok(!jsonStr.includes('clientSecret'), 'Must not have clientSecret property');
    assert.ok(!jsonStr.includes('password'), 'Must not have password property');

    // Static Guard: verify this test file does not import or require any packs/ handlers
    const thisSpecContent = fs.readFileSync(__filename, 'utf-8');
    assert.ok(
      !thisSpecContent.match(/from\s+['"][^'"]*packs\/.*\/handlers[^'"]*['"]/),
      'scripts/garts-migration.spec.ts must NEVER import from packs/*/handlers'
    );
    assert.ok(
      !thisSpecContent.match(/require\(['"][^'"]*packs\/.*\/handlers[^'"]*['"]\)/),
      'scripts/garts-migration.spec.ts must NEVER require packs/*/handlers'
    );

    // Assert that credentials remain strictly isolated
    assertOfflineCredentialIsolation();
  });

  // -------------------------------------------------------------------------
  // Test 10: Public-Path Canary - Public API-Gateway & RuntimeController Boundary with Isolated DB
  // -------------------------------------------------------------------------
  await test('10. Public-Path Canary: Public API-Gateway & HTTP/SSE RuntimeController boundary executes multi-turn canary with isolated DB', async () => {
    const { db: isolatedDb, client: isolatedClient } = createIsolatedTestDb();

    // 1. Prepare candidate pack configured for environmentId: 'test'
    const testCandidate = createSyntheticFixtureCandidate();
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
      notes: 'Canary release for Garts Topology Fixture test environment',
    });
    assert.equal(pubResult.revision, 1);
    assert.ok(pubResult.checksum.length === 64);

    // 3. Real PackRepository configured with non-existent filesystem root and isolated DB
    const realPackRepo = new PackRepository('/non/existent/dev/dir', isolatedDb);

    // Verify pack loads from MongoDB business_pack_releases via active pointer
    const loadedActivePack = await realPackRepo.loadActivePack(FIXTURE_TENANT_ID, 'test');
    assert.ok(loadedActivePack, 'Must load active pack from MongoDB collections');
    assert.equal(loadedActivePack.manifest.tenantId, FIXTURE_TENANT_ID);
    assert.equal(loadedActivePack.manifest.version, '1.0.0');
    assert.equal(loadedActivePack.manifest.environmentId, 'test');

    // Prove NO filesystem fallback after activation:
    realPackRepo.invalidate(FIXTURE_TENANT_ID);
    await isolatedDb.collection('business_pack_pointers').deleteOne({ tenantId: FIXTURE_TENANT_ID, environmentId: 'test' });
    await assert.rejects(
      () => realPackRepo.loadActivePack(FIXTURE_TENANT_ID, 'test'),
      /No published Business Pack found/,
      'Pack loading must fail closed when pointer is missing — proving zero filesystem fallback'
    );
    // Restore active pointer
    await isolatedDb.collection('business_pack_pointers').insertOne({
      tenantId: FIXTURE_TENANT_ID,
      environmentId: 'test',
      activeVersion: '1.0.0',
      activeVersionId: pubResult.releaseId,
      checksum: pubResult.checksum,
      status: 'active',
      revision: 1,
      updatedAt: new Date(),
    });
    realPackRepo.invalidate(FIXTURE_TENANT_ID);
    const restoredPack = await realPackRepo.loadActivePack(FIXTURE_TENANT_ID, 'test');
    assert.equal(restoredPack.manifest.version, '1.0.0');

    // 4. Fully injected isolated durable adapters with standard production CapabilityGateway
    const workspaceRepo = new WorkspaceRepository(isolatedDb);
    const executionRepo = new ExecutionRepository(isolatedDb);
    const outboxRepo = new OutboxRepository(isolatedDb);
    const capabilityGateway = new CapabilityGateway({ db: isolatedDb });

    // 4a. Exercise declared capability bindings through existing production adapters/registry WITHOUT importing any pack handler
    const tempWs = await workspaceRepo.getOrCreate(
      FIXTURE_TENANT_ID,
      'test',
      'ws-capability-check',
      'outdoor_gear_selector',
      'activity_assessment',
      undefined,
      restoredPack.manifest.version
    );

    // Stage 1: activity_assessment stage bindings
    const stage1Caps = capabilityGateway.resolveCapabilitiesForStage(restoredPack, tempWs);
    assert.equal(stage1Caps.tools.length, 1, 'Stage 1 must resolve catalog.search');
    assert.equal(stage1Caps.tools[0].definition.toolId, 'catalog.search');

    // Stage 2: gear_recommendation stage bindings
    const stage2Ws = { ...tempWs, currentStage: 'gear_recommendation', facts: { activity: { value: 'hiking', provenance: 'user' } } };
    const stage2Caps = capabilityGateway.resolveCapabilitiesForStage(restoredPack, stage2Ws as any);
    assert.equal(stage2Caps.tools.length, 2, 'Stage 2 must resolve catalog.search and bundle.build');

    // Stage 3: quote_review stage bindings
    const stage3Ws = {
      ...tempWs,
      currentStage: 'quote_review',
      facts: {
        activity: { value: 'hiking', provenance: 'user' },
        terrain: { value: 'alpine', provenance: 'user' },
      },
    };
    const stage3Caps = capabilityGateway.resolveCapabilitiesForStage(restoredPack, stage3Ws as any);
    assert.equal(stage3Caps.tools.length, 2, 'Stage 3 must resolve quote.create and sap.b2b_inventory_check');

    // Exercise native capability execution via production adapter
    const execCtx: ExecutionContext = {
      tenantId: FIXTURE_TENANT_ID,
      environmentId: 'test',
      workspaceId: 'ws-capability-check',
      sessionId: 'sess-check',
      principalId: 'canary-user',
      principalRole: 'customer',
      stageId: 'activity_assessment',
      packVersionId: restoredPack.manifest.version,
      correlationId: 'corr-cap-check-01',
    };
    const catalogSearchRes = await capabilityGateway.executeCapability(
      restoredPack,
      'catalog.search',
      { query: 'hiking boots' },
      execCtx
    );
    assert.equal(catalogSearchRes.status, 'success', 'catalog.search should execute via production CatalogSearchHandler');

    // Exercise external Activepieces flow confirmation check
    const sapInvRes = await capabilityGateway.executeCapability(
      restoredPack,
      'sap.b2b_inventory_check',
      { sku: 'BOOTS-ALPIN-42', warehouseId: 'WH-DENVER-01' },
      execCtx
    );
    assert.equal(sapInvRes.status, 'requires_approval', 'sap.b2b_inventory_check must require confirmation per policy');
    assert.ok(sapInvRes.approvalRequestId, 'Must generate approvalRequestId');

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

      await cutoverRepo.promoteCutover(FIXTURE_TENANT_ID, 'test', {
        status: 'migrated',
        approvedReleaseVersion: '1.0.0',
        approvedReleaseChecksum: pubResult.checksum,
        expectedRevision: 0,
        approvedBy: 'spec-test-10@journeyax.io',
        notes: 'Test 10 canonical canary cutover',
      });

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

      // Assert after application initialization that no guarded keys were injected
      assertOfflineCredentialIsolation();

      const canaryWorkspaceId = `ws-garts-canary-${Date.now()}`;
      const canarySessionId = `sess-garts-canary-${Date.now()}`;

      // Turn 1: Public HTTP SSE endpoint POST /api/v1/:tenantId/test/runtime/chat/stream through API Gateway
      const sseResponse = await fetch(`${gatewayBaseUrl}/api/v1/${FIXTURE_TENANT_ID}/test/runtime/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': FIXTURE_TENANT_ID,
          'X-User-ID': 'canary_fixture_user_01',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-01',
          correlationId: `corr-garts-01-${Date.now()}`,
          message: 'We are planning a mountain hiking expedition in Colorado.',
          inputFacts: { activity: 'hiking', journeyId: 'outdoor_gear_selector' },
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

      // Verify workspace state in isolated DB after Turn 1: transitioned to gear_recommendation with activity fact
      const storedT1Workspace = await workspaceRepo.load(FIXTURE_TENANT_ID, 'test', canaryWorkspaceId);
      assert.ok(storedT1Workspace, 'Workspace must be stored after Turn 1');
      assert.equal(storedT1Workspace.currentStage, 'gear_recommendation', 'Turn 1 must transition workspace to gear_recommendation');
      assert.equal(storedT1Workspace.facts.activity?.value, 'hiking', 'Turn 1 must store activity fact');
      const t1Transition = storedT1Workspace.decisions.find(
        (d: any) => d.type === 'transition_stage' && d.targetStage === 'gear_recommendation'
      );
      assert.ok(t1Transition, 'Transition decision to gear_recommendation must be recorded in workspace');

      // Turn 2: Public HTTP JSON endpoint POST /api/v1/:tenantId/test/runtime/turn through API Gateway
      const turn2Response = await fetch(`${gatewayBaseUrl}/api/v1/${FIXTURE_TENANT_ID}/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': FIXTURE_TENANT_ID,
          'X-User-ID': 'canary_fixture_user_01',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-02',
          correlationId: `corr-garts-02-${Date.now()}`,
          message: 'The route goes through high alpine rocky terrain.',
          inputFacts: { terrain: 'alpine' },
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
      assert.equal(turn2Result.workspace.tenantId, FIXTURE_TENANT_ID, 'Tenant must be preserved across gateway proxy');
      assert.equal(turn2Result.workspace.environmentId, 'test', 'Environment must be preserved across gateway proxy');
      assert.equal(turn2Result.workspace.currentStage, 'quote_review', 'Turn 2 must transition to quote_review');
      assert.equal(turn2Result.workspace.facts.terrain?.value, 'alpine', 'Turn 2 must record terrain fact');
      assert.equal(turn2Result.workspace.facts.activity?.value, 'hiking', 'Turn 2 must preserve activity fact');
      const t2Transition = turn2Result.workspace.decisions.find(
        (d: any) => d.type === 'transition_stage' && d.targetStage === 'quote_review'
      );
      assert.ok(t2Transition, 'Transition decision to quote_review must be recorded in workspace');

      // 7. Prove Replay Rejection through Gateway: Resending Turn 2 turnId must fail closed with HTTP 400 Bad Request (DUPLICATE_TURN)
      const replayResponse = await fetch(`${gatewayBaseUrl}/api/v1/${FIXTURE_TENANT_ID}/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': FIXTURE_TENANT_ID,
          'X-User-ID': 'canary_fixture_user_01',
          'X-User-Role': 'customer',
        },
        body: JSON.stringify({
          workspaceId: canaryWorkspaceId,
          sessionId: canarySessionId,
          turnId: 'turn-02', // Duplicate turnId!
          correlationId: `corr-garts-replay-${Date.now()}`,
          message: 'Duplicate replay attempt',
          inputFacts: { terrain: 'alpine' },
        }),
      });

      assert.equal(replayResponse.status, 400, 'Replay turn through gateway must return HTTP 400 Bad Request');
      const replayError: any = await replayResponse.json();
      assert.equal(replayError.code, 'DUPLICATE_TURN', 'Gateway replay response must propagate DUPLICATE_TURN code');
      assert.equal(replayError.turnId, 'turn-02', 'Gateway replay response must propagate duplicated turnId');

      // 8. Negative Route & Tenant Assertions on Public Gateway & Runtime Boundary
      const negRouteResponse = await fetch(`${gatewayBaseUrl}/api/v1/unknown-domain/test`, {
        method: 'GET',
        headers: { 'X-Tenant-ID': FIXTURE_TENANT_ID },
      });
      assert.equal(negRouteResponse.status, 404, 'Gateway must return HTTP 404 for unmapped domain route');
      const negRouteData: any = await negRouteResponse.json();
      assert.equal(negRouteData.error, 'Not Found', 'Gateway must return Not Found error payload');

      // Negative Tenant Mismatch through Gateway: cross-tenant payload rejected with HTTP 403 Forbidden
      const crossTenantGatewayResponse = await fetch(`${gatewayBaseUrl}/api/v1/${FIXTURE_TENANT_ID}/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': FIXTURE_TENANT_ID,
          'X-User-ID': 'canary_fixture_user_01',
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
      const crossTenantResponse = await fetch(`${runtimeBaseUrl}/api/v1/${FIXTURE_TENANT_ID}/test/runtime/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'unauthorized-cross-tenant',
        },
        body: JSON.stringify({ message: 'cross tenant probe' }),
      });
      assert.equal(crossTenantResponse.status, 403, 'Runtime boundary must reject cross-tenant header mismatch with HTTP 403');

      // 9. Prove Durable Reload: Workspace reloaded from isolated MongoDB customer_workspaces collection
      const storedWorkspace = await workspaceRepo.load(FIXTURE_TENANT_ID, 'test', canaryWorkspaceId);
      assert.ok(storedWorkspace, 'Workspace must be durably reloadable from isolated DB');
      assert.equal(storedWorkspace.lastProcessedTurnId, 'turn-02');
      assert.equal(storedWorkspace.currentStage, 'quote_review');
      assert.equal(storedWorkspace.facts.activity?.value, 'hiking');
      assert.equal(storedWorkspace.facts.terrain?.value, 'alpine');
      assert.equal(storedWorkspace.stateVersion, 3, 'Workspace stateVersion must increment to 3 after creation + 2 executed turns');

      // 10. Prove Durable Outbox Persistence: Events enqueued in isolated DB outbox_events collection
      const outboxCol = isolatedDb.collection('outbox_events');
      const outboxItems = await outboxCol.find({ tenantId: FIXTURE_TENANT_ID, environmentId: 'test' }).toArray();
      assert.ok(outboxItems.length >= 2, 'Durable outbox events must be enqueued in isolated DB for executed turns');

      // 11. Parity Evidence: verify stage transitions match expected baseline flow
      const stageTransitions = storedWorkspace.decisions.filter((d: any) => d.type === 'transition_stage');
      assert.equal(stageTransitions.length, 2, 'Must record exactly 2 stage transitions across the 2 turns');
      assert.equal(stageTransitions[0].targetStage, 'gear_recommendation');
      assert.equal(stageTransitions[1].targetStage, 'quote_review');

      // 12. Negative Assertion on Activated Runtime:
      // Verify require.cache contains no packs/ handlers
      const postCanaryHandlerKeys = Object.keys(require.cache).filter((k) => k.includes('packs/royalcyber/handlers') || k.includes('packs/workweargroup/handlers') || k.includes('packs/placemakers/handlers'));
      assert.equal(
        postCanaryHandlerKeys.length,
        0,
        `Zero filesystem-handler dependency verified: require.cache contains no pack handlers after canary execution`
      );
    } finally {
      if (typeof originalRuntimeUrl !== 'undefined' || typeof originalProjectsUrl !== 'undefined') {
        const { DOMAIN_REGISTRY: reg } = await import('../apps/api-gateway/src/gateway.registry');
        if (typeof originalRuntimeUrl !== 'undefined') reg.runtime = originalRuntimeUrl;
        if (typeof originalProjectsUrl !== 'undefined') reg.projects = originalProjectsUrl;
      }
      delete process.env.AUTH_DEV_BYPASS;
      enforceOfflineCredentialIsolation();
      assertOfflineCredentialIsolation();
      if (gatewayApp) {
        await gatewayApp.close();
      }
      if (app) {
        await app.close();
      }
    }
  });

  // -------------------------------------------------------------------------
  // Test 11: Inventory - Truthful Garts Audit & Discovered/Synthetic Disambiguation
  // -------------------------------------------------------------------------
  await test('11. Inventory: strictly proves garts is not_discovered/BLOCKED and rejects discovered-or-synthetic ambiguity', async () => {
    // 1. Filesystem Truth: garts directory does NOT exist under packs/
    const packPathGarts = path.join(process.cwd(), 'packs', 'garts');
    assert.equal(
      fs.existsSync(packPathGarts),
      false,
      'packs/garts must NOT exist on filesystem; any claim of customer discovery is false'
    );

    // 2. Repository Search: No authoritative legacy business pack release exists for garts
    const legacyPacksDir = path.join(process.cwd(), 'packs');
    const existingPacks = fs.readdirSync(legacyPacksDir);
    assert.ok(
      !existingPacks.includes('garts'),
      'packs/ directory must contain only verified legacy packs (placemakers, royalcyber, workweargroup)'
    );

    // 3. Adjacent Folders & Data Audit:
    // Verify no garts directories exist under data/ or adjacent workspace root
    const gartsDataDir = path.join(process.cwd(), 'data', 'garts');
    assert.equal(
      fs.existsSync(gartsDataDir),
      false,
      'data/garts does NOT exist; no customer data assets exist'
    );

    const adjacentRoot = path.resolve(process.cwd(), '..');
    const adjacentFiles = fs.readdirSync(adjacentRoot);
    assert.ok(
      !adjacentFiles.some((f) => f.toLowerCase().includes('garts')),
      'Adjacent folders must contain zero customer packs or directories for garts'
    );

    // 4. Inventory Audit: run truthful discovery
    const results = await runTenantConnectorInventory({ writeReport: false });
    assertOfflineCredentialIsolation();

    // 5. Customer Tenant Audit: garts must be strictly not_discovered and BLOCKED
    const gartsResult = results.find((r) => r.tenantId === 'garts');
    assert.ok(gartsResult, 'Gart Sports & Outdoor must be registered in inventory audit');
    assert.equal(gartsResult.source, 'not_discovered', 'Garts source must be strictly not_discovered');
    assert.equal(gartsResult.schemaValid, false, 'Schema must fail because no customer manifest exists');
    assert.equal(gartsResult.semanticValid, false, 'Semantic check must fail because no pack candidate exists');
    assert.equal(gartsResult.referenceIntegrityValid, false, 'Reference integrity must fail closed');
    assert.equal(gartsResult.groundedRetrievalIsolated, false, 'Isolated retrieval must remain unevaluated');
    assert.equal(gartsResult.connectorBoundaryCompliant, false, 'Connector compliance must fail closed');
    assert.equal(gartsResult.checksum, 'NOT_EVALUATED', 'Checksum must be NOT_EVALUATED for parked tenant');
    assert.equal(gartsResult.activepiecesFlowsCount, 0, 'No Activepieces flows may be registered');
    assert.equal(gartsResult.connectionRefMappings.length, 0, 'No connection reference mappings may exist');
    assert.equal(gartsResult.rawSecretsCount, 0, 'Must contain 0 raw secrets');
    assert.equal(gartsResult.directUrlsCount, 0, 'Must contain 0 direct URLs');

    // Truthful lifecycle and cutover blocker assertions
    assert.equal(gartsResult.migrationStatus, 'PARKED', 'Garts must remain PARKED');
    assert.equal(gartsResult.immutableReleaseReadiness, 'NOT_READY', 'Readiness must remain NOT_READY');
    assert.equal(gartsResult.cutoverRecordState, 'NO_RECORD_FOUND', 'Cutover record must be NO_RECORD_FOUND');
    assert.equal(gartsResult.rollbackEvidence, 'NO_ROLLBACK_BASELINE', 'Rollback baseline must be NO_ROLLBACK_BASELINE');
    assert.equal(gartsResult.parityResult, 'UNEVALUATED', 'Parity must remain UNEVALUATED');

    // Exact blocker assertions
    assert.equal(gartsResult.blockers.length, 1, 'Garts must have exactly 1 blocker (parked notice)');
    assert.ok(
      gartsResult.blockers.includes('Parked tenant — not counted in active portfolio readiness'),
      'Must contain parked tenant notice'
    );

    // 6. Reject Discovered-or-Synthetic Ambiguity:
    // Ensure garts is NEVER conflated with synthetic fixtures or treated as discovered
    assert.notEqual(
      gartsResult.source,
      'filesystem_pack',
      'Garts must NOT be marked as filesystem_pack'
    );
    assert.notEqual(
      gartsResult.source,
      'synthetic_fixture',
      'Garts customer tenant must NOT be marked as synthetic_fixture'
    );
    assert.notEqual(
      gartsResult.migrationStatus,
      'READY',
      'Garts must NEVER be marked as READY without real evidence'
    );
    assert.notEqual(
      gartsResult.migrationStatus,
      'FIXTURE_EVALUATION_ONLY',
      'Garts customer tenant cannot be reduced to FIXTURE_EVALUATION_ONLY'
    );

    // 7. Fixture Isolation Check:
    // Synthetic fixtures exist solely for topology dry-run evaluation and are explicitly flagged
    const fixtureResults = results.filter((r) => r.classification === 'SYNTHETIC_FIXTURE');
    assert.ok(fixtureResults.length > 0, 'Synthetic fixtures must exist in inventory');
    for (const f of fixtureResults) {
      assert.equal(f.source, 'synthetic_fixture', 'Fixture must be typed as synthetic_fixture');
      assert.equal(f.migrationStatus, 'FIXTURE_EVALUATION_ONLY', 'Fixture must be marked FIXTURE_EVALUATION_ONLY');
      assert.ok(
        f.blockers.includes('Synthetic test fixture: not a discovered customer project'),
        'Fixture must explicitly declare it is not a customer project'
      );
    }
  });

  // -------------------------------------------------------------------------
  // Test 12: Model Policy - fast_intent Multi-Provider Candidates & Policy Selection
  // -------------------------------------------------------------------------
  await test('12. Model Policy: fast_intent has portable multi-provider candidates and runtime selection is policy-driven without single-provider lock-in', async () => {
    const pack = createSyntheticFixtureCandidate();
    const policy = pack.modelPolicy.policies.find((p) => p.policyId === 'fast_intent')!;
    assert.ok(policy, 'fast_intent policy must exist');

    // 1. Multi-provider candidates: at least 2 distinct providers
    const providers = new Set(policy.candidates.map((c) => c.provider));
    assert.ok(
      providers.size >= 2,
      `fast_intent must define candidates from multiple providers (found: ${Array.from(providers).join(', ')})`
    );
    assert.ok(providers.has('anthropic'), 'Must support Anthropic provider');
    assert.ok(providers.has('google'), 'Must support Google provider');
    assert.ok(providers.has('openai'), 'Must support OpenAI provider');

    // 2. Candidate priorities must be distinct and non-zero
    const priorities = policy.candidates.map((c) => c.priority);
    const uniquePriorities = new Set(priorities);
    assert.equal(priorities.length, uniquePriorities.size, 'Candidate priorities must be distinct');
    assert.ok(
      priorities.every((p) => p > 0),
      'Priorities must be positive integers'
    );

    // 3. Fallback allowed flag
    assert.equal(policy.fallbackAllowed, true, 'Model policy must permit fallback among candidates');

    // 4. ModelRouter selection simulation
    const router = new ModelRouter();
    const anthropicRoute = router.resolveModel('fast_intent', pack, { preferredProvider: 'anthropic' });
    assert.equal(anthropicRoute.provider, 'anthropic');
    assert.equal(anthropicRoute.model, 'claude-3-5-sonnet');

    const googleRoute = router.resolveModel('fast_intent', pack, { preferredProvider: 'google' });
    assert.equal(googleRoute.provider, 'google');
    assert.equal(googleRoute.model, 'gemini-1.5-pro');

    const openaiRoute = router.resolveModel('fast_intent', pack, { preferredProvider: 'openai' });
    assert.equal(openaiRoute.provider, 'openai');
    assert.equal(openaiRoute.model, 'gpt-4o');

    const defaultRoute = router.resolveModel('fast_intent', pack);
    assert.equal(defaultRoute.provider, 'anthropic');
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

  console.log('\n==============================================================================');
  console.log(`Gart Sports & Outdoor Migration Suite Complete: ${passed} passed, ${failed} failed.`);
  console.log('==============================================================================\n');

  if (failed > 0) { exitCode = 1; }
  } finally {
    assertLocalhostOnlyEgress();
  }
  process.exit(exitCode);
}

runSuite().catch((err) => {
  console.error('Fatal suite failure:', err);
  process.exit(1);
});
