import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { normaliseCardState } from '../src/agent/card-state';
import { executeAgentTool, type AgentToolContext } from '../src/agent/agent-tools';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';
import { CARD_TYPES } from '@journeyax/ui-cards';

const suite = createSuite('runtime: card state written in a slightly different shape');

async function main() {
  await suite.test('an accessories card written with titles and SKU strings is put into shape, and nothing is added', () => {
    const state = normaliseCardState('accessories', {
      forSku: 'P1',
      groups: [{ title: 'Jointing sand', purpose: 'For filling the joints.', skus: ['S1', ' S2 '] }, { key: 'edging', label: 'Edging', items: [{ sku: 'E1', reason: 'Holds the edge' }, 'E2', { title: 'no sku' }] }],
    });
    assert.deepEqual(state.groups[0], { key: 'jointing-sand', label: 'Jointing sand', hint: 'For filling the joints.', items: [{ sku: 'S1' }, { sku: 'S2' }] });
    assert.deepEqual(state.groups[1].items, [{ sku: 'E1', reason: 'Holds the edge' }, { sku: 'E2' }], 'an entry with no SKU is dropped');
    assert.equal(state.groups[1].key, 'edging', 'a key that was given is kept');
  });

  await suite.test('a quantity card written with the SKU at the top, and a products card written as a list of SKUs, are put into shape', () => {
    assert.deepEqual(normaliseCardState('quantity', { sku: 'P1', title: 'x', units: 5 }).product, { sku: 'P1' });
    assert.deepEqual(normaliseCardState('quantity', { product: 'P2' }).product, { sku: 'P2' });
    assert.deepEqual(normaliseCardState('quantity', { product: { sku: 'P3', title: 'kept' } }).product, { sku: 'P3', title: 'kept' });
    assert.deepEqual(normaliseCardState('products', { skus: ['A', 'B'] }).products, [{ sku: 'A' }, { sku: 'B' }]);
    assert.deepEqual(normaliseCardState('products', { products: ['A', { sku: 'B', reason: 'r' }] }).products, [{ sku: 'A' }, { sku: 'B', reason: 'r' }]);
  });

  await suite.test('anything that is not an object becomes an empty state, and other card types are left alone', () => {
    assert.deepEqual(normaliseCardState('clarify', undefined), {});
    assert.deepEqual(normaliseCardState('clarify', 'oops'), {});
    const questions = [{ id: 'a', text: 'Q', options: ['x'] }];
    assert.deepEqual(normaliseCardState('clarify', { questions }).questions, questions);
  });

  await suite.test('a number question keeps the usual range it was given, so the customer can be asked "did you mean…?"', () => {
    const parsed = CARD_TYPES.clarify.state.parse({ questions: [{ id: 'height', text: 'How high?', inputType: 'number', unit: 'm', min: 1, max: 6 }] });
    assert.equal(parsed.questions[0].min, 1);
    assert.equal(parsed.questions[0].max, 6);
    assert.equal(CARD_TYPES.clarify.state.safeParse({ questions: [{ id: 'h', text: 'How high?', inputType: 'number', min: 'low' }] }).success, false, 'a range that is not a number is refused');
  });

  await suite.test('present_card accepts the plain variants and still refuses a SKU no tool returned', async () => {
    const product = (sku: string, name: string) => ({ projectId: 'test-tenant', sku, parentSku: sku, name, title: name, category: 'Paving', categoryPath: ['Outdoor', 'Paving'], price: { amount: 12, currency: 'NZD' }, inStock: true });
    const ctx: AgentToolContext = {
      tenantId: 'test-tenant', environmentId: 'test', correlationId: 'c', catalogSearchHandler: new CatalogSearchHandler([product('P1', 'Paver'), product('S1', 'Jointing Sand')] as any),
      release: { profile: { primaryCurrency: 'NZD' }, extensions: {} } as any,
      turnProductSkus: new Set(['P1', 'S1']), catalogProductCache: new Map<string, any>([['P1', { sku: 'P1', title: 'Paver', price: 12, inStock: true }], ['S1', { sku: 'S1', title: 'Jointing Sand', price: 5, inStock: true }]]), readSourceIds: new Set(), allowedClaimClasses: new Set(), presentedCards: [], isHumanHandoffRequested: false,
    };
    const ok: any = await executeAgentTool('present_card', { cardType: 'accessories', state: { forSku: 'P1', groups: [{ title: 'Jointing sand', skus: ['S1'] }] } }, ctx);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal((ctx.presentedCards[0].state as any).groups[0].items[0].sku, 'S1');
    const refused: any = await executeAgentTool('present_card', { cardType: 'accessories', state: { forSku: 'P1', groups: [{ title: 'Made up', skus: ['NOT-A-REAL-SKU'] }] } }, ctx);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /NOT-A-REAL-SKU/);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
