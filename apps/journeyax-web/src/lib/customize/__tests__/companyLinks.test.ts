/**
 * Linking a login to a company through a pretend project service: what the page may ask, and what it is told back.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/companyLinks.test.ts
 */
import assert from 'node:assert/strict';
import { COMPANY_ROLES, listLinks, parseLinks, readLinkOp, readUnlinkOp, removeLink, roleLabel, saveLink } from '../companyLinks';

let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
const reply = (status: number, payload: unknown) => ({ ok: status < 400, status, json: async () => payload }) as any;
const service = (answer: (url: string, init: any) => any) => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const fetchImpl = (async (url: string, init: any = {}) => { calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined }); return answer(String(url), init); }) as unknown as typeof fetch;
  return { calls, deps: { base: 'http://project/api/v1/projects/placemakers', headers: { Authorization: 'Bearer t', 'X-Tenant-ID': 'placemakers' }, fetchImpl } };
};
const good = { email: ' Hemi@Harlow.example ', companyId: ' ACC-0028 ', companyName: '  Harlow &  Talbot Landscapes Ltd ', role: 'account_admin' };

async function main() {
  console.log('what the page asks');
  await check('a link is a login, the company’s account id and name, and a role from the list; the login is lower-cased and the name tidied', () => {
    assert.deepEqual(readLinkOp(good), { email: 'hemi@harlow.example', companyId: 'ACC-0028', companyName: 'Harlow & Talbot Landscapes Ltd', role: 'account_admin' });
    for (const role of COMPANY_ROLES) assert.ok(!('error' in readLinkOp({ ...good, role: role.id })), role.id);
  });
  await check('anything else is refused with a reason: no role of our own, no spaces in an id, no login without an address, no empty name', () => {
    for (const bad of [null, {}, { ...good, role: 'owner' }, { ...good, role: 'admin' }, { ...good, email: 'not an address' }, { ...good, email: '' }, { ...good, companyId: 'ACC 28' },
      { ...good, companyId: '' }, { ...good, companyId: "ACC-1'; drop" }, { ...good, companyName: '' }, { ...good, companyName: 'x'.repeat(161) }, { ...good, role: undefined }]) {
      const got = readLinkOp(bad);
      assert.ok('error' in got && got.error.length > 10, JSON.stringify(bad)?.slice(0, 70));
    }
  });
  await check('unlinking names a login and a company', () => {
    assert.deepEqual(readUnlinkOp({ email: 'Hemi@Harlow.example', companyId: 'ACC-0028' }), { email: 'hemi@harlow.example', companyId: 'ACC-0028' });
    for (const bad of [null, {}, { email: 'x' }, { companyId: 'ACC-1' }, { email: 'a@b.c', companyId: '' }]) assert.ok('error' in readUnlinkOp(bad));
  });
  await check('roles have plain names', () => {
    assert.equal(roleLabel('account_admin'), 'Account administrator');
    assert.equal(roleLabel('job_viewer'), 'Job viewer');
    assert.equal(roleLabel('something_new'), 'something_new');
  });

  console.log('reading and saving');
  await check('the list is read with the person’s own token and only well-formed rows are kept', async () => {
    const s = service(() => reply(200, { links: [{ email: 'a@b.c', companyId: 'ACC-1', companyName: 'A Ltd', role: 'buyer', linkedBy: 'owner', linkedAt: 't' }, { email: 'bad', role: 'owner' }, null] }));
    const got = await listLinks(s.deps);
    assert.equal(got.status, 200);
    assert.deepEqual((got.body.links as any[]).map((l) => l.email), ['a@b.c']);
    assert.equal(s.calls[0].url, 'http://project/api/v1/projects/placemakers/company-links');
    assert.deepEqual(parseLinks('nonsense'), []);
  });
  await check('a person without permission is told so in plain words; a service that is down is a bad gateway, not a crash', async () => {
    assert.equal((await listLinks(service(() => reply(403, {})).deps)).status, 403);
    assert.equal((await saveLink(service(() => reply(403, {})).deps, readLinkOp(good) as any)).status, 403);
    assert.equal((await removeLink(service(() => reply(401, {})).deps, { email: 'a@b.c', companyId: 'ACC-1' })).status, 403);
    const down = { base: 'http://x', headers: {}, fetchImpl: (async () => { throw new Error('refused'); }) as unknown as typeof fetch };
    assert.equal((await listLinks(down)).status, 502);
    assert.equal((await saveLink(down, readLinkOp(good) as any)).status, 502);
    assert.equal((await removeLink(down, { email: 'a@b.c', companyId: 'ACC-1' })).status, 502);
  });
  await check('saving sends the cleaned link and a refusal from the service comes back with its own reason', async () => {
    const s = service(() => reply(200, { link: {} }));
    assert.equal((await saveLink(s.deps, readLinkOp(good) as any)).status, 200);
    assert.deepEqual(s.calls[0].body, { email: 'hemi@harlow.example', companyId: 'ACC-0028', companyName: 'Harlow & Talbot Landscapes Ltd', role: 'account_admin' });
    assert.equal(s.calls[0].method, 'PUT');
    const limit = await saveLink(service(() => reply(400, { message: 'One login may belong to at most 3 companies.' })).deps, readLinkOp(good) as any);
    assert.equal(limit.status, 400);
    assert.match(String(limit.body.error), /at most 3 companies/);
  });
  await check('unlinking says whether there was a link', async () => {
    const s = service(() => reply(200, { removed: true }));
    const got = await removeLink(s.deps, { email: 'a@b.c', companyId: 'ACC-1' });
    assert.deepEqual(got.body, { ok: true, removed: true });
    assert.equal(s.calls[0].method, 'DELETE');
    assert.deepEqual(s.calls[0].body, { email: 'a@b.c', companyId: 'ACC-1' });
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
