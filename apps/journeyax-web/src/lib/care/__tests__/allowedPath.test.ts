/**
 * The portal passes on only the care desk's known paths, with plain segments, and only with the method each path uses.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/care/__tests__/allowedPath.test.ts
 */
import assert from 'node:assert/strict';
import { allowedCarePath } from '../allowedPath';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('care proxy paths');

check('the list, one ticket, the board and a poll are read or asked for with the right method', () => {
  assert.equal(allowedCarePath('GET', ['tickets']), true);
  assert.equal(allowedCarePath('GET', ['tickets', 't4322']), true);
  assert.equal(allowedCarePath('GET', ['board']), true);
  assert.equal(allowedCarePath('POST', ['poll']), true);
});
check('a decision is a POST on a ticket with one of four known actions', () => {
  for (const a of ['approve', 'retry', 'reject', 'to-lead']) assert.equal(allowedCarePath('POST', ['tickets', 't4322', a]), true, a);
  assert.equal(allowedCarePath('POST', ['tickets', 't4322', 'delete']), false);
  assert.equal(allowedCarePath('GET', ['tickets', 't4322', 'approve']), false, 'a decision is never a GET');
  assert.equal(allowedCarePath('POST', ['tickets']), false);
});
check('anything else, an odd segment, or another method is not passed on', () => {
  assert.equal(allowedCarePath('GET', []), false);
  assert.equal(allowedCarePath('GET', ['..', 'admin']), false);
  assert.equal(allowedCarePath('GET', ['tickets', 'a/b']), false);
  assert.equal(allowedCarePath('GET', ['tickets', 'x'.repeat(65)]), false);
  assert.equal(allowedCarePath('GET', ['board', 'extra']), false);
  assert.equal(allowedCarePath('PUT', ['tickets', 't1']), false);
  assert.equal(allowedCarePath('DELETE', ['tickets', 't1']), false);
});

console.log(`✅ web: care proxy paths: ${passed} passed, 0 failed`);
