import 'reflect-metadata';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createSuite, MemoryDb } from '@journeyax/test-support';
import { PERMISSION_KEY } from '../src/permission.guard';
import { ProjectController } from '../src/project.controller';
import { ProjectService } from '../src/project.service';
import { COMPANY_LINK_COLLECTION, CompanyLinkError, CompanyLinkStore, MAX_COMPANIES_PER_LOGIN } from '../src/company-links';

/**
 * Which company a trade customer's login is linked to: what a link must look like, that a login is looked up only by its own address,
 * that one login cannot collect companies, and who may set a link and who may only ask.
 */
const suite = createSuite('project-service: company links for trade customers');
const newStore = () => new CompanyLinkStore(new MemoryDb().collection(COMPANY_LINK_COLLECTION) as any, () => new Date('2026-10-26T02:00:00Z'));
const rejects = async (fn: () => Promise<unknown>, code: CompanyLinkError['code']) => {
  await assert.rejects(fn, (error: unknown) => error instanceof CompanyLinkError && error.code === code, `expected ${code}`);
};
const hemi = { email: 'Hemi@Talbot.example', companyId: 'ACC-0001', companyName: 'Talbot & Nguyen Concrete Ltd', role: 'job_viewer' };

async function main() {
  await suite.test('a link is stored by the login in lower case, and the company comes back for that login only', async () => {
    const store = newStore();
    const saved = await store.link('placemakers', hemi, 'owner@example.com');
    assert.deepEqual({ email: saved.email, by: saved.linkedBy, at: saved.linkedAt }, { email: 'hemi@talbot.example', by: 'owner@example.com', at: '2026-10-26T02:00:00.000Z' });
    assert.deepEqual(await store.lookup('placemakers', 'HEMI@talbot.example'), [{ id: 'ACC-0001', name: 'Talbot & Nguyen Concrete Ltd', role: 'job_viewer' }]);
    assert.deepEqual(await store.lookup('placemakers', 'someone.else@talbot.example'), [], 'a colleague at the same company is not linked by that');
    assert.deepEqual(await store.lookup('another-project', 'hemi@talbot.example'), [], 'a link belongs to its project');
  });

  await suite.test('a lookup with something that is not a login address finds nothing, however it is written', async () => {
    const store = newStore();
    await store.link('placemakers', hemi, 'a');
    for (const odd of [undefined, null, '', 42, {}, ['hemi@talbot.example'], 'anonymous', 'guest', '*', '.*', { $ne: '' }]) assert.deepEqual(await store.lookup('placemakers', odd), [], JSON.stringify(odd));
  });

  await suite.test('linking again changes the role instead of adding a second row', async () => {
    const store = newStore();
    await store.link('placemakers', hemi, 'a');
    await store.link('placemakers', { ...hemi, role: 'account_admin' }, 'b');
    const all = await store.list('placemakers');
    assert.equal(all.length, 1);
    assert.equal(all[0].role, 'account_admin');
    assert.equal(all[0].linkedBy, 'b');
  });

  await suite.test('what is not a company link is refused with the reason: no role of our own invention, no empty id, no spaces in a login', async () => {
    const store = newStore();
    await rejects(() => store.link('placemakers', { ...hemi, role: 'owner' }, 'a'), 'invalid');
    await rejects(() => store.link('placemakers', { ...hemi, role: 'admin' }, 'a'), 'invalid');
    await rejects(() => store.link('placemakers', { ...hemi, companyId: '' }, 'a'), 'invalid');
    await rejects(() => store.link('placemakers', { ...hemi, companyId: 'ACC 0001; drop' }, 'a'), 'invalid');
    await rejects(() => store.link('placemakers', { ...hemi, companyName: '' }, 'a'), 'invalid');
    await rejects(() => store.link('placemakers', { ...hemi, email: 'not an address' }, 'a'), 'invalid');
    await rejects(() => store.link('placemakers', null, 'a'), 'invalid');
    assert.deepEqual(await store.list('placemakers'), []);
  });

  await suite.test('one login belongs to a few companies at most', async () => {
    const store = newStore();
    for (let i = 1; i <= MAX_COMPANIES_PER_LOGIN; i++) await store.link('placemakers', { ...hemi, companyId: `ACC-000${i}` }, 'a');
    await rejects(() => store.link('placemakers', { ...hemi, companyId: 'ACC-0099' }, 'a'), 'limit');
    await store.link('placemakers', { ...hemi, companyId: 'ACC-0002', role: 'buyer' }, 'a');
    assert.equal((await store.lookup('placemakers', hemi.email)).length, MAX_COMPANIES_PER_LOGIN);
  });

  await suite.test('unlinking removes that one link and says whether there was one', async () => {
    const store = newStore();
    await store.link('placemakers', hemi, 'a');
    await store.link('placemakers', { ...hemi, email: 'ana@talbot.example' }, 'a');
    assert.equal(await store.unlink('placemakers', 'hemi@talbot.example', 'ACC-0001'), true);
    assert.equal(await store.unlink('placemakers', 'hemi@talbot.example', 'ACC-0001'), false);
    assert.deepEqual((await store.list('placemakers')).map((row) => row.email), ['ana@talbot.example']);
    await rejects(() => store.unlink('placemakers', 'nonsense', 'ACC-0001'), 'invalid');
    await rejects(() => store.unlink('placemakers', 'ana@talbot.example', ''), 'invalid');
  });

  await suite.test('the routes: setting and listing links needs permission to edit the configuration, only the lookup is open to a reader', async () => {
    const db = new MemoryDb();
    await db.collection('tenant_configs').insertOne({ projectId: 'placemakers', name: 'PlaceMakers', status: 'active', orgId: 'org' } as any);
    const service = new ProjectService();
    service.setDbForTesting(db);
    const controller = new ProjectController(service as any);
    const permission = (name: string) => Reflect.getMetadata(PERMISSION_KEY, (ProjectController.prototype as any)[name]);
    for (const name of ['listCompanyLinks', 'putCompanyLink', 'deleteCompanyLink']) assert.equal(permission(name), 'config.edit', name);
    assert.equal(permission('lookupCompanyLinks'), 'project.read');
    await assert.rejects(() => controller.listCompanyLinks('ghost'), NotFoundException);
    await assert.rejects(() => controller.putCompanyLink('placemakers', { ...hemi, role: 'owner' }, 'u'), BadRequestException);
    const done: any = await controller.putCompanyLink('placemakers', hemi, 'owner@example.com');
    assert.equal(done.link.companyId, 'ACC-0001');
    assert.equal((await controller.listCompanyLinks('placemakers')).links.length, 1);
    assert.deepEqual((await controller.lookupCompanyLinks('placemakers', { email: 'hemi@talbot.example' })).companies.map((c) => c.id), ['ACC-0001']);
    assert.deepEqual((await controller.lookupCompanyLinks('placemakers', { email: undefined })).companies, []);
    assert.deepEqual(await controller.deleteCompanyLink('placemakers', { email: 'hemi@talbot.example', companyId: 'ACC-0001' }), { removed: true });
    await assert.rejects(() => controller.deleteCompanyLink('placemakers', { email: 'x', companyId: 'y' }), BadRequestException);
  });
}

main().catch((error) => { console.error(error); process.exit(1); });
