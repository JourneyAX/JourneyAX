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

  const toolsRange = [
    { name: 'Power Tool Accessories', productCount: 3574 }, { name: 'Hand Tools', productCount: 2952 },
    { name: 'Power Tools', productCount: 1188 }, { name: 'Outdoor Power Equipment', productCount: 290 }, { name: 'Tool Storage', productCount: 100 },
  ];
  const clarifyCtx = (extensions: Record<string, any> = { questionCards: { otherOptionLabel: 'Something else' } }): AgentToolContext => ({
    tenantId: 'test-tenant', environmentId: 'test', correlationId: 'c', catalogSearchHandler: new CatalogSearchHandler([] as any),
    release: { profile: { primaryCurrency: 'NZD', primaryLocale: 'en-NZ' }, extensions } as any,
    turnProductSkus: new Set(), catalogProductCache: new Map<string, any>(), readSourceIds: new Set(), allowedClaimClasses: new Set(), presentedCards: [], isHumanHandoffRequested: false,
    rangeShelves: toolsRange,
  } as any);
  const kindQuestion = (options: string[]) => ({ cardType: 'clarify', state: { questions: [{ id: 'kind', text: 'What sort of tools are you after?', options }, { id: 'job', text: 'What job are they for?', options: ['Building', 'Fixing', 'Measuring'] }] } });

  await suite.test('a question that offers the groups of a range but leaves out a big one is sent back, naming the group and its size', async () => {
    const ctx = clarifyCtx();
    const refused: any = await executeAgentTool('present_card', kindQuestion(['Tool box or organiser', 'Hand tools', 'Power tool accessories', 'Not sure']), ctx);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Power Tools \(1,188 products\)/);
    assert.doesNotMatch(refused.error, /Outdoor Power Equipment/, 'a small group is not required');
    assert.equal(ctx.presentedCards.length, 0, 'nothing was shown to the customer');
  });

  await suite.test('once every big group is a choice the card goes through with the shop\'s "something else" added, on the groups question only', async () => {
    const ctx = clarifyCtx();
    const ok: any = await executeAgentTool('present_card', kindQuestion(['Hand tools', 'Power tools', 'Accessories for power tools', 'Not sure']), ctx);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const [kind, job] = (ctx.presentedCards[0].state as any).questions;
    assert.deepEqual(kind.options, ['Hand tools', 'Power tools', 'Accessories for power tools', 'Not sure', 'Something else']);
    assert.deepEqual(job.options, ['Building', 'Fixing', 'Measuring'], 'a question that is not about the groups is left alone');
  });

  await suite.test('without the shop\'s words for "something else" none is added, and a question that is not about the groups is never checked', async () => {
    const ctx = clarifyCtx({});
    const ok: any = await executeAgentTool('present_card', kindQuestion(['Hand tools', 'Power tools', 'Accessories for power tools']), ctx);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal((ctx.presentedCards[0].state as any).questions[0].options.length, 3);
    const unrelated = clarifyCtx();
    const fine: any = await executeAgentTool('present_card', { cardType: 'clarify', state: { questions: [{ id: 'where', text: 'Where will you use it?', options: ['Indoors', 'Outdoors', 'On site'] }] } }, unrelated);
    assert.equal(fine.ok, true, JSON.stringify(fine));
    assert.deepEqual((unrelated.presentedCards[0].state as any).questions[0].options, ['Indoors', 'Outdoors', 'On site']);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
