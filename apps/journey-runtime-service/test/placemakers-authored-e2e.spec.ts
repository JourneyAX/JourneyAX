import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { publishOkfRelease } from '@journeyax/knowledge';
import { OkfKnowledgeControlPlane } from '../src/kernel/knowledge-control-plane';
import { resolveConversationPolicy } from '../src/conversation';
import { CODE_OF, ENVIRONMENT, SKU_OF, TENANT, buildPlaceMakersStack, products as fixtureProducts } from './helpers/placemakers-stack';

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

  // The platform words the turn by default. A tenant may instead have the model word replies; the claim guard and the reply
  // shaper then apply to what it says.
  const dialogue = resolveConversationPolicy(pack);
  const modelPack: any = { ...pack, extensions: { ...(pack.extensions ?? {}), dialoguePolicy: { wording: 'model' } } };
  assert.equal(resolveConversationPolicy(modelPack).wording, 'model');
  const turn = (svc: any, workspaceId: string, message: string, n = 1, forPack: any = pack) => svc.executeTurn({
    tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId, sessionId: workspaceId, turnId: `${workspaceId}-t${n}`, correlationId: `${workspaceId}-c${n}`, message,
  }, forPack) as Promise<any>;

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

  await suite.test('when a tenant has the model word the reply, one unsupported sentence costs only that sentence; it is logged, never shown', async () => {
    const reply = 'Here are the wood screws we stock. You should drill a pilot hole first. Tell me the length you need.';
    const worded = stack.serviceFor({ reply });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    let result: any;
    try {
      result = await turn(worded, 'ws-guard', 'wood screws', 1, modelPack);
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
      result = await turn(nothingLeft, 'ws-guard2', 'wood screws', 1, modelPack);
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
    const result = await turn(stack.serviceFor({ reply: 'Here are vanities from our range.' }), 'ws-vanities-wording', 'vanities', 1, modelPack);
    assert.equal(result.assistantMessage, 'Here are vanities from our range.');
    assert.deepEqual(skusOf(cards(result, 'products')[0]), ['VN-1', 'VN-2']);
  });

  await suite.test('"screws": the merchant\'s question comes first and no products yet; "just show me" skips the question', async () => {
    const result = await run('ws-screws', 'screws');
    assert.equal(result.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.ok(result.trace.knowledgeGate.retrieval.categoryPaths.length >= 3);
    assert.deepEqual((result.uiInstructions as any[]).map((entry) => entry.component), ['clarify'], 'a question first; nothing to look at until it is answered');
    assert.equal(cards(result, 'clarify')[0].props.questions[0].id, 'fastener_substrate');
    assert.equal(result.trace.conversation.action, 'ask');
    assert.ok(dialogue.templates.ask.includes(result.assistantMessage), result.assistantMessage);
    assert.ok(!/compatib/i.test(result.assistantMessage), 'a question claims nothing about a product, so it carries no notice about products');
    const browse = await run('ws-screws-browse', 'just show me screws');
    const shown = skusOf(cards(browse, 'products')[0]);
    assert.ok(['WS-1', 'MS-1', 'MA-1'].every((sku) => shown.includes(sku)), `examples from each member category: ${shown}`);
    assert.ok(!shown.includes('FOREIGN-1'));
    assert.equal(browse.trace.conversation.action, 'show');
    assert.equal(cards(browse, 'clarify').length, 0, 'asked to see them, so not asked a question');
    assert.ok(!cards(browse, 'products')[0].props.products.some((product: any) => product.recommended || product.reason), 'a plain list gives no reason it cannot back up');
    assert.match(String(browse.assistantMessage), /compatib/i, 'a turn that shows products carries the notice about them');
  });

  await suite.test('"cleaning supply", as a customer types it: the question first and alone, in words a person would use', async () => {
    // The reply a customer really received from the model: a system id, "head to the section", a second question of its own.
    const bad = 'Sure — for cleaning supplies, head to the PlaceMakers **Cleaners & Cleaning Equipment** section:\n\n**Category:** `cleaners-and-cleaning-equipment`\n\nWhat are you looking for specifically — general cleaning products, site clean-up gear, consumables, or equipment? If you tell me the job you\u2019re doing, I can help narrow it down.';
    const pilotService = stack.serviceFor({ reply: bad });
    const result = await turn(pilotService, 'ws-pilot', 'cleaning supply');
    assert.equal(result.trace.knowledgeGate.conceptId, 'concept://placemakers/families/cleaning-supplies', 'the authored family answers, not a category from the tree');
    assert.equal(result.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.deepEqual((result.uiInstructions as any[]).map((entry) => entry.component), ['clarify'], 'the question, and nothing else yet');
    const question = cards(result, 'clarify')[0].props.questions[0];
    assert.equal(question.text, 'What are you cleaning?');
    assert.deepEqual(question.options.map((option: any) => option.label), ['Inside the house: kitchen, bathroom, general', 'Floors: mopping and sweeping', 'Outside: decks, concrete, driveways', 'The car', 'Buckets, bins and other household things']);
    assert.ok(!question.options.some((option: any) => /Cleaners & Cleaning Equipment|Indoor Cleaners/.test(option.label)), 'no category names as choices');
    // The platform words the turn from the tenant\'s own sentences; the model is not asked, so nothing it said can reach the customer.
    assert.ok(dialogue.templates.ask.includes(result.assistantMessage), result.assistantMessage);
    assert.ok(!/`|cleaners-and-cleaning|head to|PlaceMakers|section/i.test(result.assistantMessage), result.assistantMessage);
    assert.deepEqual(result.trace.conversation.question, { source: 'okf', factKey: 'cleaning_task' });
    // A tenant that has the model word the reply still gets it cleaned: the id, the redirect and the second question are removed.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    let modelled: any;
    try { modelled = await turn(stack.serviceFor({ reply: bad }), 'ws-pilot-m', 'cleaning supply', 1, modelPack); } finally { console.warn = original; }
    assert.deepEqual((modelled.uiInstructions as any[]).map((entry) => entry.component), ['clarify'], 'the cards are decided by the conversation, not by who words the reply');
    assert.equal(modelled.assistantMessage, 'A quick question first, so I can show you the right ones.');
    assert.ok(warnings.some((line) => line.includes('[ReplyShaper]') && line.includes('internal id')), 'the log says what was removed');
    const calm = await turn(stack.serviceFor({ reply: 'Happy to help with that.' }), 'ws-pilot2', 'cleaning supply', 1, modelPack);
    assert.equal(calm.assistantMessage, 'Happy to help with that.');
    // The answer narrows to the right shelf without asking again. It arrives as the web app sends it (text, one "question → answer"
    // line per card) and the stand-in model reads nothing from it: a tapped answer never depends on a model.
    const floors = await turn(pilotService, 'ws-pilot', 'My answers:\nWhat are you cleaning? → equipment', 2);
    assert.equal(floors.trace.knowledgeGate.conceptId, 'concept://placemakers/cleaning-and-consumables/cleaners-and-cleaning-equipment/mops-and-brooms');
    assert.equal(floors.trace.knowledgeGate.mode, 'direct_results');
    assert.equal(cards(floors, 'clarify').length, 0, 'the question is not asked twice');
    assert.deepEqual(skusOf(cards(floors, 'products')[0]), ['MB-1']);
    assert.equal(floors.trace.conversation.action, 'show');
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
    assert.equal(cards(cleaning, 'products').length, 0, 'the question comes before any product');
    const indoor = await run('ws-cleaning-supplies', 'indoor', 2);
    assert.equal(indoor.trace.knowledgeGate.conceptId, 'concept://placemakers/cleaning-and-consumables/cleaners-and-cleaning-equipment/indoor-cleaners');
    assert.deepEqual(skusOf(cards(indoor, 'products')[0]), ['IC-1']);
    // A customer who would rather look first sees an example from each kind of cleaning supply.
    const browse = await run('ws-cleaning-browse', 'show me cleaning supplies');
    const cleaningPreview = skusOf(cards(browse, 'products')[0]);
    assert.ok(['IC-1', 'OC-1', 'MB-1'].every((sku) => cleaningPreview.includes(sku)), `cleaning categories: ${cleaningPreview}`);
    assert.equal(cards(browse, 'clarify').length, 0);

    const paint = await run('ws-paint-project', 'paint a room');
    assert.equal(paint.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.equal(cards(paint, 'clarify')[0]?.props?.questions[0]?.id, 'paint_surface');
    assert.equal(cards(paint, 'products').length, 0);
    const interior = await run('ws-paint-project', 'inside walls', 2);
    assert.equal(interior.trace.knowledgeGate.conceptId, 'concept://placemakers/projects/paint-a-room');
    assert.deepEqual(interior.trace.knowledgeGate.retrieval.groups.map((group: any) => group.label), ['Interior Paint']);
    assert.deepEqual(skusOf(cards(interior, 'products')[0]), ['IP-1'], 'exterior paint is excluded after the fact answer');
  });

  await suite.test('a customer who has said what they need gets one recommendation with the reason from the product\'s own words, and no model is asked', async () => {
    const result = await turn(stack.serviceFor({ reply: 'MODEL WORDS' }), 'ws-recommend', 'wood screws for decking');
    const shown = cards(result, 'products')[0].props.products;
    assert.deepEqual(shown.map((entry: any) => CODE_OF[entry.sku]), ['WS-2'], 'the one that matches what was said, not a list');
    assert.equal(shown[0].recommended, true);
    const description = String(fixtureProducts.find((entry) => entry.sku === shown[0].sku)?.description);
    assert.ok(shown[0].reason.startsWith('For decking: '), shown[0].reason);
    assert.ok(description.includes(shown[0].reason.slice('For decking: '.length)), 'the reason is a sentence from the product itself');
    assert.ok(result.assistantMessage.includes('Decking screw 10g x 65mm') && !result.assistantMessage.includes('MODEL WORDS'));
    assert.equal(cards(result, 'clarify').length, 0, 'enough was said, so there is nothing to ask');
    assert.equal(result.trace.conversation.action, 'recommend');
    assert.deepEqual(result.trace.conversation.products.map((entry: any) => [CODE_OF[entry.sku], entry.quoted]), [['WS-2', true]]);
    assert.equal(result.trace.conversation.needs.join(), 'decking');
    // Said nothing more than the shelf: both are shown, neither is called the best, and no reason is invented.
    const plain = await turn(stack.serviceFor(), 'ws-no-needs', 'wood screws');
    const list = cards(plain, 'products')[0].props.products;
    assert.deepEqual(list.map((entry: any) => CODE_OF[entry.sku]).sort(), ['WS-1', 'WS-2']);
    assert.ok(list.every((entry: any) => !entry.recommended && !entry.reason));
    assert.equal(plain.trace.conversation.action, 'show');
  });

  await suite.test('"how do I use…" is answered from the product\'s own details: no cards, no model, nothing the release has not verified', async () => {
    const result = await turn(stack.serviceFor({ reply: 'Brush it on and rinse after twenty minutes.' }), 'ws-howto', 'how do I use deck wash');
    assert.equal(result.trace.conversation.action, 'answer');
    assert.equal(cards(result, 'products').length + cards(result, 'accessories').length + cards(result, 'clarify').length, 0);
    assert.equal(result.assistantMessage, dialogue.templates.howTo.replace('{title}', 'Deck wash 2L').replace('{steps}', 'Brush on, leave for ten minutes, then rinse.'), 'the steps are the product\'s, word for word');
    // A product with nothing about use on file: said plainly.
    const none = await turn(stack.serviceFor({ reply: 'Pre-drill and screw it in.' }), 'ws-howto-none', 'how do I use the 10g x 65mm wood screw');
    assert.ok(String(none.assistantMessage).startsWith(dialogue.templates.howToNone.replace('{title}', 'Decking screw 10g x 65mm')), none.assistantMessage);
    assert.match(String(none.assistantMessage), /check compatibility/i, 'the release\'s required notice still accompanies a reply about a product');
    assert.ok(!/pre-drill/i.test(String(none.assistantMessage)), 'a model\'s steps are never relayed');
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

  await suite.test('a leak is a problem however it is worded: the same safe answer, no products, no model asked to improvise', async () => {
    const platform = 'I can\'t give verified safety guidance for this. Please contact a qualified professional.';
    for (const message of ['toilet is leaking', 'my toilet is leaking', 'leaky toilet', 'toilet leak', 'leaking tap', 'the tap leaks', 'we have a leaky shower']) {
      const calls: string[] = [];
      const result = await turn(stack.serviceFor({ calls, reply: 'Turn off the isolation tap and avoid using it until the leak is checked.' }), `ws-leak-${message.replace(/\W/g, '')}`, message);
      assert.equal(result.trace.knowledgeGate.mode, 'safety_then_diagnose', message);
      assert.equal(retrieved(result), false, `${message}: no catalogue call`);
      assert.equal(cards(result, 'products').length + cards(result, 'accessories').length + cards(result, 'clarify').length, 0, message);
      assert.equal(result.assistantMessage, platform, `${message}: the platform\'s sentence, not a model\'s steps`);
      assert.ok(!calls.includes('response_generation'), `${message}: no model was asked to word a refusal that is already written`);
    }
    // Leak products are still shopping.
    for (const message of ['do you sell leak sealant', 'leak proof container']) {
      const result = await run(`ws-leak-product-${message.length}`, message);
      assert.notEqual(result.trace.knowledgeGate.mode, 'safety_then_diagnose', message);
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

  await suite.test('a shelf with many products and nothing to tell them apart: one question built from the products themselves, then the narrowed list', async () => {
    const base: any = fixtureProducts.find((entry) => entry.sku === SKU_OF['HM-1']);
    const rows: Array<[string, string, number]> = [['Claw hammer 20oz', 'Stanley', 29], ['Rubber mallet 500g', 'Stanley', 14], ['Sledge hammer 4kg', 'Estwing', 69], ['Club hammer 2lb', 'Estwing', 33],
      ['Framing hammer 22oz', 'Estwing', 79], ['Tack hammer 8oz', 'Spear', 12], ['Dead blow hammer 1kg', 'Spear', 38], ['Ball pein hammer 8oz', 'Spear', 22]];
    await db.collection('products').insertMany(rows.map(([name, brand, price], index) => ({ ...base, _id: undefined, sku: `900${index}`, name, brand, priceUSD: { min: price } })).map(({ _id, ...rest }) => rest));
    const first = await run('ws-hammers', 'hammers');
    assert.deepEqual((first.uiInstructions as any[]).map((entry) => entry.component), ['clarify'], 'nine products and nothing to choose by: ask, do not dump them');
    assert.equal(first.trace.conversation.question.source, 'facet');
    const question = cards(first, 'clarify')[0].props.questions[0];
    assert.equal(question.id, 'facet_brand');
    assert.deepEqual(question.options.map((option: any) => option.label), ['Estwing', 'Spear', 'Stanley', 'No preference']);
    assert.deepEqual(question.options.map((option: any) => option.value), question.options.map((option: any) => option.label), 'what is echoed back in the chat is plain words, not a code');
    assert.ok(dialogue.templates.askMany.includes(first.assistantMessage), first.assistantMessage);
    // The tap arrives as text, like every card answer, and continues the same shelf.
    const narrowed = await run('ws-hammers', `My answers:\n${question.text} → ${question.options[0].value}`, 2);
    assert.ok(narrowed.trace.knowledgeGate.trace.reasonCodes.includes('conversation_answer_continuity'));
    assert.deepEqual(cards(narrowed, 'products')[0].props.products.map((entry: any) => entry.title).sort(), ['Club hammer 2lb', 'Framing hammer 22oz', 'Sledge hammer 4kg']);
    assert.equal(cards(narrowed, 'clarify').length, 0, 'it is not asked again');
    // Naming a brand in the first message is the answer already; asking to see them skips the question.
    const named = await run('ws-hammers-brand', 'hammers by Estwing');
    assert.equal(cards(named, 'clarify').length, 0);
    assert.equal(cards(named, 'products')[0].props.products.length, 3);
    const browse = await run('ws-hammers-browse', 'show me all hammers');
    assert.equal(cards(browse, 'clarify').length, 0);
    assert.equal(cards(browse, 'products')[0].props.products.length, dialogue.show.maxItems);
    // The conversation state is internal: it never reaches the customer\'s view.
    assert.ok(!JSON.stringify(narrowed.uiInstructions).includes('conversation_state'));
  });

  await suite.test('the slow model read is skipped for a fully understood tap or a plain "show me", kept for everything else, and the log says which', async () => {
    const calls: string[] = [];
    const service = stack.serviceFor({ calls });
    const reads = () => calls.filter((task) => task === 'fast_intent').length;
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
    try {
      const first = await turn(service, 'ws-skip', 'cleaning supply');
      assert.equal(reads(), 1, 'free text is read by the model');
      assert.equal(first.trace.diagnostics.modelRead, 'used');
      const tap = await turn(service, 'ws-skip', 'My answers:\nWhat are you cleaning? → equipment', 2);
      assert.equal(reads(), 1, 'the tap added no model read');
      assert.equal(tap.trace.modelSkipped, 'tapped_answer');
      assert.equal(tap.trace.modelRoute, undefined, 'no model was used, so none is claimed');
      assert.equal(tap.trace.diagnostics.modelRead, 'skipped (tapped_answer)');
      assert.equal(tap.trace.knowledgeGate.trace.matchedBy, 'pending_clarification');
      assert.deepEqual(skusOf(cards(tap, 'products')[0]), ['MB-1'], 'the answer is the same as when the model read it');

      // The question built from the products is read without the model too.
      const hammers = await turn(service, 'ws-skip-h', 'hammers');
      const question = cards(hammers, 'clarify')[0].props.questions[0];
      const before = reads();
      const narrowed = await turn(service, 'ws-skip-h', `My answers:\n${question.text} → ${question.options[0].value}`, 2);
      assert.equal(reads(), before, 'no model read for the tap');
      assert.equal(narrowed.trace.modelSkipped, 'tapped_answer');
      assert.equal(cards(narrowed, 'products')[0].props.products.length, 3);

      // A plain "show me" for a shelf, but not one with something more in it.
      const browse = await turn(service, 'ws-skip-b', 'show me all hammers');
      assert.equal(reads(), before, 'a plain "show me" needs no model read');
      assert.equal(browse.trace.modelSkipped, 'browse_request');
      assert.equal(cards(browse, 'products')[0].props.products.length, dialogue.show.maxItems);
      await turn(service, 'ws-skip-b2', 'show me hammers for roofing');
      assert.equal(reads(), before + 1, 'something else was said, so the model reads it');
      // A tap that nothing on screen can read is not trusted to be understood.
      await turn(service, 'ws-skip-t', 'My answers:\nHow many do you need? → 12');
      assert.equal(reads(), before + 2);
      // A tenant can keep the model in every turn.
      const keepModel: any = { ...pack, extensions: { ...(pack.extensions ?? {}), dialoguePolicy: { modelReading: { skipForTappedAnswers: false, skipForBrowse: false } } } };
      const kept = await turn(service, 'ws-skip-off', 'show me all hammers', 1, keepModel);
      assert.equal(reads(), before + 3);
      assert.equal(kept.trace.modelSkipped, undefined);
    } finally { console.log = originalLog; }

    // Every turn prints one plain line: pack, knowledge release, how it matched, what was decided and why, cards, model use.
    const lines = logged.filter((line) => line.startsWith('[Turn] '));
    assert.equal(lines.length, 8, 'every turn prints one line, including the one that ended early');
    assert.ok(lines.some((line) => line.includes('no_match') && line.includes('ended early: no journey matched the request') && line.includes('cards: none')), 'a turn that matched nothing says so');
    const tapLine = lines.find((line) => line.includes('mops-and-brooms'))!;
    assert.match(tapLine, /^\[Turn\] pack \S+ \| knowledge okf-\S+@\w{12} \| direct_results · cleaners-and-cleaning-equipment\/mops-and-brooms \(pending_clarification\) \| decided show/);
    assert.match(tapLine, /cards: products \| model read: skipped \(tapped_answer\)$/);
    assert.ok(lines.some((line) => line.includes('decided ask [release question: cleaning_task]') && line.endsWith('model read: used')));
    assert.ok(lines.some((line) => line.includes('decided ask [built from products: facet_brand]')));
    const diagnostics = logged.find((line) => line.startsWith('[TurnDiagnostics]') && line.includes('facet_brand'))!;
    assert.match(diagnostics, /"conversationAction":"ask"/);
    assert.match(diagnostics, /"conversationQuestion":"facet:facet_brand"/);
  });

  await suite.test('a shelf that only price can split is shown as a list: a budget question never opens the conversation', async () => {
    const base: any = fixtureProducts.find((entry) => entry.sku === SKU_OF['DR-1']);
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];
    const prices = [15, 35, 60, 90, 130, 180, 240, 310, 400];
    await db.collection('products').insertMany(names.map((name, index) => {
      const { _id, ...rest } = { ...base, _id: undefined };
      return { ...rest, sku: `910${index}`, name: `Model ${name}`, priceUSD: { min: prices[index] } };
    }));
    const result = await turn(stack.serviceFor(), 'ws-price-only', 'drills');
    assert.equal(cards(result, 'clarify').length, 0, 'no budget question to start with');
    assert.equal(result.trace.conversation.action, 'show');
    assert.equal(cards(result, 'products')[0].props.products.length, dialogue.show.maxItems);
    assert.ok(result.trace.conversation.because.some((line: string) => line.includes('nothing to narrow by')));
    // A tenant that wants the budget asked first can say so.
    const budgetFirst: any = { ...pack, extensions: { ...(pack.extensions ?? {}), dialoguePolicy: { facets: { price: { askFirst: true } } } } };
    const asked = await turn(stack.serviceFor(), 'ws-price-first', 'drills', 1, budgetFirst);
    assert.equal(cards(asked, 'clarify')[0].props.questions[0].id, 'facet_price');
  });

  await suite.test('when the shop has nothing to show, or its search is broken, the shelf is not handed to a model: the question, then the tenant\'s plain sentence', async () => {
    const plain = 'I can\'t show products for that yet. Tell me a little more about what you need, or ask one of our specialists.';
    const error = 'Database connection required for catalog search';
    const calls: string[] = [];
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      const service = stack.serviceFor({ calls, searchError: error, reply: 'Thanks — I have set this to interior paint. The results on screen will now focus on that range.' });
      const first = await turn(service, 'ws-broken', 'paint');
      assert.deepEqual((first.uiInstructions as any[]).map((entry) => entry.component), ['clarify'], 'the release\'s question needs no products, so it is still asked');
      assert.ok(dialogue.templates.ask.includes(first.assistantMessage), first.assistantMessage);
      const question = cards(first, 'clarify')[0].props.questions[0];
      const tap = await turn(service, 'ws-broken', `My answers:\n${question.text} → ${question.options.find((option: any) => /interior/i.test(option.label)).value}`, 2);
      assert.equal(tap.assistantMessage, plain, 'plain words, not "the results on screen"');
      assert.equal(cards(tap, 'products').length, 0);
      assert.equal(tap.trace.conversation.action, 'empty');
      assert.ok(!calls.includes('response_generation'), 'no model was asked to word either turn');
      // A search that simply found nothing is answered the same way.
      const empty = await turn(stack.serviceFor({ calls }), 'ws-empty-shelf', 'toilet');
      assert.equal(empty.assistantMessage, plain);
      assert.equal(empty.trace.conversation.action, 'empty');
      assert.ok(!calls.includes('response_generation'));
      // A tenant that has the model word replies still gets the plain sentence for an empty shelf.
      const modelled = await turn(stack.serviceFor({ calls, reply: 'MODEL-IMPROVISED' }), 'ws-empty-model', 'toilet', 1, modelPack);
      assert.equal(modelled.assistantMessage, plain);
    } finally { console.log = originalLog; }
    // The log says why, in one line.
    const failing = lines.filter((line) => line.startsWith('[Turn] ') && line.includes('catalogue search: failed'));
    assert.equal(failing.length, 2);
    assert.ok(failing.every((line) => line.includes(error)));
    assert.ok(failing[1].includes('decided empty'));
    assert.ok(lines.some((line) => line.startsWith('[Turn] ') && line.includes('catalogue search: 0 products') && line.includes('decided empty')));
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
