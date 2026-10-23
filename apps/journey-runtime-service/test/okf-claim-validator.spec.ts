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
// Instructions that tell a customer how to protect themselves are safety claims in any tense, not only the base form.
assert.ok(validateOkfGeneratedClaims('Always wear a respirator and apply in a ventilated area.', ['suggestion']).forbidden.includes('safety_instruction'));
assert.ok(validateOkfGeneratedClaims('Apply in a ventilated area.', ['suggestion']).forbidden.includes('care_safety'));
assert.ok(validateOkfGeneratedClaims('Use diluted 1:4 with water.', ['suggestion']).forbidden.includes('care_safety'));
assert.deepEqual(validateOkfGeneratedClaims('Spray on, leave to dry, then brush off.', ['suggestion']).forbidden, [], 'an ordinary usage step is not a safety claim');
assert.deepEqual(validateOkfGeneratedClaims('Always wear a respirator and apply in a ventilated area.', ['suggestion', 'safety_instruction', 'care_safety']).forbidden, [], 'allowed once the release verifies safety guidance');
// What a model said about a leaking toilet: steps that tell a customer what to do with water and fittings are safety instructions,
// whatever the object is called ("the isolation tap", "the stop valve", "at the wall").
for (const sentence of [
  'For a leaky toilet, turn off the isolation tap and avoid using it until the leak is checked.',
  'Switch off the power at the switchboard.',
  'Shut the water off at the stop valve.',
  'Isolate the supply before you start.',
  'Stop using the heater.',
  "Don't use the shower until it is repaired.",
]) assert.ok(validateOkfGeneratedClaims(sentence, ['suggestion']).forbidden.includes('safety_instruction'), sentence);
assert.deepEqual(withholdUnsupportedClaims('For a leaky toilet, turn off the isolation tap and avoid using it until the leak is checked. Tell me where the water shows up?', ['suggestion']).text, 'Tell me where the water shows up?', 'the instruction goes, the question stays');
for (const ordinary of ['Isolation valves are in the plumbing aisle.', 'This kettle has an automatic switch.', 'Spray on, leave to dry, then brush off.', 'Turn the handle clockwise to open.']) {
  assert.deepEqual(validateOkfGeneratedClaims(ordinary, ['suggestion']).forbidden, [], `ordinary wording is not a safety claim: ${ordinary}`);
}

// U1: Safety and structural questions (#15, #48, #99)
// The claim guard must withhold unsupported structural and electrical statements (use the exact #15 sentence as a test)
const prompt15Sentence1 = 'For load-bearing beams, you should typically use structural timber grades such as H1.2, H3, or H4, depending on the specific requirements of your project.';
const prompt15Sentence2 = 'These grades are designed to handle the load and stress associated with structural applications.';

assert.ok(
  validateOkfGeneratedClaims(prompt15Sentence1, ['suggestion']).forbidden.includes('safety_instruction'),
  'exact #15 sentence 1 must be rejected by claim guard when safety_instruction is unverified'
);
assert.ok(
  validateOkfGeneratedClaims(prompt15Sentence2, ['suggestion']).forbidden.includes('safety_instruction'),
  'exact #15 sentence 2 must be rejected by claim guard when safety_instruction is unverified'
);

const withheld15 = withholdUnsupportedClaims(`${prompt15Sentence1} ${prompt15Sentence2}`, ['suggestion']);
assert.equal(withheld15.text, '', 'entire unsupported structural statement must be withheld');
assert.equal(withheld15.removed.length, 2, 'both structural sentences must be removed');

// Electrical statements near power outlets (#99) must be withheld when unsupported
assert.ok(
  validateOkfGeneratedClaims('You can use standard nails near power outlets if you are cautious.', ['suggestion']).forbidden.includes('safety_instruction'),
  'electrical advice near power outlets must be withheld'
);

// Verified professional referrals must NOT be withheld as claims
const referral1 = 'For load-bearing beams, please consult a licensed professional or engineer.';
const referral2 = 'For structural calculations, electrical wiring, gas fitting, or building consent questions, please consult a licensed professional or engineer.';
assert.deepEqual(validateOkfGeneratedClaims(referral1, ['suggestion']).forbidden, [], 'referral to licensed professional is allowed');
assert.deepEqual(validateOkfGeneratedClaims(referral2, ['suggestion']).forbidden, [], 'general professional referral is allowed');
assert.equal(withholdUnsupportedClaims(referral1, ['suggestion']).text, referral1);
assert.equal(withholdUnsupportedClaims(referral2, ['suggestion']).text, referral2);

console.log('✅ OKF claim validator: all tests passed including U1 structural & electrical assertions');

