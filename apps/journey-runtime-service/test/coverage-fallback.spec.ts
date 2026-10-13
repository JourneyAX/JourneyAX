import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { publishOkfRelease } from '@journeyax/knowledge';
import { OkfKnowledgeControlPlane } from '../src/kernel/knowledge-control-plane';
import { probeCatalogue } from '../src/kernel/catalogue-probe';
import { buildOkfContent } from '../../../packages/knowledge/test/fixtures';

const suite = createSuite('runtime: uncovered requests classify first, never a blanket allow');

const OPEN = { coverage: { uncoveredShopping: { mode: 'catalogue_only', commerce: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' } } } };
const products = [
  { projectId: 'placemakers', sku: 'PB-1', name: 'Paint Brush Synthetic 50mm', category: 'Brushes', currency: 'NZD' },
  { projectId: 'placemakers', sku: 'PB-2', name: 'Old Style Paint Brush', category: 'Brushes', discontinued: true },
  { projectId: 'placemakers', sku: 'H-1', name: 'Fan Heater 2kW', category: 'Heaters' },
  { projectId: 'other-tenant', sku: 'W-1', name: 'Wheelbarrow Heavy Duty', category: 'Garden' },
];

async function setup(policy?: unknown) {
  const db = new MemoryDb();
  await db.collection('products').insertMany(products as any);
  const content: any = structuredClone(buildOkfContent());
  if (policy) content.policy = policy;
  const release = await publishOkfRelease(db as any, {
    releaseId: `okf-${policy ? 'open' : 'closed'}`, tenantId: 'placemakers', environmentId: 'test', version: '1.0.0', content, publishedBy: 'test',
  });
  const touched: string[] = [];
  const tracked = { collection: (name: string, ...rest: unknown[]) => { touched.push(name); return (db as any).collection(name, ...rest); } };
  const plane = new OkfKnowledgeControlPlane(async () => tracked as any);
  const pack: any = {
    knowledgeModel: { type: 'okf_release', modelId: content.modelId, releaseId: release.releaseId, version: release.version, checksum: release.checksum, required: true, failurePolicy: 'fail_closed' },
    profile: {},
  };
  const evaluate = (message: string, workspace: any = null) => plane.evaluate(
    pack, { tenantId: 'placemakers', environmentId: 'test', workspaceId: 'w', sessionId: 'w', correlationId: 'c', message } as any, workspace,
    { intent: 'process_turn', candidateFacts: {} } as any,
  );
  return { evaluate, touched, release, db };
}

const blockedEverything = (d: any) => {
  assert.equal(d.retrieval.permission, 'blocked'); assert.equal(d.commerce.addToCart, 'blocked'); assert.equal(d.commerce.checkout, 'blocked');
  assert.deepEqual(d.claims.allowedClasses, []);
};

async function main() {
  await suite.test('by default an uncovered shopping request is blocked and the catalogue is not even probed', async () => {
    const { evaluate, touched } = await setup();
    const d: any = await evaluate('i need some paint brushes');
    assert.equal(d.mode, 'no_match'); blockedEverything(d); assert.ok(d.trace.reasonCodes.includes('uncovered_shopping_blocked'));
    const bare: any = await evaluate('paint brushes');
    assert.ok(bare.trace.reasonCodes.includes('uncovered_unknown'));
    assert.equal(touched.filter((name) => name === 'products').length, 0, 'no live catalogue probe unless the release opted in');
  });

  await suite.test('with the opt-in a shopping request shows catalogue facts only, under the restricted commerce policy', async () => {
    const { evaluate } = await setup(OPEN);
    const d: any = await evaluate('i need some paint brushes');
    assert.equal(d.mode, 'legacy_search'); assert.equal(d.retrieval.permission, 'allowed');
    assert.deepEqual(d.claims.allowedClasses, ['catalog_fact']);
    assert.deepEqual(d.commerce, { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' });
    assert.equal(d.catalogHandling.requiresLiveValidation, true);
  });

  await suite.test('a bare noun is shopping only if the live catalogue lists it for this tenant', async () => {
    const { evaluate } = await setup(OPEN);
    const listed: any = await evaluate('paint brushes');
    assert.equal(listed.mode, 'legacy_search'); assert.ok(listed.trace.reasonCodes.includes('catalogue_probe_matched'));
    for (const text of ['wheelbarrow', 'zzxqv', 'hello there']) {
      const d: any = await evaluate(text);
      assert.equal(d.mode, 'no_match', text); blockedEverything(d);
    }
  });

  await suite.test('discontinued products are not evidence, and long free text is never probed', async () => {
    const { db } = await setup(OPEN);
    const probe = (message: string) => probeCatalogue(async () => db as any, { tenantId: 'placemakers', message });
    assert.equal(await probe('old style paint brush'), false, 'the only match is discontinued');
    assert.equal(await probe('paint brush'), true);
    assert.equal(await probe('i would like to paint a brush stroke on the fence next to the heater please thanks'), false);
    assert.equal(await probe(''), false);
    assert.equal(await probeCatalogue(async () => { throw new Error('db down'); }, { tenantId: 'placemakers', message: 'paint brush' }), false, 'failure is no evidence');
  });

  await suite.test('a hazard escalates even when the catalogue lists a matching product and shopping is open', async () => {
    const { evaluate } = await setup(OPEN);
    for (const text of ['my fan heater is smoking', 'i can smell gas near the heater', 'there is water near the power points']) {
      const d: any = await evaluate(text);
      assert.equal(d.mode, 'safety_then_diagnose', text);
      assert.equal(d.safety.guidanceUnavailable, true); blockedEverything(d);
    }
  });

  await suite.test('an unknown technical requirement gets no claims and no products', async () => {
    const { evaluate } = await setup(OPEN);
    const d: any = await evaluate('is the fan heater suitable for a workshop');
    assert.equal(d.mode, 'no_match'); blockedEverything(d); assert.ok(d.trace.reasonCodes.includes('uncovered_technical'));
  });

  await suite.test('an answer to a pending clarification keeps its conversation, never reclassified as shopping', async () => {
    const { evaluate, release } = await setup(OPEN);
    const screws = release.content.concepts.find((concept) => concept.conceptId.endsWith('/fastenings/screws'))!;
    const retained = {
      knowledgeContext: { releaseId: release.releaseId, checksum: release.checksum, conceptId: screws.conceptId, selectedAt: new Date().toISOString() },
      pins: { okfReleaseId: release.releaseId, okfChecksum: release.checksum },
      openQuestions: ['substrate'], facts: {},
    };
    const answer: any = await evaluate('timber', retained);
    assert.ok(answer.trace.reasonCodes.includes('clarification_answer_continuity'));
    const vague: any = await evaluate('yes please', retained);
    assert.ok(vague.trace.reasonCodes.includes('workspace_concept_continuity'));
    assert.ok(!vague.trace.reasonCodes.includes('catalogue_probe_matched'));
  });

  await suite.test('a governed concept still wins over the coverage setting', async () => {
    const { evaluate } = await setup(OPEN);
    const d: any = await evaluate('i need screws');
    assert.equal(d.mode, 'overview_then_ask'); assert.ok(!d.trace.reasonCodes.some((code: string) => code.startsWith('uncovered_')));
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
