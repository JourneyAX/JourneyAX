import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOkfGeneratedClaims } from '../src/kernel/okf-claim-validator';
import { addNumericEvidence, factualToolNumbers } from '../src/kernel/numeric-evidence';

test('unverified numerical procedures do not become safe merely by being called a rule of thumb', () => {
  for (const text of [
    'Common rule of thumb: length ≈ 2–2.5 times the board thickness.',
    'Plan the fixing pattern (usually 2 fixings per support).',
    'The minimum clearance is 150 mm.',
  ]) assert.ok(validateOkfGeneratedClaims(text, ['suggestion']).forbidden.includes('installation_step'), text);
  assert.ok(validateOkfGeneratedClaims('For typical exposure, go for class 3 or 4 coated fasteners.', ['suggestion']).forbidden.includes('requirement'));
});

test('technical numbers cannot be laundered through an unverified note or a model-authored card', () => {
  const values = new Set<string>();
  addNumericEvidence(values, 'My room is 3 m by 2 m.');
  factualToolNumbers(values, 'consult_business_knowledge', { found: true, guidance: { status: 'context_only' }, knowledge: 'Common size 10g x 65–75mm.' });
  factualToolNumbers(values, 'present_card', { state: { size: '65 mm' } });
  factualToolNumbers(values, 'call_connector_tool', { ok: true, status: 'needs_confirmation', payload: { unexecutedPrice: 75 } });
  assert.equal(validateOkfGeneratedClaims('Common combo: 10g x 65–75mm.', ['catalog_fact', 'suggestion'], {}, { knownNumbers: values }).valid, false);
  assert.equal(validateOkfGeneratedClaims('Your room is 3 m by 2 m.', ['suggestion'], {}, { knownNumbers: values }).valid, true);
  factualToolNumbers(values, 'get_product', { sku: 'product-a', dimensions: { width: 600 }, price: 2049 });
  assert.equal(validateOkfGeneratedClaims('The returned unit is 600 mm wide and costs $2,049.', ['catalog_fact'], {}, { knownNumbers: values }).valid, true);
  assert.equal(validateOkfGeneratedClaims('1. Choose from the returned products.', ['suggestion'], {}, { knownNumbers: values }).valid, true, 'list numbering is not a factual quantity');
});

test('source-authorised numerical procedures and returned catalogue dimensions remain distinguishable', () => {
  assert.deepEqual(validateOkfGeneratedClaims('Common rule of thumb: length ≈ 2–2.5 times the board thickness.', ['suggestion', 'installation_step']).forbidden, []);
  assert.deepEqual(validateOkfGeneratedClaims('The returned cabinet is 600 mm wide.', ['suggestion', 'catalog_fact']).forbidden, []);
  assert.deepEqual(validateOkfGeneratedClaims('You asked for two options for a 3 m by 2 m room.', ['suggestion']).forbidden, []);
});
