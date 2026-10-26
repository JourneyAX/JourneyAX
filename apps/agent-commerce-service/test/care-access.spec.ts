import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { signGatewayAssertion } from '@journeyax/database';
import { CareController } from '../src/care/care.controller';
import { CareService } from '../src/care/care.service';

/**
 * Who counts as customer care. The gateway signs the person's role and their project teams into every call ("Customer Service" arrives as the
 * group `customer-service`, and the care login's user type `cs` is signed as `consultant`); the browser never says. `care/me` is the one question the chat may ask, to decide whether to offer the care screens:
 * anyone signed in gets a plain yes or no, and every other care route still refuses a person who is not care staff.
 */
const SECRET = 'test-secret-for-care-access';
process.env.GATEWAY_ASSERTION_SECRET = SECRET;
const suite = createSuite('care: who counts as customer care, and the question "am I care staff?"');
const sign = (claims: { sub: string; role: string; groups?: string[] }, tenantId = 'placemakers') =>
  signGatewayAssertion({ tenantId, environmentId: 'production', ...claims } as any, SECRET);

async function main() {
  const care = new CareService();
  const controller = new CareController(care);
  const me = (assertion: string | undefined) => controller.me('placemakers', assertion) as any;

  await suite.test('a member of the Customer Service team is care staff, and is the care person their login names', () => {
    const answer = me(sign({ sub: 'csr@placemakers.demo', role: 'consultant', groups: ['customer-service'] }));
    assert.equal(answer.care, true);
    assert.equal(answer.actor.name, 'Aroha Ngata');
    assert.equal(answer.actor.isLead, false);
    assert.deepEqual(Object.keys(answer.actor).sort(), ['id', 'isLead', 'name'], 'nothing else about the person is sent');
  });

  await suite.test('the older group name `csr` still counts', () => {
    assert.equal(me(sign({ sub: 'csr@placemakers.demo', role: 'consultant', groups: ['csr'] })).care, true);
  });

  await suite.test('an admin acts as the team lead', () => {
    const answer = me(sign({ sub: 'admin@placemakers.demo', role: 'admin', groups: ['administrators'] }));
    assert.equal(answer.care, true);
    assert.equal(answer.actor.isLead, true);
  });

  await suite.test('a shopper, other staff teams, a staff role with no team, or nobody are told "no", not refused', () => {
    assert.deepEqual(me(sign({ sub: 'jo@example.com', role: 'customer' })), { care: false });
    assert.deepEqual(me(sign({ sub: 'sam@placemakers.demo', role: 'operator', groups: ['sales'] })), { care: false });
    assert.deepEqual(me(sign({ sub: 'mia@placemakers.demo', role: 'consultant', groups: ['marketing', 'branch-counter'] })), { care: false });
    assert.deepEqual(me(sign({ sub: 'csr@placemakers.demo', role: 'consultant' })), { care: false }, 'the team lookup failing leaves no groups, which is no access');
    assert.deepEqual(me(undefined), { care: false });
  });

  await suite.test('a signature for another tenant, a changed signature or a made-up header is not care staff', () => {
    const real = sign({ sub: 'csr@placemakers.demo', role: 'consultant', groups: ['customer-service'] });
    assert.deepEqual(me(sign({ sub: 'csr@placemakers.demo', role: 'consultant', groups: ['customer-service'] }, 'another-tenant')), { care: false });
    assert.deepEqual(me(real + 'x'), { care: false });
    assert.deepEqual(me('customer-service'), { care: false });
  });

  await suite.test('every other care route still refuses a person who is not care staff', async () => {
    const shopper = sign({ sub: 'jo@example.com', role: 'customer' });
    const refused = (error: any) => error?.getStatus?.() === 403 && error.getResponse().error === 'Customer care only.';
    await assert.rejects(async () => controller.list('placemakers', shopper), refused);
    await assert.rejects(async () => controller.board('placemakers', shopper), refused);
    await assert.rejects(async () => controller.list('placemakers', undefined), refused);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
