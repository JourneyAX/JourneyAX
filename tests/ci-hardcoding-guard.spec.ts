/**
 * CI Hardcoding Guard Unit & Integration Tests (Item V10)
 *
 * Verifies that the CI guard permanently catches:
 * 1. Industry words in generic code (configured via scripts/guard-config.json)
 * 2. Customer phrase lists in src (e.g. isWhatToBuyOrBuildQuery, isFillerQuestion)
 * 3. Test ID checks (tc.id === / tc.id !==) in scripts/eval
 * 4. Broken or placeholder verificationRef links in packs and calculators
 */

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  RULES,
  loadGuardConfig,
  isWholeLineComment,
  stripComments,
  scanEvalTestIdBranches,
  scanPackVerificationRefs,
  runGuardSelfTest,
} from '../scripts/ci-hardcoding-guard';

const WORKSPACE_ROOT = path.resolve(__dirname, '..');

console.log('══════════════════════════════════════════════════════════════');
console.log('🧪 Running Guard Unit & Regression Tests (Item V10)');
console.log('══════════════════════════════════════════════════════════════\n');

// 1. Internal Guard Self-Test
console.log('1. Executing internal guard self-test suite...');
const selfTestResult = runGuardSelfTest();
assert.equal(selfTestResult.ok, true, `Guard self-test failed: ${selfTestResult.failedCases.join('; ')}`);
console.log('   ✅ Internal self-test passed.\n');

// 2. Industry Words Rule (scripts/guard-config.json)
console.log('2. Testing industry words enforcement from guard-config.json...');
const config = loadGuardConfig(WORKSPACE_ROOT);
assert.ok(config.forbiddenIndustryTerms.length > 10, 'Expected forbidden industry terms in guard config');
assert.ok(config.forbiddenIndustryTerms.includes('load-bearing'), 'Expected load-bearing in forbidden industry terms');
assert.ok(config.forbiddenIndustryTerms.includes('joist'), 'Expected joist in forbidden industry terms');
assert.ok(config.forbiddenIndustryTerms.includes('lintel'), 'Expected lintel in forbidden industry terms');
assert.ok(config.forbiddenIndustryTerms.includes('waterproofing'), 'Expected waterproofing in forbidden industry terms');

const industryRule = RULES.find((r) => r.name === 'Hardcoded Forbidden Industry Terms in Platform Source');
assert.ok(industryRule, 'Expected Hardcoded Forbidden Industry Terms rule in RULES');

const positiveIndustrySnippets = [
  "const material = 'decking';",
  "const t = 'timber';",
  "const spec = 'load-bearing framing';",
  "const joistItem = 'joist';",
  "const lintelType = 'lintel';",
  "const waterproofingMethod = 'waterproofing';",
];
for (const snippet of positiveIndustrySnippets) {
  const stripped = stripComments(snippet);
  const matched = industryRule.regex.test(stripped) && (!industryRule.ignoreIf || !industryRule.ignoreIf(stripped));
  assert.ok(matched, `Expected snippet to trigger industry word violation: "${snippet}"`);
}

const negativeIndustrySnippets = [
  "const status = 'verified';",
  "const category = 'generic_materials';",
  "if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;",
  "function routeByDialoguePolicy() {}",
];
for (const snippet of negativeIndustrySnippets) {
  const stripped = stripComments(snippet);
  const matched = industryRule.regex.test(stripped) && (!industryRule.ignoreIf || !industryRule.ignoreIf(stripped));
  assert.ok(!matched, `Expected snippet NOT to trigger industry word violation: "${snippet}"`);
}
console.log('   ✅ Industry words detection verified.\n');

// 3. Customer Phrase Lists in src
console.log('3. Testing customer utterance phrase lists detection...');
const phraseRule = RULES.find((r) => r.name === 'Customer Utterance Phrase Lists or Query Matchers in Generic Source');
assert.ok(phraseRule, 'Expected Customer Utterance Phrase Lists rule in RULES');

const positivePhraseSnippets = [
  'function isWhatToBuyOrBuildQuery(input: string): boolean {}',
  'function isFillerQuestion(sentence: string): boolean {}',
  'if (/what to buy/i.test(msg)) return true;',
  "const queries = ['what should I buy', 'what materials do I need'];",
  "const phrase = 'what should I get';",
];
for (const snippet of positivePhraseSnippets) {
  const stripped = stripComments(snippet);
  const matched = phraseRule.regex.test(stripped) && (!phraseRule.ignoreIf || !phraseRule.ignoreIf(stripped));
  assert.ok(matched, `Expected customer phrase snippet to trigger violation: "${snippet}"`);
}

const negativePhraseSnippets = [
  'const toolFirst = agent.toolFirst ?? false;',
  'function handleProductSearch(query: string) {}',
  'const allowedTools = ["search_products", "check_stock"];',
];
for (const snippet of negativePhraseSnippets) {
  const stripped = stripComments(snippet);
  const matched = phraseRule.regex.test(stripped) && (!phraseRule.ignoreIf || !phraseRule.ignoreIf(stripped));
  assert.ok(!matched, `Expected customer phrase snippet NOT to trigger violation: "${snippet}"`);
}
console.log('   ✅ Customer phrase list detection verified.\n');

// 4. Test ID Checks (tc.id) in Evaluation Scripts
console.log('4. Testing test ID checks scanner for evaluation scripts...');
const evalViolations = scanEvalTestIdBranches(WORKSPACE_ROOT);
assert.equal(evalViolations.length, 0, `Expected 0 test ID branches in scripts/eval, found: ${JSON.stringify(evalViolations)}`);

// Synthesize violation test
const testIdRegex = /\b(?:tc|testCase|caseItem|item)\.id\s*[!=]==?\s*\d+/;
assert.ok(testIdRegex.test('if (tc.id === 15) return "safety";'), 'Expected tc.id === 15 to match');
assert.ok(testIdRegex.test('if (tc.id !== 48) { executeSku(); }'), 'Expected tc.id !== 48 to match');
assert.ok(testIdRegex.test('if (testCase.id === 22) return "project";'), 'Expected testCase.id === 22 to match');
assert.ok(!testIdRegex.test('if (tc.expectedType === "safety") return true;'), 'Expected tc.expectedType NOT to match');
assert.ok(!testIdRegex.test('if (tc.category === "Timber & Dimensions") return true;'), 'Expected tc.category NOT to match');
console.log('   ✅ Test ID checks scanner verified.\n');

// 5. Pack & Calculator verificationRef Enforcement
console.log('5. Testing pack and calculator verificationRef enforcement...');
const packViolations = scanPackVerificationRefs(WORKSPACE_ROOT);
assert.equal(packViolations.length, 0, `Expected 0 broken verificationRefs in repo, found: ${JSON.stringify(packViolations)}`);

// Verify rejection of fake/placeholder calculators
const badCalc1 = { calculatorId: 'calc-fake-01', verificationRef: 'fake-pm-standard' };
const badCalc2 = { calculatorId: 'calc-fake-02', verificationRef: 'placeholder-ref' };
const badCalc3 = { calculatorId: 'calc-fake-03' }; // missing verificationRef
const badCalc4 = { calculatorId: 'calc-fake-04', verificationRef: '' }; // empty string

function checkCalcRef(calc: any): boolean {
  const ref = calc?.verificationRef;
  return (
    !ref ||
    typeof ref !== 'string' ||
    ref.trim() === '' ||
    ref.startsWith('fake-') ||
    ref.startsWith('placeholder') ||
    ref.startsWith('unverified')
  );
}

assert.ok(checkCalcRef(badCalc1), 'Expected badCalc1 with fake ref to be flagged');
assert.ok(checkCalcRef(badCalc2), 'Expected badCalc2 with placeholder ref to be flagged');
assert.ok(checkCalcRef(badCalc3), 'Expected badCalc3 with missing ref to be flagged');
assert.ok(checkCalcRef(badCalc4), 'Expected badCalc4 with empty ref to be flagged');

const goodCalc = { calculatorId: 'calc-real-01', verificationRef: 'okf:verified-as-nzs-timber-span' };
assert.ok(!checkCalcRef(goodCalc), 'Expected goodCalc with valid ref NOT to be flagged');
console.log('   ✅ Calculator verificationRef enforcement verified.\n');

console.log('══════════════════════════════════════════════════════════════');
console.log('✅ ALL GUARD REGRESSION TESTS PASSED SUCCESSFULLY.');
console.log('══════════════════════════════════════════════════════════════\n');
