import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createSuite, MemoryDb } from '@journeyax/test-support';
import { PERMISSION_KEY } from '../src/permission.guard';
import { ProjectController } from '../src/project.controller';
import { ProjectService } from '../src/project.service';
import { PERSONA_LIBRARY_COLLECTION, PersonaLibraryError, PersonaLibraryStore, checkPersonaLibrary } from '../src/persona-library';

/**
 * The persona library in the project database: what is accepted, how a newer import replaces the old without losing what people set, how a
 * save on top of a change you have not seen is refused, and who may read and change it.
 */
const library = () => JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/personas/placemakers-personas.json'), 'utf8'));
const suite = createSuite('project-service: the persona library store');
const rejects = async (fn: () => Promise<unknown>, code: PersonaLibraryError['code']) => {
  await assert.rejects(fn, (error: unknown) => error instanceof PersonaLibraryError && error.code === code, `expected ${code}`);
};

async function main() {
  await suite.test('the real library of the owner\'s sheets is accepted for the project it names, and for no other', () => {
    const ok = checkPersonaLibrary('placemakers', library());
    assert.equal(ok.ok, true);
    assert.equal((ok as any).library.personas.length, 43);
    const other = checkPersonaLibrary('someone-else', library());
    assert.equal(other.ok, false);
    assert.match((other as any).errors.join(' '), /is for "placemakers", not for "someone-else"/);
  });

  await suite.test('a library that does not hang together or is the wrong shape is refused with the reason', () => {
    const bad = (change: (l: any) => void) => { const l = library(); change(l); return checkPersonaLibrary('placemakers', l); };
    assert.equal(bad((l) => { l.personas[1].id = l.personas[0].id; }).ok, false);
    assert.equal(bad((l) => { l.useCases[0].personaId = 'Z99'; }).ok, false);
    assert.equal(bad((l) => { l.$schema = 'something-else'; }).ok, false);
    assert.equal(bad((l) => { l.personas[0].name = 42; }).ok, false);
    assert.equal(bad((l) => { l.useCases[0].story = 'x'.repeat(1001); }).ok, false);
    assert.equal(bad((l) => { l.personas = Array.from({ length: 301 }, (_, i) => ({ ...l.personas[0], id: `P${i}` })); }).ok, false);
    assert.equal(checkPersonaLibrary('placemakers', null).ok, false);
    assert.equal(checkPersonaLibrary('placemakers', 'text').ok, false);
    assert.equal(bad((l) => { l.extraField = { anything: true }; }).ok, true, 'fields the page does not read are carried, not refused');
  });

  await suite.test('the first save is revision 1 and keeps no scenario tools; reading it back gives exactly what was saved', async () => {
    const store = new PersonaLibraryStore(new MemoryDb().collection(PERSONA_LIBRARY_COLLECTION) as any, () => new Date('2026-10-26T01:00:00Z'));
    assert.equal(await store.get('placemakers'), null);
    const saved = await store.put('placemakers', library(), 'owner@example.com');
    assert.deepEqual({ revision: saved.revision, by: saved.updatedBy, at: saved.updatedAt, tools: saved.scenarioTools }, { revision: 1, by: 'owner@example.com', at: '2026-10-26T01:00:00.000Z', tools: {} });
    const read = (await store.get('placemakers'))!;
    assert.deepEqual(read.library, library());
    assert.match(read.checksum, /^[0-9a-f]{64}$/);
  });

  await suite.test('a newer library replaces the old, and the tools people set stay for every use case it still has and go for the ones it lost', async () => {
    const store = new PersonaLibraryStore(new MemoryDb().collection(PERSONA_LIBRARY_COLLECTION) as any);
    await store.put('placemakers', library(), 'a');
    await store.setScenarioTools('placemakers', 'B01-UC01', ['salesforce.get_account', 'commercetools.order_history'], 'a', 1);
    await store.setScenarioTools('placemakers', 'B02-UC01', ['salesforce.list_cases'], 'a', 2);
    const smaller = library();
    smaller.useCases = smaller.useCases.filter((u: any) => u.id !== 'B02-UC01');
    smaller.personas = smaller.personas.map((p: any) => ({ ...p, useCases: p.useCases.filter((id: string) => id !== 'B02-UC01') }));
    const next = await store.put('placemakers', smaller, 'b', 3);
    assert.equal(next.revision, 4);
    assert.deepEqual(next.scenarioTools, { 'B01-UC01': ['salesforce.get_account', 'commercetools.order_history'] });
    assert.equal(next.library.useCases.length, 85);
  });

  await suite.test('scenario tools: set, replaced, cleared with an empty list, and refused when the library, the use case, the tools or the revision are wrong', async () => {
    const store = new PersonaLibraryStore(new MemoryDb().collection(PERSONA_LIBRARY_COLLECTION) as any);
    await rejects(() => store.setScenarioTools('placemakers', 'B01-UC01', ['a.b'], 'a', 1), 'missing');
    await store.put('placemakers', library(), 'a');
    const checksum = (await store.get('placemakers'))!.checksum;
    const one = await store.setScenarioTools('placemakers', 'B01-UC01', ['salesforce.get_account', 'salesforce.get_account', 'present_card'], 'a', 1);
    assert.deepEqual(one.scenarioTools['B01-UC01'], ['salesforce.get_account', 'present_card'], 'duplicates are dropped');
    assert.equal(one.revision, 2);
    assert.equal((await store.get('placemakers'))!.checksum, checksum, 'the library itself is untouched');
    await rejects(() => store.setScenarioTools('placemakers', 'B01-UC01', ['x.y'], 'a', 1), 'conflict');
    await rejects(() => store.setScenarioTools('placemakers', 'NOPE-UC09', ['x.y'], 'a', 2), 'not_found');
    await rejects(() => store.setScenarioTools('placemakers', 'B01-UC01', ['has space'], 'a', 2), 'invalid');
    await rejects(() => store.setScenarioTools('placemakers', 'B01-UC01', 'salesforce.get_account', 'a', 2), 'invalid');
    await rejects(() => store.setScenarioTools('placemakers', 'B01-UC01', Array.from({ length: 41 }, (_, i) => `a.t${i}`), 'a', 2), 'invalid');
    const cleared = await store.setScenarioTools('placemakers', 'B01-UC01', [], 'a', 2);
    assert.deepEqual(cleared.scenarioTools, {});
  });

  await suite.test('the question to try a scenario: set (spaces tidied), replaced, cleared with empty text, and refused when the use case, the text or the revision is wrong', async () => {
    const store = new PersonaLibraryStore(new MemoryDb().collection(PERSONA_LIBRARY_COLLECTION) as any);
    await rejects(() => store.setScenarioPrompt('placemakers', 'B01-UC01', 'x', 'a', 1), 'missing');
    await store.put('placemakers', library(), 'a');
    const set = await store.setScenarioPrompt('placemakers', 'B01-UC01', '  Tell me   about\nKauri Builders  ', 'a', 1);
    assert.deepEqual([set.revision, set.scenarioPrompts], [2, { 'B01-UC01': 'Tell me about Kauri Builders' }]);
    assert.deepEqual((await store.get('placemakers'))!.scenarioTools, {}, 'the tools are untouched');
    await rejects(() => store.setScenarioPrompt('placemakers', 'B01-UC01', 'again', 'a', 1), 'conflict');
    await rejects(() => store.setScenarioPrompt('placemakers', 'NOPE-UC09', 'x', 'a', 2), 'not_found');
    await rejects(() => store.setScenarioPrompt('placemakers', 'B01-UC01', 42, 'a', 2), 'invalid');
    await rejects(() => store.setScenarioPrompt('placemakers', 'B01-UC01', 'x'.repeat(401), 'a', 2), 'invalid');
    const cleared = await store.setScenarioPrompt('placemakers', 'B01-UC01', '   ', 'a', 2);
    assert.deepEqual(cleared.scenarioPrompts, {});
  });

  await suite.test('a record saved before test questions existed reads as having none, and a newer library keeps the questions of the use cases it still has', async () => {
    const db = new MemoryDb();
    await db.collection(PERSONA_LIBRARY_COLLECTION).insertOne({ projectId: 'placemakers', revision: 1, library: library(), scenarioTools: {}, checksum: 'x', updatedAt: 'x', updatedBy: 'x' } as any);
    const store = new PersonaLibraryStore(db.collection(PERSONA_LIBRARY_COLLECTION) as any);
    assert.deepEqual((await store.get('placemakers'))!.scenarioPrompts, {});
    await store.setScenarioPrompt('placemakers', 'B01-UC01', 'one', 'a', 1);
    await store.setScenarioPrompt('placemakers', 'B02-UC01', 'two', 'a', 2);
    const smaller = library();
    smaller.useCases = smaller.useCases.filter((u: any) => u.id !== 'B02-UC01');
    smaller.personas = smaller.personas.map((p: any) => ({ ...p, useCases: p.useCases.filter((id: string) => id !== 'B02-UC01') }));
    assert.deepEqual((await store.put('placemakers', smaller, 'b', 3)).scenarioPrompts, { 'B01-UC01': 'one' });
  });

  await suite.test('a save on top of a change you have not seen is refused (by revision), and so is one that loses a race at the last moment', async () => {
    const db = new MemoryDb();
    const store = new PersonaLibraryStore(db.collection(PERSONA_LIBRARY_COLLECTION) as any);
    await store.put('placemakers', library(), 'a');
    await rejects(() => store.put('placemakers', library(), 'b', 7), 'conflict');
    const racing = db.collection(PERSONA_LIBRARY_COLLECTION) as any;
    const realUpdate = racing.updateOne.bind(racing);
    racing.updateOne = async (filter: any, update: any, options: any) => { await realUpdate({ projectId: 'placemakers' }, { $set: { revision: 99 } }); return realUpdate(filter, update, options); };
    await rejects(() => new PersonaLibraryStore(racing).setScenarioTools('placemakers', 'B01-UC01', ['a.b'], 'c', 1), 'conflict');
  });

  await suite.test('the project service gives out the store on its own collection and refuses when there is no database', async () => {
    const service = new ProjectService();
    assert.throws(() => service.getPersonaLibraryStore(), /not connected/);
    const db = new MemoryDb();
    service.setDbForTesting(db);
    await service.getPersonaLibraryStore().put('placemakers', library(), 'a');
    assert.equal((await db.collection(PERSONA_LIBRARY_COLLECTION).findOne({ projectId: 'placemakers' }))?.revision, 1);
  });

  await suite.test('the routes: four of them, all needing permission to edit the configuration, answering with the right kind of error', async () => {
    const db = new MemoryDb();
    await db.collection('tenant_configs').insertOne({ projectId: 'placemakers', name: 'PlaceMakers', status: 'active', orgId: 'org' } as any);
    const service = new ProjectService();
    service.setDbForTesting(db);
    const controller = new ProjectController(service as any);
    for (const name of ['getPersonaLibrary', 'putPersonaLibrary', 'putScenarioTools', 'putScenarioPrompt'] as const) {
      assert.equal(Reflect.getMetadata(PERMISSION_KEY, (ProjectController.prototype as any)[name]), 'config.edit', name);
    }
    assert.deepEqual(await controller.getPersonaLibrary('placemakers'), { present: false });
    await assert.rejects(() => controller.getPersonaLibrary('ghost'), NotFoundException);
    await assert.rejects(() => controller.putPersonaLibrary('placemakers', { library: { nope: true } }, 'u'), BadRequestException);
    const saved = await controller.putPersonaLibrary('placemakers', { library: library() }, 'owner@example.com');
    assert.equal(saved.revision, 1);
    const read: any = await controller.getPersonaLibrary('placemakers');
    assert.equal(read.present, true);
    assert.equal(read.updatedBy, 'owner@example.com');
    await assert.rejects(() => controller.putPersonaLibrary('placemakers', { library: library(), expectedRevision: 5 }, 'u'), ConflictException);
    const tools = await controller.putScenarioTools('placemakers', { useCaseId: 'B01-UC01', tools: ['salesforce.get_account'], expectedRevision: 1 }, 'u');
    assert.deepEqual(tools.scenarioTools, ['salesforce.get_account']);
    await assert.rejects(() => controller.putScenarioTools('placemakers', { useCaseId: 'B01-UC01', tools: [], expectedRevision: 1 }, 'u'), ConflictException);
    await assert.rejects(() => controller.putScenarioTools('placemakers', { useCaseId: 'NOPE', tools: [], expectedRevision: 2 }, 'u'), NotFoundException);
    await assert.rejects(() => controller.putScenarioTools('placemakers', { tools: [] } as any, 'u'), BadRequestException);
    const prompt = await controller.putScenarioPrompt('placemakers', { useCaseId: 'B01-UC01', prompt: 'Brief me on Kauri Builders', expectedRevision: 2 }, 'u');
    assert.deepEqual([prompt.revision, prompt.scenarioPrompt], [3, 'Brief me on Kauri Builders']);
    await assert.rejects(() => controller.putScenarioPrompt('placemakers', { useCaseId: 'B01-UC01', prompt: 'x', expectedRevision: 1 }, 'u'), ConflictException);
    await assert.rejects(() => controller.putScenarioPrompt('placemakers', { useCaseId: 'NOPE', prompt: 'x', expectedRevision: 3 }, 'u'), NotFoundException);
    await assert.rejects(() => controller.putScenarioPrompt('placemakers', { prompt: 'x' } as any, 'u'), BadRequestException);
    await assert.rejects(() => controller.putScenarioPrompt('placemakers', { useCaseId: 'B01-UC01', prompt: 7, expectedRevision: 3 }, 'u'), BadRequestException);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
