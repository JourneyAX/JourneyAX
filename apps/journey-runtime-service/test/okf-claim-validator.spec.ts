import assert from 'node:assert/strict';
import { validateOkfGeneratedClaims, withholdUnsupportedClaims } from '../src/kernel/okf-claim-validator';

assert.deepEqual(
  validateOkfGeneratedClaims('This fitting is guaranteed for 10 years.', ['suggestion']).forbidden,
  ['warranty'],
);
assert.ok(validateOkfGeneratedClaims('It is compatible with every outlet and complies with code.', ['suggestion']).forbidden.includes('compatibility'));
assert.ok(validateOkfGeneratedClaims('It is compatible with every outlet and complies with code.', ['suggestion']).forbidden.includes('legal_requirement'));
assert.deepEqual(validateOkfGeneratedClaims('Would you like to review the options shown?', ['suggestion']).forbidden, []);
assert.deepEqual(validateOkfGeneratedClaims('This fitting has a 10-year warranty.', ['suggestion', 'warranty']).forbidden, []);

// One sentence that asserts an unsupported claim costs only that sentence, never the whole reply.
const mixed = withholdUnsupportedClaims('Here are the timber options. You should drill a pilot hole first. Which length do you need?\nThis fitting is guaranteed for 10 years.', ['suggestion']);
assert.equal(mixed.text, 'Here are the timber options. Which length do you need?');
assert.deepEqual(mixed.removed.map((entry) => entry.classes), [['installation_step'], ['warranty']]);
assert.equal(withholdUnsupportedClaims('Compatible with everything. It must be installed by a professional.', ['suggestion']).text, '', 'nothing left when every sentence is a claim');
assert.deepEqual(withholdUnsupportedClaims('Tell me what you are screwing into.', ['suggestion']), { text: 'Tell me what you are screwing into.', removed: [] });
assert.equal(withholdUnsupportedClaims('This has a 10-year warranty.', ['suggestion', 'warranty']).text, 'This has a 10-year warranty.', 'an allowed class is kept');
// What is withheld is exactly what the validator would reject.
for (const text of ['A. Suitable for outdoor use.', 'Cheap. It requires a permit.', 'Only a question?']) {
  const kept = withholdUnsupportedClaims(text, ['suggestion']).text;
  assert.equal(validateOkfGeneratedClaims(kept, ['suggestion']).valid, true, `"${kept}" passes the validator`);
}
console.log('✅ OKF claim validator: 11 passed, 0 failed');
