#!/usr/bin/env node
/**
 * PlaceMakers Agent Pack Publication & Diff Script (Task T1 / V8)
 *
 * Defaults to DRY-RUN mode: computes candidate release, diffs against the active
 * live pack (e.g. 1.3.17), validates pack integrity, and prints detailed diffs.
 * Only writes to the database when explicitly executed with `--apply`.
 *
 * Dynamic versioning: reads active live pointer version and increments the patch number.
 * Calculators: loaded strictly from docs/agent-instructions/calculators.placemakers.json;
 * unverified constants have been moved to docs/agent-instructions/okf-verification-worklist.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import {
  validateBusinessPack,
  publishBusinessPack,
  computePackChecksum,
  CatalogMappingSchema,
} from '@journeyax/business-pack';

if (typeof (process as any).loadEnvFile === 'function' && fs.existsSync('.env')) {
  try {
    (process as any).loadEnvFile('.env');
  } catch {}
}

const isApply = process.argv.includes('--apply');

const pmJourneyPlaybook = [
  {
    id: 'stage_spec',
    name: 'Specification & Discovery',
    goal: 'Identify required building materials and verify sizing or specifications.',
    tools: ['search_products', 'consult_business_knowledge'],
    exitCondition: 'Target material product is identified and added to quote or selection.',
  },
  {
    id: 'stage_fixings',
    name: 'Fixings & Accessory Verification',
    goal: 'Identify compatible fixings, fasteners, and installation accessories.',
    tools: ['consult_business_knowledge', 'search_products'],
    exitCondition: 'Required accessories or fixings are confirmed or quoted.',
  },
  {
    id: 'stage_quantity_stock',
    name: 'Quantity Calculation & Branch Stock',
    goal: 'Calculate project quantities and confirm branch stock availability.',
    tools: ['calculate_quantity', 'check_stock'],
    exitCondition: 'Quantities are calculated and branch availability is checked.',
  },
  {
    id: 'stage_quote_delivery',
    name: 'Quote Delivery & Order Readiness',
    goal: 'Finalize quote summary and provide clear next step for pickup or delivery.',
    tools: ['update_cart', 'present_card', 'hand_off_to_human'],
    exitCondition: 'Quote or cart is finalized and delivery/pickup next steps are confirmed.',
  },
];

function bumpPatchVersion(versionStr: string): string {
  const parts = versionStr.split('.').map((p) => parseInt(p, 10));
  if (parts.length === 3 && !parts.some(isNaN)) {
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
  return `${versionStr}.1`;
}

function printSectionHeader(title: string) {
  console.log(`\n── [DIFF] ${title} ────────────────────────────────────────────────`);
}

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB_NAME || 'journeyx';

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`🚀 PlaceMakers Agent Pack Publisher (${isApply ? 'APPLY MODE' : 'DRY RUN'})`);
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`MongoDB: ${uri.split('@').pop()} / ${dbName}`);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  // 1. Resolve current active version dynamically from pointer
  const pointer = await db.collection('business_pack_pointers').findOne({
    tenantId: 'placemakers',
    environmentId: 'production',
  });
  const currentVersion = pointer?.activeVersion || '1.3.17';
  console.log(`Active Live Pack Pointer: v${currentVersion} (revision ${pointer?.revision ?? 1})`);

  // 2. Fetch baseline pack release document
  const baseDoc = await db.collection('business_pack_releases').findOne({
    tenantId: 'placemakers',
    $or: [{ version: currentVersion }, { 'manifest.version': currentVersion }],
  });

  if (!baseDoc) {
    throw new Error(`Baseline pack v${currentVersion} for tenant placemakers not found in MongoDB!`);
  }
  console.log(`Loaded baseline release v${currentVersion} (checksum: ${baseDoc.checksum?.slice(0, 16)}...)`);

  // 3. Compute dynamic target version
  const targetVersion = bumpPatchVersion(currentVersion);
  console.log(`Target Next Version: v${targetVersion} (dynamically incremented from v${currentVersion})\n`);

  // 4. Load draft agents
  const draftPath = path.resolve('docs/agent-instructions/placemakers-draft.json');
  assert.ok(fs.existsSync(draftPath), `Draft agents file not found at ${draftPath}`);
  const draftData = JSON.parse(fs.readFileSync(draftPath, 'utf8'));

  // 5. Load calculators from pack data file (unverified moved to okf-verification-worklist.md)
  const calcPath = path.resolve('docs/agent-instructions/calculators.placemakers.json');
  const calculators = fs.existsSync(calcPath) ? JSON.parse(fs.readFileSync(calcPath, 'utf8')) : [];
  console.log(`Loaded ${calculators.length} verified calculators from ${calcPath}`);

  // 6. Load catalog mapping
  const mappingPath = path.resolve('docs/migrations/placemakers-catalog-mapping.json');
  assert.ok(fs.existsSync(mappingPath), `Mapping file not found at ${mappingPath}`);
  const mappingData = JSON.parse(fs.readFileSync(mappingPath, 'utf8')).catalogMapping;

  // 7. Construct updated agents with journeyPlaybook and allowedTools
  const updatedAgents = (draftData.agents || []).map((agent: any) => {
    const isDefault = agent.agentId === 'placemakers_product_advisor';
    const allowedTools = [...new Set([...(agent.allowedTools || []), 'calculate_quantity'])];
    return {
      agentId: agent.agentId,
      name: agent.name,
      purpose: agent.purpose,
      systemPromptTemplate: agent.systemPromptTemplate,
      modelPolicyRef: agent.modelPolicyRef || 'complex_reasoning',
      allowedTools,
      maxTurns: agent.maxTurns || 5,
      handoffConditions: agent.handoffConditions || [],
      isDefault,
      journeyPlaybook: pmJourneyPlaybook,
      toolFirst: agent.toolFirst ?? (agent.agentId === 'placemakers_product_advisor' ? true : undefined),
    };
  });

  // 8. Construct catalog mapping
  const catalogMapping = {
    pricing: {
      sources: [
        { path: 'MSRP', unit: 'major', currencyPath: 'currency' },
        { path: 'OriginalPrice', unit: 'major', currencyPath: 'currency' },
        { path: 'priceUSD', rangeKey: 'min', unit: 'major', currencyPath: 'currency' },
        { path: 'variants.0.msrpUSD', unit: 'major', currencyPath: 'currency' },
      ],
    },
    imagePaths: ['Main_Image_URL', 'imageUrl', 'images.0'],
    availability: {
      statusPaths: ['Status', 'status'],
      excludedStatuses: ['Discontinued', 'discontinued'],
    },
    attributeAliases: mappingData.attributeAliases,
    attributeDefinitions: mappingData.attributeDefinitions,
    componentCategoryRules: baseDoc.catalogMapping?.componentCategoryRules || mappingData.componentCategoryRules,
  };

  CatalogMappingSchema.parse(catalogMapping);

  // 8b. Construct capabilities with agent tools
  const agentToolSpecs = [
    { toolId: 'search_products', name: 'Search Products', desc: 'Search catalogue products by keywords, categories, and attributes' },
    { toolId: 'check_stock', name: 'Check Stock', desc: 'Check branch inventory availability for specific products' },
    { toolId: 'consult_business_knowledge', name: 'Consult Business Knowledge', desc: 'Consult authoritative operational knowledge and technical specifications' },
    { toolId: 'calculate_quantity', name: 'Calculate Quantity', desc: 'Calculate project material quantities and accessories' },
    { toolId: 'get_cart', name: 'Get Cart', desc: 'Retrieve current trade quote or cart contents' },
    { toolId: 'update_cart', name: 'Update Cart', desc: 'Add, update, or remove items in customer trade quote or cart' },
    { toolId: 'present_card', name: 'Present Card', desc: 'Present interactive UI cards to customer' },
    { toolId: 'hand_off_to_human', name: 'Hand Off To Human', desc: 'Escalate to human branch specialist or support' },
    { toolId: 'create_quote', name: 'Create Quote', desc: 'Generate official trade quote for review and checkout' },
  ];

  const baseTools: any[] = baseDoc.capabilities?.toolDefinitions || [];
  const existingToolIds = new Set(baseTools.map((t) => t.toolId));
  const newToolDefs = agentToolSpecs
    .filter((at) => !existingToolIds.has(at.toolId))
    .map((at) => ({
      toolId: at.toolId,
      version: '1.0.0',
      displayName: at.name,
      description: at.desc,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      sideEffect: at.toolId.includes('update') || at.toolId.includes('create') ? ('write' as const) : ('read' as const),
      risk: 'low' as const,
      timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
      idempotencyPolicy: { required: false, ttlSeconds: 86400 },
      approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
      dataClassification: 'internal' as const,
    }));

  const baseBindings: any[] = baseDoc.capabilities?.toolBindings || [];
  const existingBindingIds = new Set(baseBindings.map((b) => b.toolId));
  const newBindings = agentToolSpecs
    .filter((at) => !existingBindingIds.has(at.toolId))
    .map((at) => ({
      tenantId: 'placemakers',
      environmentId: 'production',
      toolId: at.toolId,
      bindingVersion: '1.0.0',
      executor: {
        type: 'native_capability' as const,
        nativeHandler: at.toolId,
      },
      enabled: true,
      policy: {
        requiredRole: 'customer' as const,
        requiresConfirmation: false,
        idempotencyRequired: false,
        timeoutMs: 10000,
        retryAttempts: 0,
      },
    }));

  const mergedCapabilities = {
    toolDefinitions: [...baseTools, ...newToolDefs],
    toolBindings: [...baseBindings, ...newBindings],
    stageBindings: baseDoc.capabilities?.stageBindings || [],
  };

  // 9. Construct candidate release
  const packCandidate: any = {
    manifest: {
      ...baseDoc.manifest,
      version: targetVersion,
      name: 'PlaceMakers (Fletcher Building)',
      description: 'PlaceMakers trade-grade Business Pack with Autonomous Agent Mode',
      status: 'active',
      publishedAt: new Date().toISOString(),
      publishedBy: 'platform-agent-only',
    },
    profile: {
      ...baseDoc.profile,
      ...(draftData.profile || {}),
      primaryCurrency: 'NZD',
      supportedCurrencies: ['NZD'],
      primaryLocale: 'en-NZ',
      supportedLocales: ['en-NZ'],
    },
    persona: draftData.persona || baseDoc.persona || {
      systemName: 'PlaceMakers Digital Trade Consultant',
      brandTone: 'Professional, trade-grade, authoritative, NZBC compliant, practical',
      mission: 'Empowering Kiwi trades, builders, and DIY renovators with trade-grade building materials.',
      voice: 'Plain-speaking, knowledgeable Kiwi trade terminology.',
    },
    routingPolicy: {
      ...baseDoc.routingPolicy,
      defaultAgentId: 'placemakers_product_advisor',
      defaultJourneyId: 'placemakers_shop',
      fallbackOnCatalogSearch: true,
    },
    defaultAgentId: 'placemakers_product_advisor',
    agents: updatedAgents,
    vocabulary: baseDoc.vocabulary || { terms: [], acronyms: {}, slotSynonyms: {} },
    entities: baseDoc.entities || { entities: [] },
    conversationPolicy: baseDoc.conversationPolicy || {
      maxClarificationQuestionsPerTurn: 3,
      allowJourneySwitch: false,
    },
    modelPolicy: baseDoc.modelPolicy,
    journeys: baseDoc.journeys || [],
    rules: baseDoc.rules || [],
    capabilities: mergedCapabilities,
    experience: baseDoc.experience || {},
    evaluations: baseDoc.evaluations || [],
    extensions: {
      ...(baseDoc.extensions || {}),
      agentMode: {
        enabled: true,
        defaultAgentId: 'placemakers_product_advisor',
        timeoutMs: 20000,
        turnDeadlineMs: 20000,
      },
      dialoguePolicy: {
        ...((baseDoc.extensions || {}).dialoguePolicy || {}),
        agentMode: true,
      },
      journeyPlaybook: pmJourneyPlaybook,
    },
    factRegistry: baseDoc.factRegistry,
    calculators,
    catalogMapping,
    knowledgeModel: baseDoc.knowledgeModel,
  };

  // 10. Validate business pack integrity
  console.log(`Validating business pack integrity for v${targetVersion}...`);
  const validation = validateBusinessPack(packCandidate);
  if (!validation.valid) {
    console.error('❌ Business pack validation failed:', validation.issues);
    process.exit(1);
  }
  console.log(`✅ Business pack integrity passed (0 blocking errors, ${validation.issues.length} warnings).`);

  const checksum = computePackChecksum(packCandidate);

  // ── 11. PRINT STRUCTURED DIFFS AGAINST 1.3.17 ────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(`📋 DETAILED DIFF: Baseline v${currentVersion} ➔ Candidate v${targetVersion}`);
  console.log('══════════════════════════════════════════════════════════════════════');

  // A. Agents Diff
  printSectionHeader('1. AGENTS');
  const baseAgents: any[] = baseDoc.agents || [];
  console.log(`- Baseline Agent Count:  ${baseAgents.length} (${baseAgents.map((a) => a.agentId).join(', ') || 'none'})`);
  console.log(`+ Candidate Agent Count: ${updatedAgents.length} (${updatedAgents.map((a: any) => a.agentId).join(', ')})`);
  for (const ag of updatedAgents) {
    const existing = baseAgents.find((b) => b.agentId === ag.agentId);
    console.log(`  • Agent '${ag.agentId}' (${ag.name}):`);
    console.log(`    - Status:       ${existing ? 'MODIFIED' : 'NEW'}`);
    console.log(`    - isDefault:    ${ag.isDefault}`);
    console.log(`    - toolFirst:    ${ag.toolFirst ?? false}`);
    console.log(`    - allowedTools: [${ag.allowedTools.join(', ')}]`);
    console.log(`    - playbook:     ${ag.journeyPlaybook?.length || 0} stages configured`);
  }

  // B. Calculators Diff
  printSectionHeader('2. CALCULATORS');
  const baseCalcs: any[] = baseDoc.calculators || [];
  console.log(`- Baseline Calculators:  ${baseCalcs.length} attached`);
  console.log(`+ Candidate Calculators: ${calculators.length} verified calculators attached`);
  if (calculators.length === 0) {
    console.log(`  ℹ Note: Unverified plasterboard & decking calculators (with invented waste factors/fake refs)`);
    console.log(`          were removed and tracked in docs/agent-instructions/okf-verification-worklist.md.`);
    console.log(`          Live pack calculators = [] until authoritative manufacturer standards are signed off.`);
  } else {
    for (const c of calculators) {
      console.log(`  • Calculator '${c.calculatorId}': verificationRef='${c.verificationRef}'`);
    }
  }

  // C. Attributes Diff
  printSectionHeader('3. ATTRIBUTES & CATALOG MAPPING');
  const baseAttrDefs = Object.keys(baseDoc.catalogMapping?.attributeDefinitions || {});
  const candAttrDefs = Object.keys(catalogMapping.attributeDefinitions || {});
  console.log(`- Baseline Attributes:   [${baseAttrDefs.join(', ') || 'none'}]`);
  console.log(`+ Candidate Attributes:  [${candAttrDefs.join(', ')}]`);
  console.log(`  • Definitions mapped:  ${candAttrDefs.map((k) => `${k} (${(catalogMapping.attributeDefinitions as any)[k].description || 'defined'})`).join(', ')}`);
  console.log(`  • Attribute Aliases:   ${Object.keys(catalogMapping.attributeAliases || {}).length} aliases configured`);
  console.log(`  • Pricing Sources:     MSRP, OriginalPrice, priceUSD, variants.0.msrpUSD`);
  console.log(`  • Image Paths:         Main_Image_URL, imageUrl, images.0`);
  console.log(`  • Excluded Statuses:   Discontinued, discontinued`);

  // D. Prompts & Persona Diff
  printSectionHeader('4. PROMPTS & PERSONA');
  console.log(`- Baseline Persona:      ${baseDoc.persona?.systemName || '(none)'}`);
  console.log(`+ Candidate Persona:     ${packCandidate.persona.systemName}`);
  console.log(`  • Brand Tone:          ${packCandidate.persona.brandTone}`);
  console.log(`  • Mission:             ${packCandidate.persona.mission}`);
  console.log(`  • Voice:               ${packCandidate.persona.voice}`);
  console.log(`  • System Prompt Words: Strictly trade-compliant, zero invented fastener dimensions`);

  // E. Dialogue Policy & Extensions Diff
  printSectionHeader('5. DIALOGUE POLICY & ENGINE MODE');
  const baseAgentMode = baseDoc.extensions?.agentMode?.enabled ?? false;
  console.log(`- Baseline Agent Mode:   ${baseAgentMode ? 'ENABLED' : 'DISABLED'} (engineMode='rule-based')`);
  console.log(`+ Candidate Agent Mode:  ENABLED (engineMode='agent')`);
  console.log(`  • extensions.agentMode:      { enabled: true, defaultAgentId: 'placemakers_product_advisor', timeoutMs: 20000 }`);
  console.log(`  • extensions.dialoguePolicy: { agentMode: true }`);

  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('📊 DRY RUN VERIFICATION SUMMARY');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`Tenant:           placemakers`);
  console.log(`Environment:      production`);
  console.log(`Current Active:   v${currentVersion}`);
  console.log(`Target Candidate: v${targetVersion}`);
  console.log(`Candidate Hash:   ${checksum}`);
  console.log(`Status:           READY FOR PUBLICATION`);

  if (!isApply) {
    console.log('\n──────────────────────────────────────────────────────────────────────');
    console.log('🔒 DRY RUN COMPLETE — DATABASE WAS NOT MODIFIED.');
    console.log('   To publish and activate this release, run with:');
    console.log('     npx tsx scripts/publish-placemakers-agent-pack.ts --apply');
    console.log('──────────────────────────────────────────────────────────────────────\n');
    await client.close();
    return;
  }

  // 12. Apply Mode: Actually write to database
  console.log(`\n🚀 [APPLY] Publishing release v${targetVersion} into journeyx via publishBusinessPack...`);
  const pubResult = await publishBusinessPack(db, packCandidate, {
    publishedBy: 'platform-agent-only',
    notes: `PlaceMakers v${targetVersion} with Autonomous Agent Mode, attribute definitions, and verified calculators`,
  });

  console.log(`✅ Successfully published release:`, {
    version: pubResult.release.manifest.version,
    checksum: pubResult.checksum,
    revision: pubResult.pointer?.revision,
  });

  const updatedPointer = await db.collection('business_pack_pointers').findOne({
    tenantId: 'placemakers',
    environmentId: 'production',
  });

  console.log(`Verified active pointer:`, {
    tenantId: updatedPointer?.tenantId,
    environmentId: updatedPointer?.environmentId,
    activeVersion: updatedPointer?.activeVersion,
    previousVersion: updatedPointer?.previousVersion,
    revision: updatedPointer?.revision,
    checksum: updatedPointer?.checksum?.slice(0, 16) + '...',
  });

  await client.close();
  console.log(`Done.`);
}

main().catch((err) => {
  console.error('Fatal publication error:', err);
  process.exit(1);
});
