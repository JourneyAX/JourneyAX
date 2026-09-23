import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { TurnRunner } from '../apps/agent-commerce-service/src/turn/run-turn';

async function runWorkwearAcceptanceTest() {
  console.log('================================================================');
  console.log('🧪 RUNNING JOURNEYAX OS WORKWEAR ACCEPTANCE SCENARIO (EVAL-001)');
  console.log('================================================================');

  const runner = new TurnRunner();

  const command = {
    tenantId: 'workweargroup',
    environmentId: 'production' as const,
    workspaceId: `ws_eval_${Date.now()}`,
    sessionId: `session_eval_${Date.now()}`,
    message: 'I’m an apprentice electrician. I need lightweight summer pants and composite-toe boots under $250.',
  };

  console.log(`\n[Input Command]: "${command.message}"`);
  console.log(`[Tenant]: ${command.tenantId} | [Workspace]: ${command.workspaceId}`);

  const startMs = Date.now();
  const result = await runner.runTurn(command);
  const elapsedMs = Date.now() - startMs;

  console.log(`\n⏱️ Turn completed in ${elapsedMs}ms`);

  console.log('\n--- 1. Extracted Facts in Durable Workspace ---');
  console.log('Occupation:', result.workspace.facts['occupation']?.value);
  console.log('Required Items:', result.workspace.facts['required_item_types']?.value);
  console.log('Budget:', result.workspace.facts['budget']?.value);

  console.log('\n--- 2. Journey Engine Decision ---');
  console.log('Decision Type:', result.decision.type);
  console.log('Target Capability:', result.decision.targetCapability);
  console.log('Reason:', result.decision.reason);

  console.log('\n--- 3. Executed Capability Outcome ---');
  const bundle = result.executedCapabilities[0]?.output?.bundle;
  if (bundle) {
    console.log(`Bundle ID: ${bundle.bundleId}`);
    console.log(`Pants: ${bundle.pants.name} (${bundle.pants.sku}) - $${bundle.pants.priceCents / 100} AUD`);
    console.log(`Boots: ${bundle.boots.name} (${bundle.boots.sku}) - $${bundle.boots.priceCents / 100} AUD`);
    console.log(`Total Price: $${bundle.totalPriceCents / 100} AUD`);
  }

  console.log('\n--- 4. UI Instructions Generated ---');
  for (const inst of result.uiInstructions) {
    console.log(`Component: [${inst.component}] (placement=${inst.placement})`);
  }

  console.log('\n--- 5. Grounded Assistant Response ---');
  console.log(result.assistantMessage);

  console.log('\n================================================================');
  console.log('🔍 VERIFYING ACCEPTANCE CRITERIA:');

  let passed = true;

  // Criterion 1: Occupation extracted
  if (result.workspace.facts['occupation']?.value === 'apprentice electrician') {
    console.log('✅ PASS: Occupation correctly recognized as "apprentice electrician"');
  } else {
    console.error('❌ FAIL: Occupation recognition failed');
    passed = false;
  }

  // Criterion 2: Items decomposed into pants and boots
  const items = result.workspace.facts['required_item_types']?.value;
  if (Array.isArray(items) && items.includes('pants') && items.includes('boots')) {
    console.log('✅ PASS: Items correctly decomposed into pants and boots');
  } else {
    console.error('❌ FAIL: Item slot decomposition failed');
    passed = false;
  }

  // Criterion 3: Budget extracted as $250 AUD
  const budget = result.workspace.facts['budget']?.value;
  if (budget && budget.amountCents === 25000 && budget.currency === 'AUD') {
    console.log('✅ PASS: Budget constraint correctly parsed as 25,000 cents ($250.00 AUD)');
  } else {
    console.error('❌ FAIL: Budget parsing failed');
    passed = false;
  }

  // Criterion 4: Total bundle cost <= $250.00 AUD
  if (bundle && bundle.totalPriceCents <= 25000) {
    console.log(`✅ PASS: Bundle total ($${bundle.totalPriceCents / 100} AUD) strictly satisfies <= $250.00 AUD budget ceiling!`);
  } else {
    console.error('❌ FAIL: Total bundle exceeds budget ceiling!');
    passed = false;
  }

  // Criterion 5: UI Card generated
  const hasBundleCard = result.uiInstructions.some((i) => i.component === 'bundle_summary_card');
  if (hasBundleCard) {
    console.log('✅ PASS: Structured bundle_summary_card UI instruction emitted for storefront');
  } else {
    console.error('❌ FAIL: bundle_summary_card was not generated');
    passed = false;
  }

  console.log('================================================================');
  if (passed) {
    console.log('🎉 ALL ACCEPTANCE SCENARIO ASSERTIONS PASSED SUCCESSFULLY!');
    process.exit(0);
  } else {
    console.error('💥 ACCEPTANCE TEST FAILED');
    process.exit(1);
  }
}

runWorkwearAcceptanceTest().catch((err) => {
  console.error('Acceptance test threw exception:', err);
  process.exit(1);
});
