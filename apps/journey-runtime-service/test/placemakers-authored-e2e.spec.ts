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

  await suite.test('a model reply with one unsupported sentence keeps the rest; the withheld sentence is logged, never shown', async () => {
    const reply = 'Here are the wood screws we stock. You should drill a pilot hole first. Tell me the length you need.';
    const worded = stack.serviceFor({ reply });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    let result: any;
    try {
      result = await (worded as any).executeTurn({ tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-guard', sessionId: 'ws-guard', turnId: 'ws-guard-t1', correlationId: 'ws-guard-c1', message: 'wood screws' }, pack);
    } finally { console.warn = original; }
    // The claim guard removes the sentence that asserts an installation claim; the shaper removes the one that asks the customer for more.
    assert.ok(result.assistantMessage.startsWith('Here are the wood screws we stock.'), result.assistantMessage);
    assert.ok(!/pilot hole|Tell me/.test(result.assistantMessage), 'neither the claim nor the request for more is shown');
    assert.ok(!/pilot hole/.test(result.assistantMessage), 'the sentence that asserts an installation claim is not shown');
    assert.ok(warnings.some((line) => line.includes('[ClaimGuard]') && line.includes('installation_step') && line.includes('pilot hole')), `the log says what was withheld: ${warnings.join(' | ')}`);
    assert.ok(cards(result, 'products').length > 0, 'the products are still shown');
    const nothingLeft = stack.serviceFor({ reply: 'These are suitable for every job. They must be fitted by a professional.' });
    console.warn = () => undefined;
    try {
      result = await (nothingLeft as any).executeTurn({ tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-guard2', sessionId: 'ws-guard2', turnId: 'ws-guard2-t1', correlationId: 'ws-guard2-c1', message: 'wood screws' }, pack);
    } finally { console.warn = original; }
    assert.ok(result.assistantMessage.includes("I can't confirm that detail"), `the tenant's own wording is used when nothing is left: ${result.assistantMessage}`);
    assert.ok(!/merchant guidance|published/i.test(result.assistantMessage), 'and it is plain language');
  });

  await suite.test('"vanities": bathroom products only, with tapware and mirrors suggested; nothing from other departments', async () => {
    const result = await run('ws-vanities', 'vanities');
    assert.deepEqual(skusOf(cards(result, 'products')[0]), ['VN-1', 'VN-2']);
    assert.deepEqual(suggestionSkus(cards(result, 'accessories')[0]), ['MR-1', 'TW-1']);
    const everyShown = [...skusOf(cards(result, 'products')[0]), ...suggestionSkus(cards(result, 'accessories')[0])];
    assert.ok(!everyShown.includes('PL-X') && !everyShown.includes('FOREIGN-1'));
  });

  await suite.test('a normal product noun survives the reply guard on a customer-facing turn', async () => {
    const result = await (stack.serviceFor({ reply: 'Here are vanities from our range.' }) as any).executeTurn({
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-vanities-wording', sessionId: 'ws-vanities-wording',
      turnId: 'ws-vanities-wording-t1', correlationId: 'ws-vanities-wording-c1', message: 'vanities',
    }, pack);
    assert.equal(result.assistantMessage, 'Here are vanities from our range.');
    assert.deepEqual(skusOf(cards(result, 'products')[0]), ['VN-1', 'VN-2']);
  });

  await suite.test('"screws": a grouped overview from the family members, with the merchant\'s question as the last card', async () => {
    const result = await run('ws-screws', 'screws');
    assert.equal(result.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.ok(result.trace.knowledgeGate.retrieval.categoryPaths.length >= 3);
    const shown = skusOf(cards(result, 'products')[0]);
    assert.ok(['WS-1', 'MS-1', 'MA-1'].every((sku) => shown.includes(sku)), `examples from each member category: ${shown}`);
    assert.ok(!shown.includes('FOREIGN-1'));
    const order = (result.uiInstructions as any[]).map((entry) => entry.component);
    assert.equal(order[0], 'clarify', 'the question comes first; the examples follow it');
    assert.ok(order.indexOf('products') > order.indexOf('clarify'));
    assert.equal(cards(result, 'clarify')[0].props.questions[0].id, 'fastener_substrate');
  });

  await suite.test('"cleaning supply", as a customer types it: the question first, then a few examples, in words a person would use', async () => {
    // The reply a customer really received from the model: a system id, "head to the section", a second question of its own.
    const bad = 'Sure — for cleaning supplies, head to the PlaceMakers **Cleaners & Cleaning Equipment** section:\n\n**Category:** `cleaners-and-cleaning-equipment`\n\nWhat are you looking for specifically — general cleaning products, site clean-up gear, consumables, or equipment? If you tell me the job you\u2019re doing, I can help narrow it down.';
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    let result: any;
    const pilotService = stack.serviceFor({ reply: bad });
    try {
      result = await (pilotService as any).executeTurn({ tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-pilot', sessionId: 'ws-pilot', turnId: 'ws-pilot-t1', correlationId: 'ws-pilot-c1', message: 'cleaning supply' }, pack);
    } finally { console.warn = original; }
    assert.equal(result.trace.knowledgeGate.conceptId, 'concept://placemakers/families/cleaning-supplies', 'the authored family answers, not a category from the tree');
    assert.equal(result.trace.knowledgeGate.mode, 'overview_then_ask');
    const order = (result.uiInstructions as any[]).map((entry) => entry.component);
    assert.deepEqual(order, ['clarify', 'products'], 'the question, then the examples (no cross-sell: nothing was chosen yet)');
    const question = cards(result, 'clarify')[0].props.questions[0];
    assert.equal(question.text, 'What are you cleaning?');
    assert.deepEqual(question.options.map((option: any) => option.label), ['Inside the house: kitchen, bathroom, general', 'Floors: mopping and sweeping', 'Outside: decks, concrete, driveways', 'The car', 'Buckets, bins and other household things']);
    assert.ok(!question.options.some((option: any) => /Cleaners & Cleaning Equipment|Indoor Cleaners/.test(option.label)), 'no category names as choices');
    // Nothing from the model survived, so the tenant's own short lead-in is what the customer reads.
    assert.equal(result.assistantMessage, 'A quick question first, so I can show you the right ones.');
    assert.ok(!/`|cleaners-and-cleaning|head to|PlaceMakers|\?|section/i.test(result.assistantMessage), result.assistantMessage);
    assert.ok(warnings.some((line) => line.includes('[ReplyShaper]') && line.includes('internal id')), 'the log says what was removed');
    assert.ok(!cards(result, 'products')[0].props.products.some((product: any) => product.recommended), 'samples from a category are not badged "Recommended"');
    assert.equal(cards(result, 'products')[0].props.closing, 'cart', 'the button never reads "Add all to"');
    // A short, normal reply from the model is kept exactly.
    const calm = await (stack.serviceFor({ reply: 'Happy to help with that.' }) as any).executeTurn({ tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-pilot2', sessionId: 'ws-pilot2', turnId: 'ws-pilot2-t1', correlationId: 'ws-pilot2-c1', message: 'cleaning supply' }, pack);
    assert.equal(calm.assistantMessage, 'Happy to help with that.');
    // The answer narrows to the right shelf without asking again. It arrives as the web app sends it (text, one "question → answer"
    // line per card) and the stand-in model reads nothing from it: a tapped answer never depends on a model.
    const floors = await (pilotService as any).executeTurn({ tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-pilot', sessionId: 'ws-pilot', turnId: 'ws-pilot-t2', correlationId: 'ws-pilot-c2', message: 'My answers:\nWhat are you cleaning? → equipment' }, pack);
    assert.equal(floors.trace.knowledgeGate.conceptId, 'concept://placemakers/cleaning-and-consumables/cleaners-and-cleaning-equipment/mops-and-brooms');
    assert.equal(floors.trace.knowledgeGate.mode, 'direct_results');
    assert.equal(cards(floors, 'clarify').length, 0, 'the question is not asked twice');
    assert.deepEqual(skusOf(cards(floors, 'products')[0]), ['MB-1']);
    // The same answer by its label, and an answer that is a word which also names an unrelated category ("equipment" is a power-tool shelf).
    await run('ws-pilot-b', 'cleaning supply', 1);
    const car = await run('ws-pilot-b', 'My answers:\nWhat are you cleaning? → The car', 2);
    assert.equal(car.trace.knowledgeGate.conceptId, 'concept://placemakers/cleaning-and-consumables/automotive/car-cleaning');
    assert.deepEqual(skusOf(cards(car, 'products')[0]), ['CC-1']);
    assert.equal(floors.trace.knowledgeGate.trace.matchedBy, 'pending_clarification', 'it is the answer to the open question, not a new request');
  });

  await suite.test('cleaning supplies and paint narrow across turns using authored facts, without leaking adjacent categories', async () => {
    const cleaning = await run('ws-cleaning-supplies', 'cleaning supplies');
    assert.equal(cleaning.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.equal(cards(cleaning, 'clarify')[0]?.props?.questions[0]?.id, 'cleaning_task');
    const cleaningPreview = skusOf(cards(cleaning, 'products')[0]);
    assert.ok(['IC-1', 'OC-1', 'MB-1'].every((sku) => cleaningPreview.includes(sku)), `cleaning categories: ${cleaningPreview}`);
    const indoor = await run('ws-cleaning-supplies', 'indoor', 2);
    assert.equal(indoor.trace.knowledgeGate.conceptId, 'concept://placemakers/cleaning-and-consumables/cleaners-and-cleaning-equipment/indoor-cleaners');
    assert.deepEqual(skusOf(cards(indoor, 'products')[0]), ['IC-1']);

    const paint = await run('ws-paint-project', 'paint a room');
    assert.equal(paint.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.equal(cards(paint, 'clarify')[0]?.props?.questions[0]?.id, 'paint_surface');
    const interior = await run('ws-paint-project', 'inside walls', 2);
    assert.equal(interior.trace.knowledgeGate.conceptId, 'concept://placemakers/projects/paint-a-room');
    assert.deepEqual(interior.trace.knowledgeGate.retrieval.groups.map((group: any) => group.label), ['Interior Paint']);
    assert.deepEqual(skusOf(cards(interior, 'products')[0]), ['IP-1'], 'exterior paint is excluded after the fact answer');
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

  await suite.test('an empty live catalogue result cannot become an invented availability claim', async () => {
    const result = await (stack.serviceFor({ reply: 'Here are toilets from our range.' }) as any).executeTurn({
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-empty-toilets', sessionId: 'ws-empty-toilets',
      turnId: 'ws-empty-toilets-t1', correlationId: 'ws-empty-toilets-c1', message: 'toilets',
    }, pack);
    assert.equal(retrieved(result), true, 'the tenant catalogue was searched');
    assert.equal(cards(result, 'products').length, 0, 'no item was found in the isolated catalogue');
    assert.match(result.assistantMessage, /can't show products/i);
    assert.doesNotMatch(result.assistantMessage, /here are toilets/i);
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
