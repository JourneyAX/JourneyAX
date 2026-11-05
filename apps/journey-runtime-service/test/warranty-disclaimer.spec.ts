import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOkfGeneratedClaims, withholdUnsupportedClaims } from '../src/kernel/okf-claim-validator';

test('truthful warranty evidence limitations remain readable without granting warranty claims', () => {
  for (const sentence of [
    'I have no verified information on the warranty terms for that hoodie.',
    'The full written guarantee terms are not available.',
    'Full written warranty and guarantee documentation is not available.',
    'No verified warranty information was returned.',
    'We have no confirmed information about the guarantee coverage.',
    'The manufacturer warranty details have been unavailable.',
    'Written warranty terms are missing.',
    'Full written warranty terms/conditions are not on file in this system, so coverage specifics (what’s included/excluded, installation requirements, etc.) can’t be confirmed here.',
  ]) {
    assert.equal(validateOkfGeneratedClaims(sentence, ['suggestion']).valid, true, sentence);
    assert.equal(withholdUnsupportedClaims(sentence, ['suggestion']).text, sentence);
  }
});

test('an absence disclaimer never authorises positive, quoted, joined or different-product warranty claims', () => {
  for (const sentence of [
    'No documents, but this product is guaranteed 20 years.',
    'I have no verified information on warranty terms, but it has a 20-year warranty.',
    'The full written guarantee terms are not available, and it is guaranteed for 20 years.',
    'No verified warranty information means it is covered for 20 years.',
    'Full written guarantee terms are not available: guaranteed 20 years.',
    'No verified warranty information; the product has a lifetime warranty.',
    'No verified information on the warranty terms says “guaranteed for 20 years”.',
    'No verified warranty information for SKU-A, and SKU-B has a 20-year warranty.',
    'The full written guarantee terms are missing for this product, while the other product is guaranteed for 20 years.',
    'The warranty document is unavailable, “SKU-B is guaranteed for 20 years”, so SKU-A has the same coverage.',
    'The warranty terms are not available and it covers accidental damage.',
    'The warranty terms are unavailable, coverage against rust included.',
    'No verified warranty information, free replacement for life.',
    'This product has no warranty.',
    'This product is not covered by any warranty.',
    'Warranty terms are not on file, so coverage specifics (it covers accidental damage) can’t be confirmed here.',
  ]) {
    assert.ok(validateOkfGeneratedClaims(sentence, ['suggestion']).forbidden.includes('warranty'), sentence);
    assert.equal(withholdUnsupportedClaims(sentence, ['suggestion']).text, '', sentence);
  }
});

test('a missing-document limitation cannot carry an installation obligation after it', () => {
  const sentence = 'Warranty terms are not on file, so installation requirements cannot be confirmed here and it must be installed by a licensed builder.';
  const result = validateOkfGeneratedClaims(sentence, ['suggestion']);
  assert.equal(result.valid, false);
  assert.ok(result.forbidden.includes('installation_step'));
});

test('a labelled source quotation still requires an exact source-owned statement', () => {
  const context = { exactClaimStatements: new Map<any, Set<string>>([['warranty', new Set(['Warranty Duration (SKU ITEM-A): 5 years.'])]]) };
  assert.equal(validateOkfGeneratedClaims('- Source statement: *“Warranty Duration (SKU ITEM-A): 5 years.”*', ['suggestion'], undefined, context).valid, true);
  for (const text of ['Source statement: “Warranty Duration (SKU ITEM-B): 5 years.”', 'Source statement: “Warranty Duration (SKU ITEM-A): 20 years.”', 'Source statement: “Warranty Duration (SKU ITEM-A): 5 years.” It covers all damage.']) {
    assert.equal(validateOkfGeneratedClaims(text, ['suggestion'], undefined, context).valid, false, text);
  }
});

test('following unsupported sentences are withheld while evidence disclaimers remain, and other product periods cannot transfer', () => {
  const disclaimer = 'The full written guarantee terms are not available.';
  const result = withholdUnsupportedClaims(`${disclaimer} This product is guaranteed for 20 years.`, ['suggestion']);
  assert.equal(result.text, disclaimer); assert.equal(result.removed.length, 1);
  const context = { catalogueWarrantyFacts: [{ sku: 'SKU-A', title: 'Source product A', duration: '5 years' }], exactClaimStatements: new Map<any, Set<string>>([['warranty', new Set(['SKU-A has a catalogue warranty duration of 5 years.'])]]) };
  for (const sentence of ['No verified warranty information for SKU-B, but SKU-B has a catalogue warranty duration of 20 years.', 'No verified information on warranty terms, “SKU-A has 5 years”, so SKU-B is guaranteed for 5 years.']) {
    assert.ok(validateOkfGeneratedClaims(sentence, ['suggestion'], undefined, context).forbidden.includes('warranty'), sentence);
  }
});
