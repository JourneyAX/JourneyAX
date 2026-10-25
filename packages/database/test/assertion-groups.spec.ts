import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { ASSERTION_MAX_GROUPS, cleanAssertionGroups, signGatewayAssertion, verifyGatewayAssertion } from '../src/assertion';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const secret = 'assertion-secret-for-groups-test-32!';
const verify = (token: string) => verifyGatewayAssertion(token, secret, { expectedTenantId: 'placemakers', expectedEnvironmentId: 'production' });
const base = { tenantId: 'placemakers', environmentId: 'production', sub: 'rep@placemakers.test', role: 'operator' as const };

console.log('🧪 Gateway assertion: staff groups');

check('groups are signed and come back exactly', () => {
  const payload = verify(signGatewayAssertion({ ...base, groups: ['customer-service', 'sales'] }, secret));
  assert.deepEqual(payload.groups, ['customer-service', 'sales']);
});

check('no groups means no claim, so an older assertion and a shopper look the same', () => {
  assert.equal(verify(signGatewayAssertion(base, secret)).groups, undefined);
  assert.equal(verify(signGatewayAssertion({ ...base, groups: [] }, secret)).groups, undefined);
});

check('the signer drops anything that is not a clean group id, repeats, and caps the list', () => {
  assert.deepEqual(cleanAssertionGroups(['Sales', 'sales', '<x>', '', 'a b', 'trade-desk', 'trade-desk', 7, null]), ['sales', 'trade-desk'], 'only ids already in the clean form survive, once each');
  assert.equal(cleanAssertionGroups(Array.from({ length: 500 }, (_, i) => `g-${i}`)).length, ASSERTION_MAX_GROUPS);
  assert.deepEqual(cleanAssertionGroups('not a list'), []);
});

check('a changed group list fails the signature', () => {
  const token = signGatewayAssertion({ ...base, groups: ['sales'] }, secret);
  const [encoded, sig] = token.split('.');
  const edited = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  edited.groups = ['customer-service'];
  const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}`;
  assert.throws(() => verify(forged), /Signature mismatch/);
});

check('a correctly signed assertion with a malformed groups claim is refused', () => {
  const sign = (groups: unknown) => {
    const payload = { iss: 'journeyax-api-gateway', aud: 'journeyax-runtime', tenantId: 'placemakers', environmentId: 'production', sub: 'x@y.test', role: 'operator', groups, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, jti: 'jti_test' };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${crypto.createHmac('sha256', secret).update(encoded).digest('hex')}`;
  };
  for (const bad of ['sales', [1], ['UPPER'], ['has space'], ['a'.repeat(65)], ['dup', 'dup'], Array.from({ length: 51 }, (_, i) => `g-${i}`)]) {
    assert.throws(() => verify(sign(bad)), /Invalid groups claim/, JSON.stringify(bad).slice(0, 40));
  }
  assert.deepEqual(verify(sign(['ok-group'])).groups, ['ok-group']);
});

console.log(`✅ assertion groups: ${passed} passed, 0 failed`);
