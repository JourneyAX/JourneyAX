import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { RuntimeService } from '../apps/journey-runtime-service/src/runtime.service';

async function runTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING JOURNEY RUNTIME SERVICE END-TO-END VALIDATION');
  console.log('========================================================================');

  const runtime = new RuntimeService();

  // -------------------------------------------------------------------------
  // TEST 1: WORKWEAR GROUP GROUNDED CAPABILITY SCENARIO
  // -------------------------------------------------------------------------
  console.log('\n--- SCENARIO 1: WORKWEAR GROUP SOLUTION (GROUNDED & SECURE) ---');
  const workwearCommand = {
    tenantId: 'workweargroup',
    environmentId: 'production' as const,
    workspaceId: `ws_runtime_ww_${Date.now()}`,
    sessionId: `session_runtime_ww_${Date.now()}`,
    correlationId: `corr_runtime_ww_${Date.now()}`,
    message: 'I’m an apprentice electrician. I need lightweight summer pants and composite-toe boots under $250.',
  };

  const startMs = Date.now();
  const wwResult = await runtime.runTurn(workwearCommand);
  const elapsedMs = Date.now() - startMs;

  console.log(`⏱️ Workwear turn completed in ${elapsedMs}ms`);
  console.log('Workspace Stage:', wwResult.workspace.currentStage);
  console.log('Decision Type:', wwResult.decision.type);
  console.log('Target Capability:', wwResult.decision.targetCapability);
  console.log('Assistant Message:', wwResult.assistantMessage);

  const bundle = wwResult.executedCapabilities[0]?.output?.bundle;
  if (!bundle) {
    throw new Error('❌ Test 1 Failed: Expected capability output with bundle');
  }

  console.log(`Bundle ID: ${bundle.bundleId}`);
  console.log(`Pants: ${bundle.pants.name} (${bundle.pants.sku}) - $${bundle.pants.priceCents / 100} AUD`);
  console.log(`Boots: ${bundle.boots.name} (${bundle.boots.sku}) - $${bundle.boots.priceCents / 100} AUD`);
  console.log(`Total: $${bundle.totalPriceCents / 100} AUD`);

  // Assertions
  if (wwResult.workspace.facts['occupation']?.value !== 'apprentice electrician') {
    throw new Error('❌ Test 1 Failed: Occupation not apprentice electrician');
  }
  if (bundle.totalPriceCents > 25000) {
    throw new Error(`❌ Test 1 Failed: Bundle price $${bundle.totalPriceCents / 100} exceeds $250 limit`);
  }
  if (bundle.boots?.attributes?.toeProtection !== 'composite') {
    throw new Error(`❌ Test 1 Failed: Boots must be composite toe, got: ${bundle.boots?.attributes?.toeProtection}`);
  }
  if (bundle.pants?.attributes?.weightClass !== 'lightweight') {
    throw new Error(`❌ Test 1 Failed: Pants must be lightweight, got: ${bundle.pants?.attributes?.weightClass}`);
  }
  const hasBundleCard = wwResult.uiInstructions.some((i) => i.component === 'bundle');
  if (!hasBundleCard) {
    throw new Error('❌ Test 1 Failed: Missing bundle card in uiInstructions');
  }
  if (wwResult.workspace.stateVersion < 1) {
    throw new Error('❌ Test 1 Failed: Workspace stateVersion was not incremented');
  }
  console.log('✅ Scenario 1 (Workwear) PASSED all assertions!');

  // -------------------------------------------------------------------------
  // TEST 2: ROYAL CYBER CONSULTING SCENARIO (MULTI-DOMAIN NEUTRALITY)
  // -------------------------------------------------------------------------
  console.log('\n--- SCENARIO 2: ROYAL CYBER ENTERPRISE CONSULTING (DOMAIN NEUTRAL) ---');
  const rcCommand = {
    tenantId: 'royalcyber',
    environmentId: 'production' as const,
    workspaceId: `ws_runtime_rc_${Date.now()}`,
    sessionId: `session_runtime_rc_${Date.now()}`,
    correlationId: `corr_runtime_rc_${Date.now()}`,
    message: 'We want to modernize our legacy monolithic order system to GCP microservices and implement GenAI conversational search. Our budget is approximately $80,000 USD.',
  };

  const rcStartMs = Date.now();
  const rcResult = await runtime.runTurn(rcCommand);
  const rcElapsedMs = Date.now() - rcStartMs;

  console.log(`⏱️ Royal Cyber turn completed in ${rcElapsedMs}ms`);
  console.log('Stage:', rcResult.workspace.currentStage);
  console.log('Decision:', rcResult.decision.type, '->', rcResult.decision.targetStage);
  console.log('Extracted Facts:', JSON.stringify(rcResult.workspace.facts, null, 2));
  console.log('Assistant Message:', rcResult.assistantMessage);

  if (rcResult.workspace.facts['cloudPlatform']?.value !== 'gcp') {
    throw new Error('❌ Test 2 Failed: cloudPlatform fact not extracted as gcp');
  }
  if (rcResult.workspace.facts['budget']?.value?.amount !== 80000) {
    throw new Error('❌ Test 2 Failed: budget fact not extracted as 80000');
  }
  if (rcResult.decision.type !== 'transition_stage' || rcResult.decision.targetStage !== 'sow_draft') {
    throw new Error(`❌ Test 2 Failed: Expected transition to sow_draft, got: ${rcResult.decision.targetStage}`);
  }
  console.log('✅ Scenario 2 (Royal Cyber) PASSED all assertions!');

  console.log('\n========================================================================');
  console.log('🎉 ALL JOURNEY RUNTIME SERVICE VALIDATION TESTS PASSED!');
  console.log('========================================================================');
}

runTests().catch((err) => {
  console.error('Fatal error during validation:', err);
  process.exit(1);
});
