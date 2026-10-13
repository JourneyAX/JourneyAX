import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { compileModelPolicy, validatePolicyOverrides } from '../src';

const suite = createSuite('business-pack: model policies are platform data with validated per-project overrides');
const ai = { provider: 'openai', model: 'gpt-5.5', temperature: 0.4 };
const policy = (aiConfig: any = ai) => compileModelPolicy({ projectId: 'acme', aiConfig });
const item = (compiled: ReturnType<typeof policy>, id: string) => compiled.policies.find((entry) => entry.policyId === id)!;

async function main() {
  await suite.test('without overrides the four policies are exactly what the platform always compiled', () => {
    const compiled = policy();
    assert.deepEqual(compiled.policies.map((entry) => [entry.policyId, entry.timeoutMs, entry.maxInputTokens, entry.maxOutputTokens, entry.candidates[0].temperature]), [
      ['fast_intent', 5000, 8000, 1000, 0],
      ['complex_reasoning', 15000, 20000, 2500, 0.4],
      ['tool_selection', 5000, 8000, 1000, 0],
      ['response_generation', 15000, 20000, 2500, 0.4],
    ]);
    assert.equal(compiled.defaultPolicy, 'complex_reasoning');
    assert.ok(compiled.policies.every((entry) => entry.candidates.length === 1 && entry.candidates[0].model === 'gpt-5.5' && entry.description.includes('acme')));
  });

  await suite.test('an override changes that policy only: its timeout and, if asked, its primary model', () => {
    const compiled = policy({ ...ai, policyOverrides: { fast_intent: { timeoutMs: 12000, model: 'gpt-5-mini' }, tool_selection: { timeoutMs: 9000 } } });
    assert.deepEqual([item(compiled, 'fast_intent').timeoutMs, item(compiled, 'fast_intent').candidates[0].model], [12000, 'gpt-5-mini']);
    assert.deepEqual([item(compiled, 'tool_selection').timeoutMs, item(compiled, 'tool_selection').candidates[0].model], [9000, 'gpt-5.5']);
    assert.deepEqual([item(compiled, 'response_generation').timeoutMs, item(compiled, 'response_generation').candidates[0].model], [15000, 'gpt-5.5']);
    assert.equal(item(compiled, 'fast_intent').candidates[0].temperature, 0, 'a deterministic step stays deterministic');
  });

  await suite.test('an override never touches the explicit fallback', () => {
    const compiled = policy({ ...ai, fallbackProvider: 'anthropic', fallbackModel: 'claude-x', policyOverrides: { fast_intent: { provider: 'google', model: 'gemini-fast' } } });
    const fast = item(compiled, 'fast_intent');
    assert.deepEqual(fast.candidates.map((candidate) => `${candidate.provider}/${candidate.model}`), ['google/gemini-fast', 'anthropic/claude-x']);
    assert.equal(fast.fallbackAllowed, true);
  });

  await suite.test('bad overrides are refused with a message that names the setting', () => {
    assert.deepEqual(validatePolicyOverrides(undefined), []);
    assert.deepEqual(validatePolicyOverrides(null), []);
    assert.deepEqual(validatePolicyOverrides({ fast_intent: { timeoutMs: 15000 } }), []);
    const cases: Array<[unknown, RegExp]> = [
      [[], /must be an object/], [{ nonsense: { timeoutMs: 5000 } }, /unknown policy/], [{ fast_intent: 'fast' }, /must be an object/],
      [{ fast_intent: { timeoutMs: 10 } }, /timeoutMs must be a whole number/], [{ fast_intent: { timeoutMs: 999999 } }, /timeoutMs/], [{ fast_intent: { timeoutMs: 1500.5 } }, /timeoutMs/],
      [{ fast_intent: { model: '' } }, /model must be a non-empty/], [{ fast_intent: { temperature: 1 } }, /unknown key/],
    ];
    for (const [value, expected] of cases) assert.match(validatePolicyOverrides(value).join('; '), expected, JSON.stringify(value));
    assert.throws(() => policy({ ...ai, policyOverrides: { fast_intent: { timeoutMs: 1 } } }), /timeoutMs/);
  });

  process.exitCode = suite.finish() ? 0 : 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
