import assert from 'node:assert/strict';
import { GroupDirectory } from '../src/group-directory';

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function directory(handler: (url: string, init: any) => Promise<Response>, over: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init: any }> = [];
  let clock = 1_000;
  const warnings: string[] = [];
  const dir = new GroupDirectory({
    baseUrl: () => 'http://projects.test',
    headers: async () => ({ 'x-internal-key': 'k' }),
    fetchImpl: (async (url: string, init: any) => { calls.push({ url, init }); return handler(url, init); }) as unknown as typeof fetch,
    now: () => clock,
    warn: (m) => warnings.push(m),
    ...over,
  });
  return { dir, calls, warnings, tick: (ms: number) => { clock += ms; } };
}

async function main() {
  console.log('🧪 Group directory: staff groups from the project members');

  await check('a member\'s teams come back normalised, and the call names the tenant, the person and the credentials', async () => {
    const { dir, calls } = directory(async () => reply(200, { isMember: true, teams: ['Customer Service', 'sales', ''] }));
    assert.deepEqual(await dir.groupsFor('PlaceMakers', 'Rep@PlaceMakers.test'), ['customer-service', 'sales']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://projects.test/api/v1/projects/placemakers/verify-membership');
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'rep@placemakers.test' });
    assert.equal(calls[0].init.headers['x-internal-key'], 'k');
    assert.equal(calls[0].init.headers['X-Tenant-ID'], 'placemakers');
  });

  await check('an answer is kept for a short time, then asked again; two asks at once make one call', async () => {
    const { dir, calls, tick } = directory(async () => reply(200, { isMember: true, teams: ['sales'] }));
    const [a, b] = await Promise.all([dir.groupsFor('t', 'a@b.test'), dir.groupsFor('t', 'a@b.test')]);
    assert.deepEqual([a, b], [['sales'], ['sales']]);
    assert.equal(calls.length, 1);
    await dir.groupsFor('t', 'a@b.test');
    assert.equal(calls.length, 1, 'still kept');
    tick(61_000);
    await dir.groupsFor('t', 'a@b.test');
    assert.equal(calls.length, 2, 'asked again after the time is up');
  });

  await check('a person who is not a member, or a failed call, has no groups, and a failure is remembered only briefly', async () => {
    let status = 500;
    const { dir, calls, tick, warnings } = directory(async () => (status === 200 ? reply(200, { isMember: false }) : reply(status, {})));
    assert.deepEqual(await dir.groupsFor('t', 'x@y.test'), []);
    assert.deepEqual(await dir.groupsFor('t', 'x@y.test'), []);
    assert.equal(calls.length, 1, 'the failure is not retried at once');
    assert.equal(warnings.length, 1);
    status = 200;
    tick(11_000);
    assert.deepEqual(await dir.groupsFor('t', 'x@y.test'), []);
    assert.equal(calls.length, 2, 'asked again once the short failure time is over');
  });

  await check('a thrown error, a timeout or a missing address never throws and gives no groups', async () => {
    const { dir } = directory(async () => { throw new Error('connection refused'); });
    assert.deepEqual(await dir.groupsFor('t', 'a@b.test'), []);
    const none = new GroupDirectory({ baseUrl: () => undefined, headers: async () => ({}) });
    assert.deepEqual(await none.groupsFor('t', 'a@b.test'), []);
  });

  await check('a guest, an empty name or a name that is not an email is never looked up', async () => {
    const { dir, calls } = directory(async () => reply(200, { isMember: true, teams: ['sales'] }));
    for (const email of ['guest@anonymous', '', 'anonymous', 'usr_123']) assert.deepEqual(await dir.groupsFor('t', email), [], email);
    assert.deepEqual(await dir.groupsFor('', 'a@b.test'), []);
    assert.equal(calls.length, 0);
  });

  await check('the memory is capped: the oldest answers are forgotten first', async () => {
    const { dir, calls } = directory(async () => reply(200, { isMember: true, teams: ['sales'] }), { maxEntries: 2 });
    await dir.groupsFor('t', 'a@b.test');
    await dir.groupsFor('t', 'b@b.test');
    await dir.groupsFor('t', 'c@b.test');
    assert.equal(calls.length, 3);
    await dir.groupsFor('t', 'a@b.test');
    assert.equal(calls.length, 4, 'a was forgotten');
    await dir.groupsFor('t', 'c@b.test');
    assert.equal(calls.length, 4, 'c is still kept');
  });

  console.log(`✅ group directory: ${passed} passed, 0 failed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
