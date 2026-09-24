import assert from 'node:assert/strict';
import { MembershipService } from '../src/membership.service';
import { TeamService } from '../src/team.service';

async function runMembershipTests() {
  console.log('👥 Running Membership and Team Lifecycle Tests in Agent 4...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}: ${err.message}`);
      failed++;
    }
  }

  // In-memory test collection mock
  const members = new Map<string, any>();
  const teams = new Map<string, any>();

  const mockMembersCol: any = {
    findOne: async (query: any) => {
      for (const m of members.values()) {
        let match = true;
        for (const [k, v] of Object.entries(query)) {
          if (m[k] !== v) match = false;
        }
        if (match) return m;
      }
      return null;
    },
    insertOne: async (doc: any) => {
      members.set(`${doc.projectId}:${doc.email}`, { ...doc });
    },
    updateOne: async (filter: any, update: any) => {
      const existing = await mockMembersCol.findOne(filter);
      if (!existing) return { matchedCount: 0 };
      if (update.$set) Object.assign(existing, update.$set);
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) delete existing[k];
      }
      if (update.$push) {
        for (const [k, v] of Object.entries(update.$push)) {
          existing[k] = existing[k] || [];
          existing[k].push(v);
        }
      }
      members.set(`${existing.projectId}:${existing.email}`, existing);
      return { matchedCount: 1 };
    },
    find: (filter: any) => ({
      sort: () => ({
        toArray: async () => Array.from(members.values()).filter((m) => m.projectId === filter.projectId),
      }),
    }),
  };

  const mockTeamsCol: any = {
    updateOne: async (filter: any, update: any) => {
      const key = `${filter.projectId}:${filter.teamId}`;
      teams.set(key, { ...update.$set });
      return { matchedCount: 1 };
    },
    find: (filter: any) => ({
      toArray: async () => Array.from(teams.values()).filter((t) => t.projectId === filter.projectId),
    }),
  };

  const membershipService = new MembershipService(
    () => mockMembersCol,
    () => true
  );

  const teamService = new TeamService(
    () => mockTeamsCol,
    () => true
  );

  // Test 1: Member invitation
  await test('inviteMember creates pending invitation with token', async () => {
    const res = await membershipService.inviteMember(
      'tenant-alpha',
      'org-1',
      'user1@example.com',
      'Alice User',
      'operator',
      'admin-inviter'
    );
    assert.equal(res.success, true);
    assert.ok(res.invitationToken);

    const check = await membershipService.verifyMembership('user1@example.com', 'tenant-alpha');
    // Pending member is not yet verified as active
    assert.equal(check.isMember, false);
  });

  // Test 2: Accept invitation
  await test('acceptInvitation activates member', async () => {
    const mem = await mockMembersCol.findOne({ email: 'user1@example.com', projectId: 'tenant-alpha' });
    assert.ok(mem);

    const res = await membershipService.acceptInvitation('tenant-alpha', 'user1@example.com', mem.invitationToken);
    assert.equal(res.success, true);

    const check = await membershipService.verifyMembership('user1@example.com', 'tenant-alpha');
    assert.equal(check.isMember, true);
    assert.equal(check.role, 'operator');
  });

  // Test 3: Role update
  await test('updateMemberRole updates role with audit trail', async () => {
    const res = await membershipService.updateMemberRole(
      'tenant-alpha',
      'user1@example.com',
      'manager',
      true,
      'admin-updater'
    );
    assert.equal(res.success, true);

    const check = await membershipService.verifyMembership('user1@example.com', 'tenant-alpha');
    assert.equal(check.role, 'manager');
  });

  // Test 4: Member soft revocation
  await test('removeMember revokes membership', async () => {
    const res = await membershipService.removeMember('tenant-alpha', 'user1@example.com', 'admin-revoker');
    assert.equal(res.success, true);

    const check = await membershipService.verifyMembership('user1@example.com', 'tenant-alpha');
    assert.equal(check.isMember, false);
  });

  // Test 5: Team addition and listing
  await test('addTeam and listTeams persists team ownership', async () => {
    const teamRes = await teamService.addTeam('tenant-alpha', 'org-1', {
      name: 'Safety Specialists',
      workflowOwnership: ['safety-quote', 'compliance-check'],
    });
    assert.equal(teamRes.success, true);
    assert.equal(teamRes.team.name, 'Safety Specialists');

    const list = await teamService.listTeams('tenant-alpha');
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Safety Specialists');
  });

  console.log(`\nMembership & Team Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runMembershipTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
