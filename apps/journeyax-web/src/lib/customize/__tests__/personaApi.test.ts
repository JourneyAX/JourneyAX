/**
 * Reading the persona library and saving a scenario's tools through a pretend project service.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/personaApi.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readLibrary, readScenarioOp, saveScenarioTools } from '../personaApi';

let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const library = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/personas/placemakers-personas.json'), 'utf8'));
const reply = (status: number, payload: unknown) => ({ ok: status < 400, status, json: async () => payload }) as any;
const service = (answer: (url: string, init: any) => any) => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const fetchImpl = (async (url: string, init: any = {}) => { calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined }); return answer(String(url), init); }) as unknown as typeof fetch;
  return { calls, deps: { base: 'http://project/api/v1/projects/placemakers', headers: { Authorization: 'Bearer t', 'X-Tenant-ID': 'placemakers' }, fetchImpl } };
};

async function main() {
  console.log('what the page asks to save');

  await check('a scenario\'s tools: a use case, a list of tool names (duplicates dropped), and the version of the library that was on screen', () => {
    assert.deepEqual(readScenarioOp({ useCaseId: ' B01-UC01 ', tools: ['a.b', 'a.b', 'present_card'], expectedRevision: 4 }), { useCaseId: 'B01-UC01', tools: ['a.b', 'present_card'], expectedRevision: 4 });
    assert.deepEqual(readScenarioOp({ useCaseId: 'B01-UC01', tools: [], expectedRevision: 1 }), { useCaseId: 'B01-UC01', tools: [], expectedRevision: 1 }, 'an empty list clears the tools');
    for (const bad of [null, {}, { useCaseId: '', tools: [], expectedRevision: 1 }, { useCaseId: 'x'.repeat(65), tools: [], expectedRevision: 1 },
      { useCaseId: 'U', tools: 'a.b', expectedRevision: 1 }, { useCaseId: 'U', tools: ['has space'], expectedRevision: 1 }, { useCaseId: 'U', tools: [7], expectedRevision: 1 },
      { useCaseId: 'U', tools: Array.from({ length: 41 }, (_, i) => `a.t${i}`), expectedRevision: 1 }, { useCaseId: 'U', tools: [], expectedRevision: 0 },
      { useCaseId: 'U', tools: [], expectedRevision: 1.5 }, { useCaseId: 'U', tools: [] }]) {
      assert.ok('error' in readScenarioOp(bad), JSON.stringify(bad)?.slice(0, 60));
    }
  });

  console.log('reading');

  await check('the library comes through in the shape the page reads, from the project\'s own address, with the person\'s token', async () => {
    const s = service(() => reply(200, { present: true, projectId: 'placemakers', revision: 2, library, scenarioTools: { 'B01-UC01': ['salesforce.get_account'] }, updatedAt: 'x', updatedBy: 'y', checksum: 'z' }));
    const got = await readLibrary(s.deps);
    assert.equal(got.status, 200);
    assert.equal((got.body as any).present, true);
    assert.equal((got.body as any).library.useCases.length, 86);
    assert.deepEqual((got.body as any).scenarioTools, { 'B01-UC01': ['salesforce.get_account'] });
    assert.equal(s.calls[0].url, 'http://project/api/v1/projects/placemakers/persona-library');
    assert.equal((got.body as any).projectId, undefined, 'only what the page reads is passed on');
  });

  await check('nothing loaded yet is a plain answer', async () => {
    assert.deepEqual(await readLibrary(service(() => reply(200, { present: false })).deps), { status: 200, body: { present: false } });
  });

  await check('someone without permission is told so; a missing project, an unreachable or confused service are said plainly', async () => {
    assert.equal((await readLibrary(service(() => reply(403, { message: 'no' })).deps)).status, 403);
    assert.equal((await readLibrary(service(() => reply(401, {})).deps)).status, 403);
    const missing = await readLibrary(service(() => reply(404, { message: "Project 'x' not found." })).deps);
    assert.deepEqual([missing.status, missing.body.error], [404, "Project 'x' not found."]);
    assert.equal((await readLibrary(service(() => reply(500, {})).deps)).status, 502);
    assert.equal((await readLibrary(service(() => { throw new Error('down'); }).deps)).status, 502);
    const odd = await readLibrary(service(() => reply(200, { present: true, revision: 1 })).deps);
    assert.deepEqual([odd.status, /shape this page does not know/.test(String(odd.body.error))], [502, true]);
  });

  console.log('saving');

  await check('a save goes to the project service as a PUT with the use case, the tools and the revision, and the new revision comes back', async () => {
    const s = service(() => reply(200, { present: true, revision: 5, scenarioTools: ['a.b'], updatedAt: 'x' }));
    const done = await saveScenarioTools(s.deps, { useCaseId: 'B01-UC01', tools: ['a.b'], expectedRevision: 4 });
    assert.deepEqual(done, { status: 200, body: { ok: true, revision: 5, scenarioTools: ['a.b'] } });
    assert.deepEqual([s.calls[0].method, s.calls[0].url], ['PUT', 'http://project/api/v1/projects/placemakers/persona-library/scenario-tools']);
    assert.deepEqual(s.calls[0].body, { useCaseId: 'B01-UC01', tools: ['a.b'], expectedRevision: 4 });
  });

  await check('a change made by someone else meanwhile is a 409 with the reason; a refusal, a bad request and a missing use case keep their reason', async () => {
    const conflict = await saveScenarioTools(service(() => reply(409, { message: 'The persona library was changed since you loaded it. Reload and try again.' })).deps, { useCaseId: 'U', tools: [], expectedRevision: 1 });
    assert.deepEqual([conflict.status, conflict.body.error], [409, 'The persona library was changed since you loaded it. Reload and try again.']);
    const bad = await saveScenarioTools(service(() => reply(400, { message: ['The tools were not valid.', 'x'] })).deps, { useCaseId: 'U', tools: [], expectedRevision: 1 });
    assert.deepEqual([bad.status, bad.body.error], [400, 'The tools were not valid. x']);
    assert.equal((await saveScenarioTools(service(() => reply(404, { message: 'The library has no use case "U".' })).deps, { useCaseId: 'U', tools: [], expectedRevision: 1 })).status, 404);
    assert.equal((await saveScenarioTools(service(() => reply(403, {})).deps, { useCaseId: 'U', tools: [], expectedRevision: 1 })).status, 403);
    assert.equal((await saveScenarioTools(service(() => { throw new Error('down'); }).deps, { useCaseId: 'U', tools: [], expectedRevision: 1 })).status, 502);
    assert.equal((await saveScenarioTools(service(() => reply(500, {})).deps, { useCaseId: 'U', tools: [], expectedRevision: 1 })).status, 502);
  });

  console.log(`✅ web: persona library route helpers: ${passed} passed, 0 failed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
