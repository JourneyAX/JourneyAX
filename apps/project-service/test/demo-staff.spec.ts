import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { MemoryDb } from '@journeyax/test-support';
import { principalFrom, normaliseGroups } from '@journeyax/shared-types';
import { DEMO_STAFF, applyDemoStaff, planDemoStaff, removeDemoStaff } from '../../../scripts/placemakers/demo-staff';
import { buildAccessPreview } from '../src/access-preview';

const suite = createSuite('project-service: demo staff for trying who sees what');
const fakeHash = async (password: string) => `hash:${password.length}`;
/** One database standing in for both, as a rehearsal may use. */
const both = (db: MemoryDb) => ({ users: db as any, project: db as any });

async function main() {
  await suite.test('the plan names a team, a membership and a login for each person, and no raw password reaches a stored document', async () => {
    const plan = planDemoStaff('PlaceMakers', 'org1', new Date('2026-10-25T00:00:00Z'));
    assert.equal(plan.tenantId, 'placemakers');
    assert.deepEqual(plan.teams.map((t) => t.teamId), ['team_customer_service', 'team_sales', 'team_sales_managers', 'team_branch', 'team_finance', 'team_marketing', 'team_insights', 'team_leadership']);
    assert.deepEqual(plan.members.map((m) => `${m.email}:${m.teams.join('+')}`), [
      'csr@placemakers.demo:Customer Service', 'sales@placemakers.demo:Sales', 'sales.manager@placemakers.demo:Sales Managers',
      'branch@placemakers.demo:Branch', 'finance@placemakers.demo:Finance',
      'marketing@placemakers.demo:Marketing', 'insights@placemakers.demo:Insights', 'exec@placemakers.demo:Leadership',
    ]);
    assert.ok(plan.members.every((m) => m.teams.length === 1), 'each person is in exactly one team: with two, the stricter row would only ever take access away');
    assert.equal(plan.users.length, 12, 'eight staff logins, a signed-in shopper and three trade customers');
    for (const email of ['shopper', 'trade.admin', 'trade.buyer', 'trade.foreman']) {
      const customer = plan.users.find((u) => u.email === `${email}@placemakers.demo`)!;
      assert.equal(customer.role, 'buyer', `${email} signs in as a shopper`);
      assert.ok(!plan.members.some((m) => m.email === customer.email), `${email} is not a member of the project and is in no team`);
    }
    const db = new MemoryDb();
    await applyDemoStaff(both(db), plan, fakeHash);
    const stored = JSON.stringify([...db.dump('users'), ...db.dump('project_members'), ...db.dump('project_teams')]);
    for (const person of DEMO_STAFF) assert.ok(!stored.includes(person.password), 'only a hash is stored');
    assert.ok(db.dump('users').every((u: any) => typeof u.passwordHash === 'string' && !('password' in u)));
  });

  await suite.test('loading twice changes nothing, and removing takes the logins and memberships away but leaves the teams', async () => {
    const db = new MemoryDb();
    const plan = planDemoStaff('placemakers');
    await applyDemoStaff(both(db), plan, fakeHash);
    await applyDemoStaff(both(db), plan, fakeHash);
    assert.equal(db.dump('users').length, 12);
    assert.equal(db.dump('project_members').length, 8);
    assert.equal(db.dump('project_teams').length, 8);
    await removeDemoStaff(both(db), plan);
    assert.equal(db.dump('users').length, 0);
    assert.equal(db.dump('project_members').length, 0);
    assert.equal(db.dump('project_teams').length, 8, 'teams may hold real people');
  });

  await suite.test('logins go to the sign-in service\'s database and teams and memberships to the project service\'s, never the other way', async () => {
    const usersDb = new MemoryDb();
    const projectDb = new MemoryDb();
    const plan = planDemoStaff('placemakers');
    const result = await applyDemoStaff({ users: usersDb as any, project: projectDb as any }, plan, fakeHash);
    assert.deepEqual(result, { teams: 8, members: 8, users: 12 });
    assert.equal(usersDb.dump('users').length, 12);
    assert.equal(usersDb.dump('project_members').length, 0, 'no membership in the sign-in database');
    assert.equal(usersDb.dump('project_teams').length, 0, 'no team in the sign-in database');
    assert.equal(projectDb.dump('users').length, 0, 'no login in the project database');
    assert.equal(projectDb.dump('project_members').length, 8);
    assert.equal(projectDb.dump('project_teams').length, 8);
    await applyDemoStaff({ users: usersDb as any, project: projectDb as any }, plan, fakeHash);
    assert.equal(usersDb.dump('users').length + projectDb.dump('project_members').length, 20, 'loading twice changes nothing');
    await removeDemoStaff({ users: usersDb as any, project: projectDb as any }, plan);
    assert.equal(usersDb.dump('users').length, 0);
    assert.equal(projectDb.dump('project_members').length, 0);
    assert.equal(projectDb.dump('project_teams').length, 8, 'teams may hold real people');
  });

  await suite.test('what the gateway reads back from a membership is the group the pack\'s access rows name', async () => {
    const plan = planDemoStaff('placemakers');
    const csr = plan.members.find((m) => m.email.startsWith('csr'))!;
    assert.deepEqual(normaliseGroups(csr.teams), ['customer-service']);
    const user = plan.users.find((u) => u.email.startsWith('csr'))!;
    const principal = principalFrom({ userId: user.email, tenantId: user.tenantId, role: user.role, groups: normaliseGroups(csr.teams) });
    assert.deepEqual({ audience: principal.audience, groups: principal.groups }, { audience: 'staff', groups: ['customer-service'] });
  });

  await suite.test('with the draft pack\'s access table the demo customer-service person opens on the customer-service agent and the sales rep on the quote desk', async () => {
    const draft = JSON.parse((await import('node:fs')).readFileSync((await import('node:path')).resolve(__dirname, '../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
    const project = { agents: draft.agents, extensions: draft.extensions, defaultAgentId: draft.defaultAgentId };
    const teams = planDemoStaff('placemakers').teams;
    const opens = (audience: 'shopper' | 'staff', groups: string[]) => buildAccessPreview(project as any, teams, { audience, groups }).agents.find((a) => a.opensFirst)?.agentId;
    assert.equal(opens('shopper', []), 'placemakers_product_advisor', 'a shopper still opens on the product advisor');
    assert.equal(opens('staff', ['customer-service']), 'placemakers_customer_service');
    assert.equal(opens('staff', ['sales']), 'placemakers_sales_quote');
    assert.equal(opens('staff', ['branch']), 'placemakers_customer_service', 'the counter opens beside customer service');
    assert.equal(opens('staff', ['finance']), 'placemakers_customer_service');
    const shopperAgents = buildAccessPreview(project as any, teams, { audience: 'shopper', groups: [] }).agents.map((a) => a.agentId);
    assert.ok(shopperAgents.includes('placemakers_product_advisor'), 'shoppers keep the advisor');
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
