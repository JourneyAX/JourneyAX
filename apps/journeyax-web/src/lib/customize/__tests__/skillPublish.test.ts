/**
 * Saving and deleting a skill through a pretend project service: what is written, what is published, and what is put back when the gate says no.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/skillPublish.test.ts
 */
import assert from 'node:assert/strict';
import { changeSkill, readSkillOp, type SkillOp } from '../skillPublish';
import { fingerprintInState } from '../skillEdit';

let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const project = () => ({
  projectId: 'placemakers',
  agents: [{ agentId: 'advisor', name: 'Advisor', skills: ['greet'] }, { agentId: 'service', name: 'Service', skills: [] }],
  extensions: {
    skills: [{ skillId: 'greet', name: 'Greeting', description: 'How to open', instructions: 'Say hello.', tier: 'always', tools: [] }],
    skillAccess: { rows: [] as any[] },
    plugins: { plugins: [{ pluginId: 'desk', name: 'Desk', provides: { agents: [], skills: ['greet'], forms: [], connectors: [], tools: [] } }], access: [] },
    connectors: { connectors: [{ connectorId: 'salesforce', displayName: 'Salesforce', tools: [{ name: 'list_cases', sideEffect: 'read' }] }], policy: [] },
  },
});

/** A pretend project service: GET gives the settings, PATCH stores them the way the real one does, publish says yes or no. */
function service(opts: { publish?: 'ok' | 'refuse' | 'down'; patch?: 'ok' | 'refuse'; read?: 'ok' | 'down' } = {}) {
  const doc: any = project();
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const fetchImpl = (async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const json = (status: number, payload: unknown) => ({ ok: status < 400, status, json: async () => payload }) as any;
    if (method === 'GET') return opts.read === 'down' ? json(500, {}) : json(200, JSON.parse(JSON.stringify(doc)));
    if (method === 'PATCH') {
      if (opts.patch === 'refuse') return json(400, { message: 'Invalid skills: nope' });
      if (body.skills) doc.extensions.skills = body.skills;
      if (body.agents) doc.agents = body.agents;
      for (const [key, value] of Object.entries(body.extensions ?? {})) doc.extensions[key] = value;
      return json(200, { success: true });
    }
    if (String(url).endsWith('/publish')) {
      if (opts.publish === 'down') throw new Error('socket hang up');
      return opts.publish === 'refuse' ? json(404, { message: 'Agent service carries skill ghost which is not defined' }) : json(200, { success: true, version: '1.3.40' });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { doc, calls, deps: { base: 'http://project/api/v1/projects/placemakers', headers: { Authorization: 'Bearer t', 'X-Tenant-ID': 'placemakers' }, fetchImpl } };
}
const save = (over: Record<string, any> = {}): SkillOp => ({
  kind: 'save', mode: 'create',
  input: { name: 'Order enquiry', description: 'When a colleague asks about an order', tier: 'on_demand', instructions: 'Find the order.', tools: ['salesforce.list_cases'], access: [{ audience: 'staff', groups: ['customer-service'], level: 'available' }], agents: ['service'], ...over },
});

async function main() {
  console.log('saving a skill');

  await check('a new skill is written, then published with a note; the page is told its id and the new version', async () => {
    const s = service();
    const out = await changeSkill(s.deps, save());
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, skillId: 'order-enquiry', version: '1.3.40' });
    const [read, patch, publish] = s.calls;
    assert.equal(read.method, 'GET');
    assert.equal(patch.method, 'PATCH');
    assert.deepEqual(Object.keys(patch.body).sort(), ['agents', 'extensions', 'skills']);
    assert.equal(patch.body.skills.length, 2);
    assert.deepEqual(patch.body.extensions.skillAccess.rows, [{ skillId: 'order-enquiry', audience: 'staff', groups: ['customer-service', 'administrators'], level: 'available' }]);
    assert.equal(publish.method, 'POST');
    assert.match(publish.url, /\/publish$/);
    assert.equal(publish.body.environmentId, 'production');
    assert.match(publish.body.note, /Skill "Order enquiry" added/);
    assert.equal(s.calls.length, 3, 'no undo was needed');
  });

  await check('only what changed is written: an edit of the text alone writes the skills and nothing else', async () => {
    const s = service();
    const base = fingerprintInState({ skills: s.doc.extensions.skills, agents: s.doc.agents, accessRows: [] }, 'greet')!;
    const out = await changeSkill(s.deps, { kind: 'save', mode: 'update', base, input: { skillId: 'greet', name: 'Greeting', description: 'How to open', tier: 'always', instructions: 'Say hello warmly.', tools: [], access: [], agents: ['advisor'] } });
    assert.equal(out.status, 200);
    const patch = s.calls.find((c) => c.method === 'PATCH')!;
    assert.deepEqual(Object.keys(patch.body), ['skills']);
    assert.equal(s.doc.extensions.skills[0].instructions, 'Say hello warmly.');
  });

  await check('a skill changed elsewhere since the page read it is not overwritten: 409, and nothing is written', async () => {
    const s = service();
    const out = await changeSkill(s.deps, { kind: 'save', mode: 'update', base: 'stale-1', input: { skillId: 'greet', name: 'Greeting', description: 'How to open', tier: 'always', instructions: 'Mine.', tools: [], access: [], agents: ['advisor'] } });
    assert.equal(out.status, 409);
    assert.equal(out.body.conflict, true);
    assert.match(out.body.error, /changed somewhere else/);
    assert.deepEqual(s.calls.map((c) => c.method), ['GET']);
  });

  await check('when the gate refuses the publish, every setting is put back exactly as it was, and the person is told why', async () => {
    const s = service({ publish: 'refuse' });
    const before = JSON.parse(JSON.stringify(s.doc));
    const out = await changeSkill(s.deps, save());
    assert.equal(out.status, 422);
    assert.match(out.body.error, /not published: Agent service carries skill ghost/);
    assert.deepEqual(s.doc, before, 'the project is as it was');
    assert.deepEqual(s.calls.map((c) => c.method), ['GET', 'PATCH', 'POST', 'PATCH']);
    assert.deepEqual(Object.keys(s.calls[3].body).sort(), ['agents', 'extensions', 'skills'], 'the undo covers what the change touched');
  });

  await check('a publish that gets no answer is also undone', async () => {
    const s = service({ publish: 'down' });
    const before = JSON.parse(JSON.stringify(s.doc));
    const out = await changeSkill(s.deps, save());
    assert.equal(out.status, 502);
    assert.deepEqual(s.doc, before);
  });

  await check('the project refusing the save, or not being readable, stops before anything is published', async () => {
    const refused = service({ patch: 'refuse' });
    const a = await changeSkill(refused.deps, save());
    assert.equal(a.status, 422);
    assert.match(a.body.error, /could not be saved/);
    assert.ok(!refused.calls.some((c) => c.url.endsWith('/publish')));
    const down = service({ read: 'down' });
    const b = await changeSkill(down.deps, save());
    assert.equal(b.status, 502);
    assert.deepEqual(down.calls.map((c) => c.method), ['GET']);
  });

  await check('a mistake in the form is a 400 with the reason, and nothing is written', async () => {
    const s = service();
    const out = await changeSkill(s.deps, save({ tools: ['no.such_tool'], agents: ['ghost'] }));
    assert.equal(out.status, 400);
    assert.match(out.body.error, /no\.such_tool/);
    assert.match(out.body.error, /ghost/);
    assert.deepEqual(s.calls.map((c) => c.method), ['GET']);
  });

  console.log('deleting a skill');

  await check('deleting removes the skill everywhere it is named, publishes, and says what it touched', async () => {
    const s = service();
    const base = fingerprintInState({ skills: s.doc.extensions.skills, agents: s.doc.agents, accessRows: [] }, 'greet')!;
    const out = await changeSkill(s.deps, { kind: 'delete', skillId: 'greet', base });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.affected, { agents: ['advisor'], plugins: ['desk'], rows: 0 });
    assert.deepEqual(s.doc.extensions.skills, []);
    assert.deepEqual(s.doc.agents[0].skills, []);
    assert.deepEqual(s.doc.extensions.plugins.plugins[0].provides.skills, []);
  });

  await check('a refused delete is undone, and deleting a skill that is gone or changed is refused', async () => {
    const s = service({ publish: 'refuse' });
    const before = JSON.parse(JSON.stringify(s.doc));
    const base = fingerprintInState({ skills: s.doc.extensions.skills, agents: s.doc.agents, accessRows: [] }, 'greet')!;
    const out = await changeSkill(s.deps, { kind: 'delete', skillId: 'greet', base });
    assert.equal(out.status, 422);
    assert.deepEqual(s.doc, before);
    assert.equal((await changeSkill(service().deps, { kind: 'delete', skillId: 'ghost', base: 'x' })).status, 409);
    assert.equal((await changeSkill(service().deps, { kind: 'delete', skillId: 'greet', base: 'stale' })).status, 409);
  });

  console.log('reading the request');

  await check('a request body becomes an operation with its shapes fixed, or says what is missing', () => {
    const op = readSkillOp({ op: 'save', mode: 'create', skill: { name: ' Hello ', description: 'd', instructions: 'i', tier: 'nonsense', tools: ['a', 5, ' b '], agents: ['x'], access: [{ audience: 'staff', groups: ['t'], level: 'default' }, { audience: 'weird', groups: 'no', level: 'odd' }, null] } }) as Extract<SkillOp, { kind: 'save' }>;
    assert.equal(op.kind, 'save');
    assert.equal(op.input.tier, 'always');
    assert.deepEqual(op.input.tools, ['a', 'b']);
    assert.deepEqual(op.input.access, [{ audience: 'staff', groups: ['t'], level: 'default' }, { audience: 'shopper', groups: [], level: 'available' }]);
    assert.ok('error' in (readSkillOp({ op: 'save', mode: 'update', skill: { skillId: 'greet' } }) as object), 'an update needs the version the page saw');
    assert.ok('error' in (readSkillOp({ op: 'delete', skillId: 'greet' }) as object));
    assert.ok('error' in (readSkillOp({ op: 'wipe' }) as object));
    assert.ok('error' in (readSkillOp(null) as object));
    assert.deepEqual(readSkillOp({ op: 'delete', skillId: 'greet', base: 'f' }), { kind: 'delete', skillId: 'greet', base: 'f' });
  });

  console.log(`${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
