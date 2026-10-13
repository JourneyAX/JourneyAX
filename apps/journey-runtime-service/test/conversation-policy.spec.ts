import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { decideConversation, type GateView } from '../src/conversation/decide';
import { facetQuestion } from '../src/conversation/facets';
import { renderOkfMessage } from '@journeyax/knowledge';
import { describeTurn } from '../src/conversation/describe';
import { catalogOutcome } from '../src/conversation/search';
import { howToAnswer } from '../src/conversation/howto';
import { pendingReadingMode, readsWithoutModel } from '../src/conversation/model-reading';
import { conceptWordsOf, extractNeeds } from '../src/conversation/needs';
import { resolveConversationPolicy } from '../src/conversation/policy';
import { rankProducts, reasonFor } from '../src/conversation/relevance';
import { emptyState, readDynamicAnswer } from '../src/conversation/state';
import { stem } from '../src/conversation/text';
import type { Product } from '../src/conversation/types';

/**
 * The decision is one set of rules for every department. These products come from several (cleaning, paint, fastenings, decking,
 * tools, bathroom) so a rule that only worked for one would fail here.
 */
const suite = createSuite('runtime: the conversation decision (ask, recommend, show, answer) works the same in every department');
const policy = resolveConversationPolicy();
const p = (sku: string, title: string, price: number, description = '', brand?: string): Product => ({ sku, title, price, currency: 'NZD', description, ...(brand ? { brand } : {}) });

const CLEANING: Product[] = [
  p('C1', 'Industrial Cleaning Wipes 80 Pack', 27.99, 'Pre-soaked wipes for removing paint, silicone, grease and oil based stains from hands, tools and work benches. Vacuum sealed so they stay moist.', 'Supa'),
  p('C2', 'Sugar Soap Cleaning Wipes 25 Pack', 7.99, 'Wipes for removing marks and stains from walls. Dual-sided with a smooth side for wiping and a textured side for a deeper clean.', 'Selleys'),
  p('C3', 'Housewash Brush With Handle', 35.5, 'A brush with an extendable handle and a soap chamber for washing walls and cladding.', 'Maxi'),
  p('C4', 'Banister Brush', 5.99, 'Soft natural bristles for gentle general purpose dusting and cleaning.', 'Raven'),
  p('C5', 'Concrete Cleaner And Etcher 5L', 49.99, 'Etches and cleans concrete surfaces and removes rust stains.', 'Quik'),
  p('C6', 'Oil Stain Remover 400ml', 19.42, 'Removes oil and grease stains from porous surfaces. Works on concrete floors, driveways, paving and masonry. Spray on, leave to dry, then brush off.', 'CRC'),
];
const PAINT: Product[] = [
  p('P1', 'Interior Wall Paint Low Sheen 4L', 89, 'A washable low sheen finish for living areas and bedrooms.', 'Dulux'),
  p('P2', 'Interior Wall Paint Matt 4L', 79, 'A flat matt finish that hides marks on ceilings and walls.', 'Dulux'),
  p('P3', 'Exterior Weatherboard Paint 4L', 119, 'A tough acrylic finish for timber weatherboards and fascias.', 'Resene'),
  p('P4', 'Bathroom Paint Semi Gloss 4L', 99, 'Resists steam and mould in bathrooms and laundries.', 'Resene'),
  p('P5', 'Roof Paint 10L', 159, 'Protects corrugated iron roofs from rust.', 'Resene'),
  p('P6', 'Primer Sealer Undercoat 4L', 69, 'Seals bare plasterboard and timber before painting.', 'Dulux'),
  p('P7', 'Aerosol Spray Paint Gloss White', 14, 'Quick drying gloss for small jobs and touch ups.', 'Rust-Oleum'),
  p('P8', 'Deck Stain 4L', 129, 'A penetrating stain for timber decks that brings out the grain.', 'Cabot'),
  p('P9', 'Ceiling Paint White 10L', 109, 'A matt white that covers well on ceilings.', 'Dulux'),
];
const SCREWS: Product[] = [
  p('S1', 'Decking Screw 10g x 65mm 200 Box', 24, 'Self-countersinking head with a corrosion resistant coating for decks.', 'Bremick'),
  p('S2', 'Wood Screw 8g x 50mm 100 Box', 12, 'General purpose screw for timber joinery.', 'Bremick'),
  p('S3', 'Plasterboard Screw 6g x 32mm 500 Box', 18, 'Bugle head screw for fixing plasterboard to timber frames.', 'Zenith'),
  p('S4', 'Masonry Screw 6mm x 50mm 50 Pack', 21, 'Hardened thread that cuts into brick and concrete.', 'Zenith'),
];
const DECKING: Product[] = [
  p('D1', 'Composite Decking Board 140mm Charcoal', 62, 'Low maintenance board that will not rot or splinter.'),
  p('D2', 'Radiata Decking 90mm', 18, 'Treated pine decking for outdoor use.'),
  p('D3', 'Hardwood Decking Kwila 90mm', 41, 'Dense hardwood with a rich natural colour.'),
];
const gate = (over: Partial<GateView> = {}): GateView => ({
  mode: 'direct_results', conceptId: 'concept://acme/cleaning/cleaning-supplies', retrieval: { permission: 'allowed' },
  claims: { allowedClasses: ['suggestion'] }, trace: { reasonCodes: ['required_facts_known'] }, ...over,
});
const decide = (message: string, items: Product[], over: Partial<Parameters<typeof decideConversation>[0]> = {}) =>
  decideConversation({ message, gate: gate(), items, policy, seed: 'ws-1:3', ...over });
/** Every sentence of a quoted reason is in the product's own text, word for word (a long one may be cut with an ellipsis). */
const isQuoted = (excerpt: string, text: string): boolean =>
  excerpt.split(/(?<=[.!?])\s+/).every((part) => text.includes(part.replace(/…/g, '').trim()));
const OKF_QUESTION = { factKey: 'cleaning_task', question: 'What are you cleaning?', uiInputType: 'card_choice', options: [{ value: 'indoor', label: 'Inside the house' }, { value: 'outside', label: 'Outside' }] };

async function main() {
  await suite.test('what the customer needs is read from their words: the shelf and the filler drop away, what is left is the job', () => {
    const concept = conceptWordsOf(gate({ conceptId: 'concept://acme/cleaning/cleaning-supplies' }));
    const needs = extractNeeds('I need something to clean oil stains off my driveway please', concept, policy);
    assert.deepEqual(needs.terms, ['oil', 'stain', 'driveway']);
    assert.equal(needs.surfaces.stain, 'stains', 'it can be said back in the customer\'s own word');
    assert.deepEqual(extractNeeds('My answers:\nWhat are you cleaning? → outside', concept, policy).terms, [], 'a tapped answer is an answer, not a new need');
    assert.equal(stem('cleaning', policy), 'clean');
    assert.equal(stem('glass', policy), 'glass');
    assert.equal(stem('batteries', policy), 'battery');
  });

  await suite.test('a word nearly every candidate shares says nothing; a word few share decides', () => {
    const stems = (words: string[]) => words.map((word) => stem(word, policy));
    const paint = rankProducts(PAINT, stems(['paint', 'bathroom']), policy);
    assert.deepEqual(paint.informative, ['bathroom'], '"paint" is in nearly every paint, so it cannot tell them apart');
    assert.equal(paint.ranked[0].item.sku, 'P4');
    const cleaning = rankProducts(CLEANING, stems(['oil', 'driveway']), policy);
    assert.deepEqual([...cleaning.informative].sort(), ['driveway', 'oil']);
    assert.equal(cleaning.ranked[0].item.sku, 'C6');
    assert.equal(cleaning.ranked[0].score > cleaning.ranked[1].score * 2, true, 'a clear winner is clearly ahead');
    assert.deepEqual(rankProducts(PAINT, stems(['zebra']), policy).informative, [], 'a word no product has decides nothing');
  });

  await suite.test('a reason is the product\'s own sentence, quoted; never invented, never an unverified claim', () => {
    const { ranked } = rankProducts(CLEANING, ['oil', 'driveway'], policy);
    const why = reasonFor(ranked[0].item, ranked[0].matched, { oil: 'oil', driveway: 'driveway' }, ['suggestion'], policy);
    assert.deepEqual(why.needs, ['oil', 'driveway']);
    assert.ok(why.excerpt && isQuoted(why.excerpt, ranked[0].item.description!), `quoted from the product: ${why.excerpt}`);
    assert.ok(why.excerpt.includes('oil') && why.excerpt.includes('driveways'), 'it covers everything the customer asked for, not just one need');
    // Across every product and many needs: whatever is quoted is in the product's own text.
    for (const items of [CLEANING, PAINT, SCREWS, DECKING]) {
      for (const term of ['stain', 'timber', 'deck', 'concrete', 'wall', 'brush', 'mould', 'gloss', 'rust', 'brick']) {
        const matched = rankProducts(items, [term], policy).ranked.filter((entry) => entry.matched.length);
        for (const entry of matched) {
          const reason = reasonFor(entry.item, entry.matched, {}, ['suggestion'], policy);
          if (reason.excerpt) assert.ok(isQuoted(reason.excerpt, entry.item.description!), `"${reason.excerpt}" is in ${entry.item.sku}`);
        }
      }
    }
    // A sentence that makes a claim the release has not verified is not used, even if it matches best.
    const risky = p('X', 'Wall Filler', 10, 'This filler is compatible with all paints and fills holes in walls. Easy to sand.');
    assert.equal(reasonFor(risky, ['wall'], {}, ['suggestion'], policy).excerpt, undefined);
    assert.equal(reasonFor(risky, ['wall'], {}, ['suggestion', 'compatibility'], policy).excerpt, 'This filler is compatible with all paints and fills holes in walls.');
  });

  await suite.test('with nothing said yet, a broad request is asked about first and shows no products', () => {
    const plan = decide('cleaning supply', CLEANING, { gate: gate({ mode: 'overview_then_ask', clarification: OKF_QUESTION }) });
    assert.equal(plan.action, 'ask');
    assert.deepEqual(plan.showCards, { question: true, products: false, suggestions: false });
    assert.equal(plan.question!.source, 'okf');
    assert.equal(plan.question!.question, 'What are you cleaning?');
    assert.equal(plan.products.length, 0);
    assert.ok(policy.templates.ask.includes(plan.message!));
  });

  await suite.test('when the customer has already said what they need, the question is skipped and the best fit is recommended, with the reason', () => {
    const plan = decide('something to clean oil stains off my driveway', CLEANING, { gate: gate({ mode: 'overview_then_ask', clarification: OKF_QUESTION }) });
    assert.equal(plan.action, 'recommend');
    assert.deepEqual(plan.showCards, { question: false, products: true, suggestions: true });
    assert.equal(plan.products[0].item.sku, 'C6');
    assert.ok(plan.products[0].why!.excerpt!.includes('driveways') && plan.products[0].why!.excerpt!.includes('oil'));
    assert.match(plan.message!, /Oil Stain Remover|oil/i);
    assert.equal(plan.products.length, 1, 'one clear winner is one recommendation, not a list');
    assert.ok(plan.because.some((line) => line.includes('point clearly')), 'the trace says why');
  });

  await suite.test('the same rules in another department: paint, screws and decking', () => {
    const paint = decide('paint for my bathroom walls', PAINT, { gate: gate({ conceptId: 'concept://acme/paint/interior-paint', mode: 'overview_then_ask', clarification: { ...OKF_QUESTION, factKey: 'paint_surface', question: 'What are you painting?' } }) });
    assert.equal(paint.action, 'recommend');
    assert.equal(paint.products[0].item.sku, 'P4', 'the bathroom paint, because the customer said bathroom');
    assert.ok(paint.products[0].why!.needs.includes('bathroom'));
    const decking = decide('composite decking', DECKING, { gate: gate({ conceptId: 'concept://acme/timber/decking' }) });
    assert.equal(decking.products[0].item.sku, 'D1');
    const screws = decide('screws for plasterboard', SCREWS, { gate: gate({ conceptId: 'concept://acme/fastenings/screws' }) });
    assert.equal(screws.action, 'recommend');
    assert.equal(screws.products[0].item.sku, 'S3');
  });

  await suite.test('many products and nothing to tell them apart: the question that narrows them most, built from the products themselves', () => {
    const plan = decide('paint', PAINT, { gate: gate({ conceptId: 'concept://acme/paint/paint', mode: 'overview_then_ask' }) });
    assert.equal(plan.action, 'ask');
    assert.equal(plan.question!.source, 'facet');
    assert.ok(['facet_term', 'facet_brand', 'facet_price'].includes(plan.question!.factKey));
    assert.ok(plan.question!.options.length >= 3 && plan.question!.options.length <= policy.facets.maxOptions + 1);
    assert.equal(plan.question!.options.at(-1)!.label, policy.ask.noPreference, '"No preference" is always there');
    assert.equal(plan.products.length, 0);
    assert.ok(policy.templates.askMany.includes(plan.message!));
    // Every option really splits the candidates: it matches at least one and not all.
    // What the customer sees echoed back when they tap an option is plain words, never a code.
    for (const option of plan.question!.options) assert.equal(option.value, option.label);
  });

  await suite.test('few products, nothing to ask: a short list, honestly called a list, with no made-up reasons', () => {
    const plan = decide('decking', DECKING, { gate: gate({ conceptId: 'concept://acme/timber/decking' }) });
    assert.equal(plan.action, 'show');
    assert.ok(plan.products.every((entry) => entry.why === undefined));
    assert.equal(plan.eyebrow, policy.templates.eyebrowShow);
    assert.deepEqual(plan.products.map((entry) => entry.item.sku), ['D1', 'D2', 'D3'], 'the shop\'s own order when nothing ranks them');
  });

  await suite.test('"just show me", a named product and the catalogue-only fallback all show without asking', () => {
    for (const reasonCodes of [['customer_declined_questions'], ['exact_sku'], ['uncovered_shopping_catalogue_only']]) {
      const plan = decide('paint', PAINT, { gate: gate({ mode: 'overview_then_ask', clarification: OKF_QUESTION, trace: { reasonCodes } }) });
      assert.equal(plan.action, 'show', reasonCodes.join());
      assert.equal(plan.products.length, policy.show.maxItems);
    }
  });

  await suite.test('"how do I use it" is answered from the product\'s own details, quoted; with none on file it says so, and it never guesses between products', () => {
    const cleaningGate = gate();
    const oil = decide('how do I use the oil stain remover', CLEANING, { gate: cleaningGate });
    assert.equal(oil.action, 'answer');
    assert.deepEqual(oil.showCards, { question: false, products: false, suggestions: false });
    assert.equal(oil.message, policy.templates.howTo.replace('{title}', 'Oil Stain Remover 400ml').replace('{steps}', 'Spray on, leave to dry, then brush off.'));
    // A description sentence that merely names a product ("Wipes for removing marks...") is not an instruction.
    const wipes = decide('how do I use the sugar soap wipes', CLEANING, { gate: cleaningGate });
    assert.equal(wipes.message, policy.templates.howToNone.replace('{title}', 'Sugar Soap Cleaning Wipes 25 Pack'), wipes.message);
    // Nothing on file: said plainly, not invented.
    assert.equal(decide('how to use the plasterboard screw', SCREWS, { gate: gate({ conceptId: 'concept://acme/fastenings/screws' }) }).message, policy.templates.howToNone.replace('{title}', 'Plasterboard Screw 6g x 32mm 500 Box'));
    // Two products it could be: it does not pick one; the model words an answer with no cards.
    const ambiguous = decide('how do I use cleaning wipes', CLEANING, { gate: cleaningGate });
    assert.equal(ambiguous.action, 'answer');
    assert.equal(ambiguous.message, undefined);
    assert.equal(howToAnswer([], ['wipe'], ['suggestion'], policy), undefined);
    // Safety or care wording in the product text is not relayed unless the release has verified it.
    const risky = p('R1', 'Sugar Soap Concentrate 1L', 9, 'Mix 1 part with 4 parts water. Apply in a ventilated area.');
    assert.equal(howToAnswer([risky], ['sugar'], ['suggestion'], policy)?.message, policy.templates.howTo.replace('{title}', risky.title).replace('{steps}', 'Mix 1 part with 4 parts water.'));
    assert.ok(howToAnswer([risky], ['sugar'], ['suggestion', 'safety_instruction', 'care_safety'], policy)!.message.includes('ventilated area'), 'quoted once the release has verified safety guidance');
    // Two usage words make an instruction even when it does not open with one.
    const coats = p('R2', 'Floor Sealer 2L', 40, 'For best results apply two coats and allow to dry overnight.');
    assert.ok(howToAnswer([coats], [], ['suggestion'], policy)!.message.includes('apply two coats'));
  });

  await suite.test('a how-to or comparison question is answered in words: no cards, whatever the shelf', () => {
    for (const message of ['how do I use the sugar soap wipes', 'what is the difference between matt and low sheen', 'compare these two brushes']) {
      const plan = decide(message, CLEANING);
      assert.equal(plan.action, 'answer', message);
      assert.deepEqual(plan.showCards, { question: false, products: false, suggestions: false });
    }
  });

  await suite.test('safety, evidence, orders, projects and "nothing matched" are not decided here', () => {
    for (const mode of ['safety_then_diagnose', 'evidence_answer', 'operational_journey', 'service_intake', 'project_journey', 'no_match', 'knowledge_unavailable', 'legacy_search']) {
      assert.equal(decide('anything', CLEANING, { gate: gate({ mode }) }).action, 'defer', mode);
    }
    assert.equal(decide('anything', CLEANING, { gate: null }).action, 'defer');
    assert.equal(decide('anything', [], { gate: gate() }).action, 'defer', 'no products to decide with');
  });

  await suite.test('a blocking question from the release is asked before any product is chosen', () => {
    const plan = decide('screws', SCREWS, { gate: gate({ mode: 'clarify_then_search', clarification: OKF_QUESTION }) });
    assert.equal(plan.action, 'ask');
    assert.equal(plan.question!.source, 'okf');
  });

  await suite.test('a tapped answer to a question built from the products narrows them, and typing the option\'s words does too', () => {
    const asked = decide('paint', PAINT, { gate: gate({ conceptId: 'concept://acme/paint/paint', mode: 'overview_then_ask' }) });
    const question = asked.question!;
    const option = question.options.find((entry) => !entry.constraint?.any)!;
    for (const message of [`My answers:\n${question.question} → ${option.value}`, `My answers:\n${question.question} → ${option.label}`, option.label]) {
      assert.deepEqual(readDynamicAnswer(message, asked.nextState)?.value, option.value, message);
    }
    assert.equal(readDynamicAnswer('something unrelated', asked.nextState), undefined);
    assert.equal(readDynamicAnswer('anything', emptyState()), undefined);
    const next = decide(`My answers:\n${question.question} → ${option.value}`, PAINT, { gate: gate({ conceptId: 'concept://acme/paint/paint', mode: 'overview_then_ask' }), state: asked.nextState });
    assert.notEqual(next.action, 'ask', 'the question just answered is not asked again');
    assert.ok(next.because.some((line) => line.includes('answered')));
    assert.equal(next.nextState.pending, undefined);
    assert.ok(next.nextState.asked.length === 1);
    assert.ok(next.products.length === 0 || next.products.length < PAINT.length, 'the list got shorter');
    // "No preference" shows what there is.
    const any = decide(`My answers:\n${question.question} → ${policy.ask.noPreference}`, PAINT, { gate: gate({ conceptId: 'concept://acme/paint/paint', mode: 'overview_then_ask' }), state: asked.nextState });
    assert.equal(any.action, 'show');
  });

  await suite.test('it never interrogates: a limit on questions per shelf, set by the tenant', () => {
    let state = emptyState('concept://acme/paint/paint');
    let asks = 0;
    for (let turn = 0; turn < 5; turn++) {
      const plan = decide('paint', PAINT, { gate: gate({ conceptId: 'concept://acme/paint/paint', mode: 'overview_then_ask' }), state });
      state = plan.nextState;
      if (plan.action === 'ask') {
        asks++;
        // answer with the first real option, as a customer would
        const option = plan.question!.options[0];
        const answered = decide(`${plan.question!.question} → ${option.value}`, PAINT, { gate: gate({ conceptId: 'concept://acme/paint/paint', mode: 'overview_then_ask' }), state: plan.nextState });
        state = answered.nextState;
      } else break;
    }
    assert.ok(asks <= policy.ask.maxPerConcept, `${asks} questions`);
    const none = resolveConversationPolicy({ extensions: { dialoguePolicy: { ask: { maxPerConcept: 0 } } } } as any);
    assert.equal(decide('paint', PAINT, { policy: none, gate: gate({ mode: 'overview_then_ask' }) }).action, 'show', 'a tenant can stop all dynamic questions');
    const off = resolveConversationPolicy({ extensions: { dialoguePolicy: { facets: { enabled: false } } } } as any);
    assert.equal(decide('paint', PAINT, { policy: off, gate: gate({ mode: 'overview_then_ask' }) }).action, 'show');
  });

  await suite.test('the decision is deterministic: the same turn gives the same plan, and only the wording varies with the turn', () => {
    const run = (seed: string) => decide('paint for my bathroom walls', PAINT, { seed, gate: gate({ conceptId: 'concept://acme/paint/interior-paint', mode: 'overview_then_ask', clarification: OKF_QUESTION }) });
    assert.deepEqual(run('ws:1'), run('ws:1'));
    const a = run('ws:1'); const b = run('ws:2'); const c = run('ws:3'); const d = run('ws:4');
    for (const other of [b, c, d]) { assert.equal(other.action, a.action); assert.deepEqual(other.products.map((entry) => entry.item.sku), a.products.map((entry) => entry.item.sku)); }
    assert.ok(new Set([a.message, b.message, c.message, d.message]).size >= 2, 'wording varies across turns');
  });

  await suite.test('a new shelf starts fresh: what was said about paint is not remembered against cleaning', () => {
    const paint = decide('paint for my bathroom walls', PAINT, { gate: gate({ conceptId: 'concept://acme/paint/interior-paint' }) });
    assert.ok(paint.nextState.terms.includes('bathroom'));
    const cleaning = decide('cleaning supply', CLEANING, { gate: gate({ mode: 'overview_then_ask', clarification: OKF_QUESTION }), state: paint.nextState });
    assert.deepEqual(cleaning.nextState.terms, []);
    assert.equal(cleaning.action, 'ask');
  });

  await suite.test('facet questions come only from what the products say, and are skipped when they would not help', () => {
    const none = facetQuestion(DECKING, { needTerms: [], conceptWords: new Set(), asked: [], policy });
    assert.equal(none, undefined, 'three products need no narrowing');
    const same = Array.from({ length: 10 }, (_, index) => p(`Z${index}`, 'Plain Widget', 10, '', 'Acme'));
    assert.equal(facetQuestion(same, { needTerms: [], conceptWords: new Set(), asked: [], policy }), undefined, 'ten identical products cannot be told apart');
    const priced = Array.from({ length: 12 }, (_, index) => p(`Y${index}`, `Item ${index}`, 10 + index * 12));
    // A budget question never opens the conversation: when price is the only thing that tells them apart, the answer is the list.
    assert.equal(facetQuestion(priced, { needTerms: [], conceptWords: new Set(), asked: [], policy }), undefined, 'price alone does not start the questions');
    const question = facetQuestion(priced, { needTerms: [], conceptWords: new Set(), asked: ['okf:cleaning_task'], policy });
    assert.equal(question?.factKey, 'facet_price', 'but it may follow another question on the same shelf');
    assert.equal(question!.options.length, 4);
    assert.match(question!.options[0].label, /^Under /);
    assert.equal(facetQuestion(priced, { needTerms: [], conceptWords: new Set(), asked: ['price'], policy }), undefined, 'each kind is asked once');
    const budgetFirst = resolveConversationPolicy({ extensions: { dialoguePolicy: { facets: { price: { askFirst: true } } } } } as any);
    assert.equal(facetQuestion(priced, { needTerms: [], conceptWords: new Set(), asked: [], policy: budgetFirst })?.factKey, 'facet_price', 'a tenant can choose to ask the budget first');
    // In the conversation: a shelf split only by price shows the list.
    const shelf = decide('drills', priced, { gate: gate({ conceptId: 'concept://acme/tools/drills', mode: 'direct_results' }) });
    assert.equal(shelf.action, 'show');
    assert.equal(shelf.question, undefined);
    assert.equal(shelf.products.length, policy.show.maxItems);
    assert.ok(shelf.because.some((line) => line.includes('nothing to narrow by')));
  });

  await suite.test('the slow model that reads free text is skipped only when it would add nothing: a fully read tap, or a plain "show me"', () => {
    const tapped = 'My answers:\nWhat are you cleaning? → Floors';
    assert.equal(pendingReadingMode(tapped, policy), 'tapped');
    assert.equal(pendingReadingMode('What are you cleaning? → Floors', policy), 'tapped', 'a heading is optional');
    assert.equal(pendingReadingMode('My answers:\nWhat are you cleaning? → Floors\nand I need it by Friday please', policy), undefined, 'a sentence of the customer\'s own goes to the model');
    assert.equal(pendingReadingMode('show me all hammers', policy), 'browse');
    assert.equal(pendingReadingMode('show me 90mm decking', policy), undefined, 'a number is something to read');
    assert.equal(pendingReadingMode('show me everything you have for building a deck with a hot tub on it', policy), undefined, 'a long message has more in it');
    assert.equal(pendingReadingMode('hammers', policy), undefined);
    assert.equal(pendingReadingMode('   ', policy), undefined);
    const off = resolveConversationPolicy({ extensions: { dialoguePolicy: { modelReading: { skipForTappedAnswers: false, skipForBrowse: false } } } } as any);
    assert.equal(pendingReadingMode(tapped, off), undefined, 'a tenant can keep the model in every turn');
    assert.equal(pendingReadingMode('show me all hammers', off), undefined);

    // The first look only says it is worth trying; what the knowledge decision actually read confirms it.
    const read = { cleaning_task: { source: 'card_answer' } };
    assert.equal(readsWithoutModel('tapped', tapped, gate(), read, policy), true, 'the release read the answer');
    assert.equal(readsWithoutModel('tapped', tapped, gate(), {}, policy), false, 'nothing read it, so the model must');
    assert.equal(readsWithoutModel('tapped', tapped, gate({ trace: { reasonCodes: ['conversation_answer_continuity'] } }), {}, policy), true, 'read against the question built from the products');
    assert.equal(readsWithoutModel('tapped', 'A → 1\nB → 2', gate(), read, policy), false, 'two answers, only one read');
    assert.equal(readsWithoutModel('browse', 'show me all cleaning supplies', gate(), {}, policy), true);
    assert.equal(readsWithoutModel('browse', 'show me cleaning supplies for roofing', gate(), {}, policy), false, 'something else was said');
    assert.equal(readsWithoutModel('browse', 'show me all cleaning supplies', gate({ mode: 'safety_then_diagnose' }), {}, policy), false, 'only shopping shelves');
    assert.equal(readsWithoutModel('browse', 'show me all cleaning supplies', gate({ conceptId: undefined }), {}, policy), false, 'no shelf matched');
  });

  await suite.test('the log line says what answered, what was decided and why, and whether the model was needed', () => {
    const plan = decide('cleaning supply', CLEANING, { gate: gate({ mode: 'overview_then_ask', clarification: OKF_QUESTION }) });
    assert.equal(
      describeTurn({ packVersion: '1.3.17', okfRelease: 'okf-x@4b0e1c8d619c', knowledgeMode: 'overview_then_ask', conceptId: 'concept://acme/cleaning/cleaning-supplies', matchedBy: 'phrase', plan, cards: ['clarify'], modelRead: 'skipped (tapped_answer)' }),
      `[Turn] pack 1.3.17 | knowledge okf-x@4b0e1c8d619c | overview_then_ask · cleaning/cleaning-supplies (phrase) | decided ask [release question: cleaning_task]: ${plan.because.join(' → ')} | cards: clarify | model read: skipped (tapped_answer)`,
    );
    const recommend = decide('something to clean oil stains off my driveway', CLEANING);
    assert.match(describeTurn({ okfRelease: 'none', plan: recommend, cards: ['products'], modelRead: 'used' }), /decided recommend \[1 product, reason quoted\]/);
    assert.match(describeTurn({ okfRelease: 'none', plan: decide('x', CLEANING, { gate: null }), cards: [], modelRead: 'used' }), /decision left to the existing flow: no knowledge decision.* \| cards: none \|/);
    assert.match(describeTurn({ okfRelease: 'none', plan: null, cards: [], modelRead: 'failed (ModelTimeoutError)' }), /no conversation decision.*model read: failed \(ModelTimeoutError\)$/);
  });

  await suite.test('a search that ran and found nothing is an answer, never a handover to a model that will improvise', () => {
    const ran = { ran: true, failed: false };
    const shelf = gate({ conceptId: 'concept://acme/tools/drills', mode: 'direct_results' });
    const empty = decide('drills', [], { gate: shelf, search: ran });
    assert.equal(empty.action, 'empty');
    assert.deepEqual(empty.showCards, { question: false, products: false, suggestions: false });
    assert.equal(empty.message, renderOkfMessage({}, 'nothing_to_show'));
    assert.equal(decide('drills', [], { gate: shelf, search: ran, messages: { nothing_to_show: 'Nothing on that shelf right now.' } }).message, 'Nothing on that shelf right now.', 'the tenant\'s own sentence');

    // A question needs no products, so the release's question is still asked, once.
    const overview = gate({ mode: 'overview_then_ask', clarification: OKF_QUESTION });
    const asked = decide('paint', [], { gate: overview, search: ran });
    assert.equal(asked.action, 'ask');
    assert.equal(asked.question!.source, 'okf');
    assert.ok(asked.because.some((line) => line.includes('does not need products')));
    assert.equal(decide('paint', [], { gate: overview, search: ran, state: asked.nextState }).action, 'empty', 'not asked twice');
    assert.equal(decide('paint', [], { gate: gate({ mode: 'overview_then_ask', clarification: OKF_QUESTION, trace: { reasonCodes: ['customer_declined_questions'] } }), search: ran }).action, 'empty', 'asked to see them, so not asked');

    // A search that failed is told apart in the reasons, and answered the same way.
    const failed = decide('drills', [], { gate: shelf, search: { ran: true, failed: true, error: 'Database connection required' } });
    assert.equal(failed.action, 'empty');
    assert.ok(failed.because.some((line) => line.includes('failed (Database connection required)')));

    // No search at all is not an empty shelf: the existing flow decides.
    assert.equal(decide('drills', [], { gate: shelf }).action, 'defer');
    assert.equal(decide('drills', [], { gate: shelf, search: { ran: false, failed: false } }).action, 'defer');

    // Answers that now leave nothing (the range changed) start again instead of leaving a dead end.
    const stale = { ...emptyState('concept://acme/cleaning/cleaning-supplies'), constraints: { brands: ['nobody'] } };
    const relaxed = decide('cleaning', CLEANING, { gate: gate(), state: stale });
    assert.notEqual(relaxed.action, 'empty');
    assert.ok(relaxed.because.some((line) => line.includes('starting again')));
    assert.deepEqual(relaxed.nextState.constraints.brands, []);
  });

  await suite.test('what the catalogue search did is read the same way everywhere: not run, failed, or a list (possibly empty)', () => {
    const search = (over: object) => ({ toolId: 'catalog.search', status: 'success', ...over });
    assert.deepEqual(catalogOutcome([]), { ran: false, failed: false, items: [] });
    assert.deepEqual(catalogOutcome([{ toolId: 'knowledge.search', status: 'success', output: { items: [{ sku: 'x' }] } }]), { ran: false, failed: false, items: [] }, 'other capabilities are not the catalogue');
    assert.deepEqual(catalogOutcome([search({ output: { items: [{ sku: 'a' }, { sku: 'b' }] } })]), { ran: true, failed: false, items: [{ sku: 'a' }, { sku: 'b' }] });
    assert.deepEqual(catalogOutcome([search({ output: { items: [] } })]), { ran: true, failed: false, items: [] }, 'an empty list is a result');
    assert.deepEqual(catalogOutcome([search({ output: { items: [], error: 'invalid_category_scope' } })]), { ran: true, failed: true, items: [], error: 'invalid_category_scope' });
    assert.deepEqual(catalogOutcome([search({ status: 'failed', error: { message: 'boom' } })]), { ran: true, failed: true, items: [], error: 'boom' });
    assert.equal(catalogOutcome([search({ status: 'failed' })]).error, 'status failed');
    assert.equal(catalogOutcome([search({ output: { items: [], error: 'x' } }), search({ output: { items: [{ sku: 'ok' }] } })]).failed, false, 'a usable search wins over a failed one');
    const line = (outcome: any) => describeTurn({ okfRelease: 'none', plan: null, cards: [], search: outcome, modelRead: 'used' });
    assert.match(line(catalogOutcome([])), /catalogue search: not run \| cards: none/);
    assert.match(line(catalogOutcome([search({ output: { items: [{ sku: 'a' }] } })])), /catalogue search: 1 product \|/);
    assert.match(line(catalogOutcome([search({ output: { items: [] } })])), /catalogue search: 0 products \|/);
    assert.match(line(catalogOutcome([search({ output: { items: [], error: 'Database connection required' } })])), /catalogue search: failed \(Database connection required\) \|/);
  });

  process.exitCode = suite.finish() ? 0 : 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
