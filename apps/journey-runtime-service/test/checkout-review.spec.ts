import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { buildReview, DEFAULT_REVIEW_LABELS, type ReviewLine } from '../src/agent/checkout-review';
import { executeAgentTool, type AgentToolContext } from '../src/agent/agent-tools';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';
import { prefetchCallsFor } from '../src/agent/event-prefetch';
import { resolveCustomerEventAction } from '../src/kernel/customer-event-policy';

const suite = createSuite('runtime: the last look before payment');

const line = (over: Partial<ReviewLine> & { sku: string; title: string }): ReviewLine => ({ quantity: 1, ...over });

const shop = (extensions: Record<string, any> = { checkoutReview: { enabled: true, deliveryLabels: { clickAndCollect: 'Click & Collect', courier: 'Courier delivery' } } }): AgentToolContext => {
  const product = (sku: string, name: string, extra: Record<string, any> = {}) => ({ projectId: 'test-tenant', sku, parentSku: sku, name, title: name, category: 'Outdoor', categoryPath: ['Outdoor'], price: { amount: 10, currency: 'NZD' }, inStock: true, ...extra });
  const products = [
    product('P1', 'Forum Paver 400 x 400 x 50mm Glacier', { pickupOnly: true, deliveryOptions: ['clickAndCollect'], stock: { availableBranchCount: 8, branchCount: 87 } }),
    product('S1', 'Jointing Sand 20kg', { deliveryOptions: ['courier', 'clickAndCollect'] }),
    product('D1', 'Retired Edging', { discontinued: true }),
  ];
  return {
    tenantId: 'test-tenant', environmentId: 'test', correlationId: 'c', catalogSearchHandler: new CatalogSearchHandler(products as any),
    release: { profile: { primaryCurrency: 'NZD' }, extensions } as any,
    turnProductSkus: new Set(), catalogProductCache: new Map(), readSourceIds: new Set(), allowedClaimClasses: new Set(), presentedCards: [], isHumanHandoffRequested: false,
  };
};

async function main() {
  await suite.test('a paver sold by the piece says what the number covers, and asks if that is the area', () => {
    const review = buildReview({ lines: [line({ sku: 'P1', title: 'Forum Paver 400 x 400 x 50mm Glacier', quantity: 83 })], suggestions: [] });
    const row = review.quantity.rows[0];
    assert.equal(row.title, '83 × Forum Paver 400 x 400 x 50mm Glacier');
    assert.match(row.detail!, /Covers about 13\.3 m²/);
    assert.match(row.detail!, /each piece covers 0\.16 m²/);
    assert.equal(row.warn, true);
    assert.equal(row.hasMessage, true);
    assert.match(row.actionText!, /Forum Paver/);
    assert.equal(review.quantity.warn, true);
  });

  await suite.test('a pack with a stated coverage says what the packs cover; a product with neither is left as the customer chose it', () => {
    const review = buildReview({
      lines: [line({ sku: 'T1', title: 'Primer 1 Litre Kit', quantity: 3, coverageTexts: ['Primer in a 1 Litre container, offers 10 m-sq coverage'] }), line({ sku: 'X', title: 'Screwdriver Set' })],
      suggestions: [], coveragePatterns: ['offers\\s+(\\d+(?:\\.\\d+)?)\\s*m-?sq\\s+coverage'],
    });
    assert.match(review.quantity.rows[0].detail!, /Covers about 30 m²/);
    assert.match(review.quantity.rows[0].detail!, /one pack covers 10 m²/);
    assert.equal(review.quantity.rows[1].detail, DEFAULT_REVIEW_LABELS.quantityAsChosen);
    assert.equal(review.quantity.rows[1].warn, false);
  });

  await suite.test('what the order may still need leaves out what is already in it, caps the list, and offers an add button for each', () => {
    const review = buildReview({
      lines: [line({ sku: 'P1', title: 'Paver' })],
      suggestions: [{ sku: 'P1', title: 'Paver' }, { sku: 'S1', title: 'Jointing Sand', reason: 'For the joints' }, { sku: 'S2', title: 'Edging' }, { sku: 'S3', title: 'Weedmat' }],
      maxAccessories: 2,
    });
    assert.deepEqual(review.accessories.rows.map((r) => r.actionSku), ['S1', 'S2']);
    assert.equal(review.accessories.rows[0].hasAdd, true);
    assert.equal(review.accessories.rows[0].hasMessage, false);
    const none = buildReview({ lines: [line({ sku: 'P1', title: 'Paver' })], suggestions: [{ sku: 'P1', title: 'Paver' }] });
    assert.deepEqual(none.accessories.rows, []);
    assert.equal(none.accessories.ok, true);
  });

  await suite.test('pick-up only and thin stock are flagged, delivery words are the shop\'s own, and a chosen branch is named', () => {
    const labels = { courier: 'Courier delivery', clickAndCollect: 'Click & Collect' };
    const review = buildReview({
      lines: [line({ sku: 'P1', title: 'Paver', pickupOnly: true, branchesAvailable: 8, branchesTotal: 87 }), line({ sku: 'S1', title: 'Sand', deliveryOptions: ['courier', 'clickAndCollect'], branchesAvailable: 70, branchesTotal: 87, branchStatus: 'In Stock' })],
      suggestions: [], deliveryLabels: labels, branch: { id: '600', name: 'Takapuna' },
    });
    const [paver, sand] = review.fulfilment.rows;
    assert.match(paver.detail!, /Pick-up only/);
    assert.match(paver.detail!, /In stock at 8 of 87 branches/);
    assert.equal(paver.warn, true);
    assert.match(sand.detail!, /Courier delivery or Click & Collect/);
    assert.match(sand.detail!, /At Takapuna: In Stock/);
    assert.equal(sand.warn, false);
    const noBranch = buildReview({ lines: [line({ sku: 'P1', title: 'Paver', pickupOnly: true })], suggestions: [] });
    assert.equal(noBranch.fulfilment.rows[0].actionLabel, DEFAULT_REVIEW_LABELS.chooseBranch, 'with no branch chosen, a pick-up-only item offers to choose one');
    const fallback = buildReview({ lines: [line({ sku: 'P1', title: 'Paver', deliveryOptions: ['standardDelivery'] })], suggestions: [] });
    assert.match(fallback.fulfilment.rows[0].detail!, /Standard delivery/, 'a code the shop did not word is made readable');
  });

  await suite.test('warranty and guides: what is on file is said, what is not is said honestly, and each has a button', () => {
    const review = buildReview({
      lines: [line({ sku: 'A', title: 'With warranty', warranty: 'Fifteen years against manufacturing faults.', guides: ['Installation Guide'] }), line({ sku: 'B', title: 'Without' })],
      suggestions: [],
    });
    const [a, b] = review.warranty.rows;
    assert.match(a.detail!, /Warranty on file: Fifteen years/);
    assert.match(a.detail!, /Guide available: Installation Guide/);
    assert.equal(a.ok, true);
    assert.equal(a.actionLabel, DEFAULT_REVIEW_LABELS.explainGuide);
    assert.match(b.detail!, /No warranty details on file yet/);
    assert.equal(b.warn, true);
    assert.equal(b.actionLabel, DEFAULT_REVIEW_LABELS.askWarranty);
    assert.equal(review.warranty.warn, true);
  });

  await suite.test('the summary counts the sections that look right and the shop\'s own wording replaces the defaults', () => {
    const calm = buildReview({ lines: [line({ sku: 'S1', title: 'Sand', warranty: 'Five years', deliveryOptions: ['courier'] })], suggestions: [] });
    assert.equal(calm.summary, 'All 4 checks look right');
    const busy = buildReview({ lines: [line({ sku: 'P1', title: 'Paver 400 x 400', quantity: 10 })], suggestions: [], labels: { heading: 'Ready to pay?', pay: 'Pay now' } });
    assert.match(busy.summary, /of 4 checks look right/);
    assert.equal(busy.heading, 'Ready to pay?');
    assert.equal(busy.payLabel, 'Pay now');
  });

  await suite.test('review_cart builds the findings from the order the customer\'s tap carries and only from catalogue products', async () => {
    const ctx = shop();
    ctx.customerEvent = { type: 'reviewCart', payload: { title: 'my order', items: [{ sku: 'P1', quantity: 83, stock: { status: 'Low Stock' } }, { sku: 'S1', quantity: 2 }, { sku: 'NOPE', quantity: 1 }, { sku: 'P1', quantity: 5 }], branch: { id: '600', name: 'Takapuna' } } };
    const result: any = await executeAgentTool('review_cart', {}, ctx);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.lines, 2, 'an unknown product is left out and a repeated one is counted once');
    assert.ok(ctx.lastReview);
    const quantityRow = ctx.lastReview!.quantity.rows.find((r) => r.key === 'q-P1')!;
    assert.match(quantityRow.title, /^83 ×/);
    const fulfilment = ctx.lastReview!.fulfilment.rows.find((r) => r.key === 'f-P1')!;
    assert.match(fulfilment.detail!, /Pick-up only/);
    assert.match(fulfilment.detail!, /At Takapuna: Low Stock/);
    assert.ok(result.sections.length === 4 && result.message.includes('warm sentences'));
    // The card shows only this review, whatever the model writes.
    const card: any = await executeAgentTool('present_card', { cardType: 'review', state: { heading: 'Anything I like', quantity: { title: 'x' } } }, ctx);
    assert.equal(card.ok, true, JSON.stringify(card));
    const shown: any = ctx.presentedCards[0].state;
    assert.equal(shown.heading, ctx.lastReview!.heading);
    assert.equal(shown.quantity.rows[0].key, 'q-P1');
  });

  await suite.test('review_cart refuses what it cannot honestly review, and a review card needs a review first', async () => {
    const ctx = shop();
    const empty: any = await executeAgentTool('review_cart', {}, ctx);
    assert.equal(empty.ok, false);
    ctx.customerEvent = { type: 'reviewCart', payload: { items: [{ sku: 'NOPE' }] } };
    const none: any = await executeAgentTool('review_cart', {}, ctx);
    assert.equal(none.ok, false);
    const noReview: any = await executeAgentTool('present_card', { cardType: 'review', state: {} }, shop());
    assert.equal(noReview.ok, false);
    assert.match(noReview.error, /review_cart first/);
    const off = shop({ checkoutReview: { enabled: false } });
    off.customerEvent = { type: 'reviewCart', payload: { items: [{ sku: 'P1', quantity: 1 }] } };
    const switchedOff: any = await executeAgentTool('review_cart', {}, off);
    assert.equal(switchedOff.ok, false);
    const fromArgs: any = await executeAgentTool('review_cart', { items: [{ sku: 'S1', quantity: 3 }] }, shop());
    assert.equal(fromArgs.ok, true, 'the lines can also be given when the tap carried none');
  });

  await suite.test('a tap on "review my order" starts a turn and the pack can have its lookup run and shown at once', () => {
    assert.equal(resolveCustomerEventAction('reviewCart', {}), 'start_turn');
    const calls = prefetchCallsFor({ reviewCart: [{ tool: 'review_cart', args: {}, showAs: 'review' }] }, { type: 'reviewCart', payload: { items: [] } });
    assert.deepEqual(calls, [{ tool: 'review_cart', args: {}, showAs: 'review' }]);
  });

  await suite.test('accessories already suggested in this conversation are not shown again on the next add', async () => {
    const ctx = shop();
    for (const sku of ['P1', 'S1']) await executeAgentTool('get_product', { sku }, ctx);
    const first: any = await executeAgentTool('present_card', { cardType: 'accessories', state: { forSku: 'P1', groups: [{ key: 'g', label: 'Sand', items: [{ sku: 'S1' }] }] } }, ctx);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(ctx.presentedCards.length, 1);
    const again: any = await executeAgentTool('present_card', { cardType: 'accessories', state: { forSku: 'P1', groups: [{ key: 'g', label: 'Sand', items: [{ sku: 'S1' }] }] } }, ctx);
    assert.equal(again.skipped, true);
    assert.equal(ctx.presentedCards.length, 1, 'nothing new, so no second card');
    assert.ok(ctx.shownAccessories!.has('S1'));
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
