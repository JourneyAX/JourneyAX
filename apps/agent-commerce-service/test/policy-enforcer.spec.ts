import { PolicyEnforcer } from '../src/pipeline/policy-enforcer';

async function runTests() {
  console.log('🧪 Running PolicyEnforcer Boundary Test Suite...');

  const enforcer = new PolicyEnforcer();

  // Test 1: requiredUiTool correctly selects UI tools based on intent and capabilities
  const blockedIntent: any = { panelRenderBlocked: true, stage: 'products', retrievalType: 'product' };
  if (enforcer.requiredUiTool(blockedIntent) !== null) {
    throw new Error('Test 1 failed: blocked panel render must return null');
  }

  const productIntent: any = { stage: 'products', retrievalType: 'product' };
  if (enforcer.requiredUiTool(productIntent) !== 'showItems') {
    throw new Error('Test 1 failed: product intent should require showItems');
  }

  const customIntent: any = { stage: 'products', retrievalType: 'product' };
  if (enforcer.requiredUiTool(customIntent, { customised: true, capabilities: ['configurator'] }) !== 'showConfigurator') {
    throw new Error('Test 1 failed: customisable product should require showConfigurator');
  }

  const guideIntent: any = { stage: 'installation', retrievalType: 'installation' };
  if (enforcer.requiredUiTool(guideIntent) !== 'showGuide') {
    throw new Error('Test 1 failed: installation stage should require showGuide');
  }
  console.log('  ✅ PASS: requiredUiTool resolves proper tools according to intent and capabilities');

  // Test 2: needsGenderFirst logic
  const genderDimConfig = {
    contextDimensions: [{ key: 'gender', required: true }],
  };
  const userNoGender = [{ role: 'user', content: 'Looking for a running jacket' }];
  if (!enforcer.needsGenderFirst({}, genderDimConfig, userNoGender)) {
    throw new Error('Test 2 failed: gender required brand with unknown gender must trigger gate');
  }
  const userWithGender = [{ role: 'user', content: 'Looking for a womens running jacket' }];
  if (enforcer.needsGenderFirst({}, genderDimConfig, userWithGender)) {
    throw new Error('Test 2 failed: stated gender should not trigger gate');
  }
  console.log('  ✅ PASS: needsGenderFirst respects dimension configuration and conversational context');

  // Test 3: synthGenderClarify constructs valid setPhase action
  const clarifyAction = enforcer.synthGenderClarify({ dimensions: {} });
  if (clarifyAction.name !== 'setPhase' || clarifyAction.arguments.phase !== 'clarify') {
    throw new Error('Test 3 failed: synthGenderClarify must return setPhase clarify');
  }
  if (!clarifyAction.arguments.questions.some((q: any) => q.id === 'gender')) {
    throw new Error('Test 3 failed: questions must include gender');
  }
  console.log('  ✅ PASS: synthGenderClarify outputs well-formed clarification payload');

  // Test 4: stripCartTaboo drops configurator / 3D sentences on plain retail
  const proseWithTaboo = 'Here are the jackets. These items are non-customisable. Would you like to add one to your cart?';
  const cleaned = enforcer.stripCartTaboo(proseWithTaboo, true);
  if (cleaned.includes('non-customisable')) {
    throw new Error(`Test 4 failed: taboo sentence was not dropped: "${cleaned}"`);
  }
  if (!cleaned.includes('Here are the jackets') || !cleaned.includes('Would you like to add one to your cart?')) {
    throw new Error(`Test 4 failed: valid sentences were dropped: "${cleaned}"`);
  }
  console.log('  ✅ PASS: stripCartTaboo cleanly eliminates out-of-domain vocabulary');

  console.log('🎉 ALL POLICY ENFORCER TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ PolicyEnforcer tests failed:', err);
  process.exit(1);
});
