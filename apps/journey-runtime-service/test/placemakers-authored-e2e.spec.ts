import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { publishOkfRelease } from '@journeyax/knowledge';
import { OkfKnowledgeControlPlane } from '../src/kernel/knowledge-control-plane';
import { CODE_OF, ENVIRONMENT, SKU_OF, TENANT, buildPlaceMakersStack } from './helpers/placemakers-stack';

/**
 * End to end, on real PlaceMakers inputs, through the real publication chain (see helpers/placemakers-stack.ts): the authored
 * release is published checksum-bound, the Business Pack is produced by the real publisher, and the real turn service, gate,
 * catalogue handler, presentation port and basket policy run on it. Only the language model is a fixed function.
 */
const suite = createSuite('runtime: PlaceMakers authored knowledge, end to end');

const cards = (result: any, component: string) => (result.uiInstructions || []).filter((entry: any) => entry.component === component);
const skusOf = (card: any) => (card?.props?.products || []).map((entry: any) => CODE_OF[entry.sku] ?? entry.sku).sort();
const suggestionSkus = (card: any) => (card?.props?.groups || []).flatMap((group: any) => group.items.map((item: any) => CODE_OF[item.sku] ?? item.sku)).sort();
const retrieved = (result: any) => (result.executedCapabilities || []).some((entry: any) => entry.toolId === 'catalog.search');

async function main() {
  const stack = await buildPlaceMakersStack();
  const { db, pack, reference, content, okf } = stack;
  assert.equal(reference.checksum, okf.release.checksum);
  const service = stack.serviceFor();
  const run = (workspaceId: string, message: string, n = 1) => {
    // The turn service resolves the active pack from the repository; hand it this pack directly, as the cutover gate does.
    return (service as any).executeTurn({
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId, sessionId: workspaceId, turnId: `${workspaceId}-t${n}`, correlationId: `${workspaceId}-c${n}`, message,
    }, pack) as Promise<any>;
  };

  await suite.test('"wood screws": only wood-screw products, then unverified "Have you considered?" with live products', async () => {
    const result = await run('ws-wood-screws', 'wood screws');
    assert.equal(result.trace.knowledgeGate.mode, 'direct_results');
    assert.deepEqual(skusOf(cards(result, 'products')[0]), ['WS-1', 'WS-2'], 'path scope: no metal screws, anchors or another tenant\'s product');
    const suggestion = cards(result, 'accessories')[0];
    assert.ok(suggestion, 'the cross-sell card is shown next to real results');
    assert.equal(suggestion.props.heading, 'Have you considered?');
    assert.match(suggestion.props.note, /not confirmed/i);
    assert.deepEqual(suggestionSkus(suggestion), ['DB-1', 'DB-2', 'SB-1'], 'live products from the suggested categories');
    assert.deepEqual(suggestion.props.groups.map((group: any) => group.label), ['Drill Bits', 'Screwdriver Bits']);
    assert.ok(!suggestion.props.groups.some((group: any) => ['required', 'recommended'].includes(group.key)), 'never presented as required or recommended');
  });

  await suite.test('"vanities": bathroom products only, with tapware and mirrors suggested; nothing from other departments', async () => {
    const result = await run('ws-vanities', 'vanities');
    assert.deepEqual(skusOf(cards(result, 'products')[0]), ['VN-1', 'VN-2']);
    assert.deepEqual(suggestionSkus(cards(result, 'accessories')[0]), ['MR-1', 'TW-1']);
    const everyShown = [...skusOf(cards(result, 'products')[0]), ...suggestionSkus(cards(result, 'accessories')[0])];
    assert.ok(!everyShown.includes('PL-X') && !everyShown.includes('FOREIGN-1'));
  });

  await suite.test('"screws": a grouped overview from the family members, with the merchant\'s question as the last card', async () => {
    const result = await run('ws-screws', 'screws');
    assert.equal(result.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.ok(result.trace.knowledgeGate.retrieval.categoryPaths.length >= 3);
    const shown = skusOf(cards(result, 'products')[0]);
    assert.ok(['WS-1', 'MS-1', 'MA-1'].every((sku) => shown.includes(sku)), `examples from each member category: ${shown}`);
    assert.ok(!shown.includes('FOREIGN-1'));
    const order = (result.uiInstructions as any[]).map((entry) => entry.component);
    assert.equal(order[order.length - 1], 'clarify', 'the question is the customer\'s next step');
    assert.equal(cards(result, 'clarify')[0].props.questions[0].id, 'fastener_substrate');
  });

  await suite.test('a project is served by the gate: question first, then a grouped overview of its categories', async () => {
    const first = await run('ws-deck', 'i want to build a deck');
    assert.equal(first.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.equal(first.trace.knowledgeGate.conceptId, 'concept://placemakers/projects/deck-build');
    assert.equal(cards(first, 'clarify')[0].props.questions[0].id, 'deck_material');
    const second = await run('ws-deck', 'composite and 4x3 m', 2);
    assert.equal(second.trace.knowledgeGate.conceptId, 'concept://placemakers/projects/deck-build');
    const shown = skusOf(cards(second, 'products')[0]);
    assert.ok(shown.includes('CD-1'), `decking boards from the project's categories: ${shown}`);
    assert.deepEqual(suggestionSkus(cards(second, 'accessories')[0]), ['OC-1', 'WC-1', 'WS-1', 'WS-2'], 'wood screws, woodcare and outdoor cleaners are suggested for the deck');
  });

  await suite.test('a planning journey asks its OKF project question before invoking an unconfigured stage', async () => {
    for (const [message, label] of [
      ['renovate my bathroom', 'bathroom'],
      ['renovate my laundry', 'laundry'],
    ]) {
      const result = await run(`ws-plan-${label}`, message);
      assert.equal(result.trace.knowledgeGate.mode, 'project_journey');
      assert.equal(result.trace.knowledgeGate.journeyRef?.journeyId, 'placemakers_plan_your_space');
      assert.equal(cards(result, 'clarify')[0]?.props?.questions[0]?.id, 'project_scope');
      assert.equal(retrieved(result), false, 'product search must wait for the project scope answer');
    }
    const next = await run('ws-plan-laundry', 'renovation', 2);
    assert.equal(next.trace.knowledgeGate.conceptId, 'concept://placemakers/projects/laundry-makeover');
    assert.equal(cards(next, 'clarify')[0]?.props?.questions[0]?.id, 'room_dimensions');
    assert.equal(retrieved(next), false, 'the same laundry journey must continue gathering its own facts');
  });

  await suite.test('problems escalate: no retrieval, no cards of products, no cross-sell, no invented advice', async () => {
    for (const [message, label] of [['my bathroom is leaking', 'bathroom leak'], ['there is a gas leak', 'gas'], ['my heater is smoking', 'uncovered hazard'], ['water near power points', 'electrical']]) {
      const result = await run(`ws-problem-${label.replace(/\W/g, '')}`, message);
      assert.equal(result.trace.knowledgeGate.mode, 'safety_then_diagnose', message);
      assert.equal(retrieved(result), false, `${message}: no catalogue call`);
      assert.equal(cards(result, 'products').length + cards(result, 'accessories').length, 0, `${message}: no product or cross-sell card`);
      assert.match(String(result.assistantMessage), /qualified|professional|tradesperson|licensed|emergency/i, `${message}: a professional is named`);
    }
  });

  await suite.test('installation, warranty and care questions fail safely: nothing retrieved, nothing shown, nothing claimed', async () => {
    for (const message of ['how do i install a vanity', 'what is the warranty on this vanity', 'clean my deck']) {
      const result = await run(`ws-evidence-${message.length}`, message);
      assert.equal(result.trace.knowledgeGate.mode, 'evidence_answer', message);
      assert.equal(retrieved(result), false, message);
      assert.equal(cards(result, 'products').length + cards(result, 'accessories').length + cards(result, 'guide').length + cards(result, 'warranty').length, 0, message);
    }
  });

  await suite.test('an exact SKU resolves in the tenant catalogue only', async () => {
    const result = await run('ws-sku', `SKU ${SKU_OF['HM-1']}`);
    assert.equal(result.trace.knowledgeGate.mode, 'direct_results');
    assert.ok(skusOf(cards(result, 'products')[0]).includes('HM-1'));
    const foreign = await run('ws-sku-foreign', `SKU ${SKU_OF['FOREIGN-1']}`);
    assert.ok(!skusOf(cards(foreign, 'products')[0]).includes('FOREIGN-1'), 'another tenant\'s SKU is never shown');
  });

  await suite.test('a concept the release does not cover is never answered from the catalogue by default', async () => {
    for (const message of ['do you sell flux capacitors', 'is the flux capacitor rated for a load bearing span']) {
      const result = await run(`ws-unmatched-${message.length}`, message);
      assert.equal(retrieved(result), false, message);
      assert.equal(cards(result, 'products').length, 0, message);
      assert.ok(!['direct_results', 'overview_then_ask', 'legacy_search'].includes(result.trace.knowledgeGate.mode), `${message}: ${result.trace.knowledgeGate.mode}`);
    }
  });

  await suite.test('a suitability question about something we list shows the listing and says plainly that nothing verified supports the claim', async () => {
    const result = await run('ws-technical', 'is this wood screw suitable for a load bearing beam');
    const gate = result.trace.knowledgeGate;
    assert.ok(gate.trace.reasonCodes.includes('technical_requirement_unverified'));
    assert.ok(!gate.claims.allowedClasses.some((claim: string) => ['compatibility', 'requirement', 'substitution', 'safety_instruction'].includes(claim)));
    assert.match(String(result.assistantMessage), /can't confirm technical suitability/, 'the statement is in the message the customer reads, not left to the model');
    assert.ok(skusOf(cards(result, 'products')[0]).length > 0, 'the listing itself is still useful and asserts nothing');
  });

  await suite.test('a request that only partly matches asks the department question; it never claims the unmatched part exists', async () => {
    const result = await run('ws-partial', 'do you sell garden gnomes');
    const gate = result.trace.knowledgeGate;
    assert.equal(gate.mode, 'overview_then_ask');
    assert.equal(gate.conceptId, 'concept://placemakers/outdoor-and-landscaping/garden-and-landscaping');
    assert.deepEqual(gate.claims.allowedClasses.filter((claim: string) => !['catalog_fact', 'suggestion'].includes(claim)), []);
    assert.ok(cards(result, 'clarify').length === 1, 'the department question is asked');
  });

  await suite.test('catalogue-only fallback is an explicit release decision, shows live facts only, and carries no claim', async () => {
    const optedIn = structuredClone(content) as any;
    optedIn.policy = { ...(optedIn.policy || {}), coverage: { uncoveredShopping: { mode: 'catalogue_only', commerce: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' } } } };
    const optedRelease = await publishOkfRelease(db as any, {
      releaseId: 'okf-pm-catalogue-only', tenantId: TENANT, environmentId: ENVIRONMENT, version: '1.0.1', content: optedIn, publishedBy: 'human:test',
    });
    const optedPack = { ...structuredClone(pack), knowledgeModel: { ...reference, releaseId: optedRelease.releaseId, version: optedRelease.version, checksum: optedRelease.checksum } };
    const result = await (service as any).executeTurn({
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-opt-in', sessionId: 'ws-opt-in', turnId: 't1', correlationId: 'c1', message: 'garden plumbing fitting',
    }, optedPack);
    const gate = result.trace.knowledgeGate;
    if (gate.mode === 'legacy_search') {
      assert.ok(gate.trace.reasonCodes.includes('uncovered_shopping_catalogue_only'));
      assert.deepEqual(gate.claims.allowedClasses, ['catalog_fact']);
      assert.deepEqual(gate.commerce, { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' });
    } else {
      assert.notEqual(gate.mode, 'direct_results', 'a covered answer would have to come from a concept, not from the fallback');
    }
  });

  await suite.test('basket: the strictest governing concept decides, paths keep same-named categories apart, path-less products are still governed', async () => {
    const plane = new OkfKnowledgeControlPlane(async () => db as any);
    const command = { tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'basket', sessionId: 'basket', correlationId: 'basket', message: 'add to cart' } as any;
    const basket = (...skus: string[]) => plane.evaluateBasket(pack, command, null, skus.map((code) => ({ sku: SKU_OF[code] ?? code })));
    assert.deepEqual((await basket('HM-1'))?.commerce, { addToCart: 'allowed', checkout: 'allowed' });
    assert.equal((await basket('SW-1'))?.commerce.checkout, 'requires_professional_confirmation', 'switchgear needs a qualified professional');
    assert.equal((await basket('HM-1', 'SW-1'))?.commerce.checkout, 'requires_professional_confirmation');
    assert.deepEqual((await basket('WS-1'))?.commerce, { addToCart: 'allowed', checkout: 'allowed' }, 'the screws family states compatibility as a disclaimer; its commerce ceiling is the merchant\'s call');
    assert.deepEqual((await basket('LP-1'))?.commerce, { addToCart: 'allowed', checkout: 'allowed' }, 'a product filed by category name only is governed by its concept');
    assert.deepEqual((await basket('NOPE'))?.commerce, { addToCart: 'blocked', checkout: 'blocked' }, 'an unknown SKU is blocked');
    assert.deepEqual((await basket('FOREIGN-1'))?.commerce, { addToCart: 'blocked', checkout: 'blocked' }, 'another tenant\'s SKU is blocked');
    // A "Plumbing" in the Outdoor department is covered by the Outdoor hierarchy, not by the bathroom or tools "Plumbing".
    const stray = await basket('PL-X');
    assert.ok(!stray?.reasonCodes.includes('missing_catalog_sku'));
  });

  await suite.test('the release was published checksum-bound, and a different checksum cannot be used by the pack', async () => {
    const tampered = { ...structuredClone(pack), knowledgeModel: { ...reference, checksum: 'f'.repeat(64) } };
    const result = await (service as any).executeTurn({
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-tamper', sessionId: 'ws-tamper', turnId: 't1', correlationId: 'c1', message: 'wood screws',
    }, tampered);
    assert.equal(retrieved(result), false, 'a required release that fails verification fails closed');
    assert.equal(cards(result, 'products').length, 0);
  });

}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
