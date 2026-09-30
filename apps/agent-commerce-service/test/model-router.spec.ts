import { isReasoningModel, genParams, openModelMaxTokens, ModelRouter } from '../src/llm/model-router';

async function runTests() {
  console.log('🧪 Running ModelRouter Boundary Test Suite...');

  // Test 1: isReasoningModel identifies gpt-5 and o-series
  if (!isReasoningModel('gpt-5') || !isReasoningModel('gpt-5-turbo') || !isReasoningModel('o1') || !isReasoningModel('o3-mini')) {
    throw new Error('Test 1 failed: did not identify reasoning models');
  }
  if (isReasoningModel('gpt-4o') || isReasoningModel('claude-3-opus') || isReasoningModel('gemini-2.0-flash')) {
    throw new Error('Test 1 failed: falsely identified non-reasoning models');
  }
  console.log('  ✅ PASS: Reasoning models correctly detected');

  // Test 2: genParams applies reasoning_effort low only to plain gpt-5, rejects temperature
  const gpt5Params = genParams('gpt-5', 0.7);
  if (gpt5Params.temperature !== undefined || gpt5Params.reasoning_effort !== 'low') {
    throw new Error(`Test 2 failed: expected reasoning_effort low without temp for gpt-5, got: ${JSON.stringify(gpt5Params)}`);
  }
  const o3Params = genParams('o3-mini', 0.5);
  if (o3Params.temperature !== undefined || (o3Params as any).reasoning_effort !== undefined) {
    throw new Error(`Test 2 failed: o3-mini should have no temp and no effort, got: ${JSON.stringify(o3Params)}`);
  }
  const gpt4Params = genParams('gpt-4o', 0.2);
  if (gpt4Params.temperature !== 0.2 || (gpt4Params as any).reasoning_effort !== undefined) {
    throw new Error(`Test 2 failed: gpt-4o should have temperature 0.2, got: ${JSON.stringify(gpt4Params)}`);
  }
  console.log('  ✅ PASS: Generation parameters correctly formatted per model architecture');

  // Test 3: openModelMaxTokens clamping
  if (openModelMaxTokens({}) !== 768) throw new Error('Test 3 failed: default should be 768');
  if (openModelMaxTokens({ maxTokens: 50 }) !== 128) throw new Error('Test 3 failed: minimum clamped to 128');
  if (openModelMaxTokens({ maxTokens: 10000 }) !== 4096) throw new Error('Test 3 failed: maximum clamped to 4096');
  if (openModelMaxTokens({ maxTokens: 2048 }) !== 2048) throw new Error('Test 3 failed: valid value 2048 preserved');
  console.log('  ✅ PASS: Open model max tokens correctly bounded');

  // Test 4: ModelRouter instantiates and provides client
  const router = new ModelRouter();
  const client = router.getClient({});
  if (!client) throw new Error('Test 4 failed: ModelRouter did not produce OpenAI client');
  console.log('  ✅ PASS: ModelRouter provides valid provider client');

  console.log('🎉 ALL MODEL ROUTER TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ ModelRouter tests failed:', err);
  process.exit(1);
});
