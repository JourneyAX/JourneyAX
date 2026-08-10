/**
 * Grounding-validator checks — asserts the commercial-fact guard catches invented
 * prices/SKUs without flagging legitimate replies. Pure functions, no service or
 * network needed. Run with:
 *   npx tsx apps/agent-commerce-service/src/pipeline/grounding-validator.test.ts
 */
import { validateGrounding } from './grounding-validator';

/** Shaped like a real searchKnowledge tool result, since that is what the
 *  validator receives — JSON with `price` / `sku` fields. */
const FACTS = JSON.stringify({
  results: [
    { title: 'Liano II Bath/Shower Mixer', sku: '853010MW', price: 349 },
    { title: 'Contura II Rail Shower With Overhead', sku: '766100W', price: 1063 },
    { title: 'EasySwitch In-Wall Body', sku: '99651F', price: 150 },
  ],
});

let failures = 0;

function check(name: string, actualOk: boolean, expectedOk: boolean, reason?: string) {
  if (actualOk === expectedOk) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name} — expected ok=${expectedOk}, got ok=${actualOk}. ${reason || ''}`);
    failures++;
  }
}

console.log('\ngrounding-validator — commercial facts');

// Legitimate replies must NOT be flagged.
let v = validateGrounding('That mixer is $349.', 'business', true, FACTS);
check('price present in retrieved facts', v.ok, true, v.reason);

v = validateGrounding('The rail shower is $1,063.', 'business', true, FACTS);
check('comma-formatted price matches "1063.00"', v.ok, true, v.reason);

v = validateGrounding('SKU 853010MW is in stock.', 'business', true, FACTS);
check('SKU present in retrieved facts', v.ok, true, v.reason);

v = validateGrounding('It is 300MM wide and 1200X600.', 'business', true, FACTS);
check('measurements are not treated as SKUs', v.ok, true, v.reason);

v = validateGrounding('Just $5 extra.', 'business', true, FACTS);
check('sub-3-digit price is not claimed as verified', v.ok, true, v.reason);

// Fabrications must be flagged.
v = validateGrounding('That will be $899.', 'business', true, FACTS);
check('invented price is flagged', v.ok, false, v.reason);
if (v.unverified?.[0] !== '$899') {
  console.error(`  FAIL invented price should be named in .unverified, got ${JSON.stringify(v.unverified)}`);
  failures++;
} else {
  console.log('  ok   flagged price is named in .unverified');
}

v = validateGrounding('Order SKU 999999ZZ today.', 'business', true, FACTS);
check('invented SKU is flagged', v.ok, false, v.reason);

// Computed totals are honest arithmetic over real prices — must NOT be flagged.
console.log('\ngrounding-validator — computed totals');

v = validateGrounding('The mixer is $349 plus the $150 in-wall body, so $499 total.', 'business', true, FACTS);
check('sum of two retrieved prices is accepted', v.ok, true, v.reason);

v = validateGrounding('Two mixers comes to $698.', 'business', true, FACTS);
check('quantity multiple (2 × $349) is accepted', v.ok, true, v.reason);

v = validateGrounding('Mixer, shower and plate together: $1,761.', 'business', true, FACTS);
check('three-item total (349+1063+349) is accepted', v.ok, true, v.reason);

// ...but a number that is NOT reachable by adding real prices is still caught.
v = validateGrounding('Your total is $2,000.', 'business', true, FACTS);
check('non-derivable total is still flagged', v.ok, false, v.reason);

// Scope guards — must stay silent when it cannot verify.
v = validateGrounding('As I mentioned, it was $899.', 'business', false, '');
check('no retrieval this turn → no commercial check', v.ok, true, v.reason);

v = validateGrounding('That will be $899.', 'business', true, undefined);
check('no corpus supplied → check skipped', v.ok, true, v.reason);

// Pre-existing technical behaviour must be unchanged.
console.log('\ngrounding-validator — technical steps (regression)');

v = validateGrounding('Step 1: turn off the water.', 'technical', false);
check('step instructions with no retrieval are flagged', v.ok, false, v.reason);

v = validateGrounding('Step 1: turn off the water.', 'technical', true, FACTS);
check('step instructions with retrieval are fine', v.ok, true, v.reason);

v = validateGrounding('Happy to help with your bathroom.', 'business', false);
check('ordinary business chat is fine', v.ok, true, v.reason);

console.log(
  failures === 0
    ? '\nPASS — all grounding-validator checks passed.\n'
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
