/**
 * The claim guard must remove sentences that state an unsupported fact, and only those.
 *
 * Two fixed sets protect both sides of that:
 *  - sentences a model really wrote in the 25-chat measurement and the guard withheld, none of which stated a wrong fact (they must be kept);
 *  - claims invented for this test (a made-up warranty, price, stock level, install step, compliance claim…) that must still be removed.
 * A change that makes the first set pass by letting the second set through is a loosening, not a fix.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateOkfGeneratedClaims, withholdUnsupportedClaims } from '../src/kernel/okf-claim-validator';
import { ConversationPolicySchema } from '@journeyax/business-pack';
import { chooseWithheldFallback, needsRepair, DEFAULT_FOUND_MESSAGE, foundMessageOf } from '../src/agent/withheld-fallback';

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const packOptions = { locale: 'en-NZ', referrals: draft.conversationPolicy?.referrals, extraClaimPatterns: draft.conversationPolicy?.extraClaimPatterns };

// What the tools returned in those chats: product titles and group names.
const knownNames = [
  'Makita 12V CXT combo kit', 'Makita cordless hammer drill combo kit', 'Makita cordless hammer drill/impact driver combo kit',
  'Milwaukee M18 right-angle drill', 'Milwaukee M18 FUEL cordless magnetic drill', '18V cordless drill', 'cordless drill', 'hammer drill',
  'wire wardrobe kit', 'drill bits', 'deep hole pencil', 'exterior paint',
];
// The titles among them; "hammer drill" and "drill bits" are group names, not a product.
const productNames = ['Makita 12V CXT combo kit', 'Makita cordless hammer drill combo kit', 'Makita cordless hammer drill/impact driver combo kit', 'Milwaukee M18 right-angle drill', 'Milwaukee M18 FUEL cordless magnetic drill', '18V cordless drill'];
const judge = (text: string, names: string[] | undefined = knownNames) => validateOkfGeneratedClaims(text, ['suggestion'], packOptions, { knownNames: names });

// ── 1. Real sentences that were withheld and were not wrong ───────────────────────────────────────────────────────────────────────────────
const keptSentences = [
  // plain findings and recommendations from the catalogue
  'Good news, we found a Makita cordless hammer drill combo kit that looks the best fit from the options returned.',
  'Good news, I found one clear fit in our range: the Makita 12V CXT combo kit includes a brushless **hammer driver drill** plus an impact driver.',
  'Good news, we found a Makita cordless hammer drill/impact driver combo that’s the better fit from the matches.',
  'Good options from our range include the Makita cordless hammer drill/impact driver combo kit if you want a kit setup, or the 18V cordless drill if you’re after a simpler drill option.',
  'I did find cordless drill products in our range, including an 18V cordless drill, a Milwaukee M18 right-angle drill, a Milwaukee M18 FUEL cordless magnetic drill, and a Makita 12V cordless brushless hammer drill/impact driver combo kit.',
  'For that size, the closest ready option I found is the 1.2–2.4 m wire wardrobe kit, which fits a 1200 mm space.',
  // honest "I could not confirm"
  'I couldn’t confirm a specific installation or warranty note for this board from the information I found just now.',
  'I couldn’t verify an installation guide or warranty details for these from the documents I found, so our branch team or the manufacturer’s documentation should confirm the exact install and warranty requirements.',
  'I don’t have the installation guide or a verified warranty certificate for this exact product to hand.',
  'I also found that our drill range commonly links to drill bits, screwdriver bits, and batteries/chargers, but I can’t confirm the correct concrete-drilling setup without more detail.',
  'I also showed a lower-cost cordless drill option, but its details don’t confirm hammer-drill capability, so I’d treat that as light-duty only.',
  'We also found a lower-cost cordless drill, but its listing doesn’t confirm hammer-drill capability, so I’d only choose that if you can confirm it’s suitable for masonry.',
  // hedged suggestions of what usually goes with a product
  'Drills commonly go with **masonry drill bits**, and if you choose a tool-only option you may also need a **battery and charger**.',
  'Drills commonly go with masonry drill bits, battery and charger, and screwdriver bits, depending on what you already have.',
  'For concrete drilling, also check the right masonry drill bits, and whether the drill is a skin-only tool or comes with battery and charger — our drill range commonly pairs with drill bits, screwdriver bits, and batteries/chargers.',
  'For concrete, also check you’ve got the right masonry drill bits, and if the tool is sold as a “skin” or bare tool, you may need a compatible battery and charger.',
  '- For a complete deck, you’ll usually need to check the matching fixings/system parts, framing timber, joists, bearers, balustrade if required, and finishing trims.',
  // requests to the customer, written as statements
  'A few quick choices will help sort the size, look and whether it needs to handle foot traffic only or vehicles.',
  'To narrow it down properly, tell me what you’re lining and roughly how much area you need to cover.',
  'To point you at the right product, I just need to narrow down what part of the job you’re doing.',
  // referrals to a professional
  'For wet-area compliance, especially around showers or waterproofing, please check the manufacturer’s current GIB wet-area guidance or speak with our branch team or an LBP.',
  'If you’re setting out levels, foundations or boundaries, it’s worth confirming the method with your builder, surveyor or LBP where accuracy or compliance matters.',
  // what a product is for, and a typo read back to the customer
  'The deep hole pencil is handy where you need to mark through brackets, framing or awkward holes.',
  'The Milwaukee right-angle drill is more for tight spaces and drilling/fastening, so I wouldn’t make that the first pick for concrete unless access is the issue.',
  'The standard cordless drill may suit lighter jobs only, but you’d need to confirm it has the hammer function and capacity you need before using it on concrete.',
  'Kia ora — I’m taking “cordles drll” as cordless drill.',
  // general trade know-how, hedged, that names no installation action
  'For concrete, you’ll generally want a cordless **hammer drill** rather than a standard drill.',
  'For concrete, you’ll generally want a cordless hammer drill rather than a standard drill.',
  'For concrete, you’ll want a hammer drill function rather than a standard drill-only tool.',
];
for (const sentence of keptSentences) {
  const verdict = judge(sentence);
  assert.deepEqual(verdict.forbidden, [], `a sentence that states no wrong fact must be kept: ${sentence}`);
  assert.equal(withholdUnsupportedClaims(sentence, ['suggestion'], packOptions, { knownNames }).text, sentence, `kept whole: ${sentence}`);
}
assert.equal(keptSentences.length, 29);

// Two of the 31 stay withheld by this guard on purpose. They are handled by the repair round (the model is asked to say it from what the
// tools returned) and, for hedged general know-how, by the pack setting, not by loosening the words.
assert.deepEqual(judge('Yes — good news, we have exterior paint suitable for exterior walls, and our range also includes the prep gear that usually goes with repainting weatherboards.').forbidden, ['compatibility']);
assert.deepEqual(judge('For drilling into concrete, you’ll generally want a cordless hammer drill rather than a standard drill, plus masonry drill bits.').forbidden, ['installation_step']);

// The product names are what make the difference for "wire wardrobe" and the like, but a plain sentence about the thing is judged by what it says.
assert.deepEqual(validateOkfGeneratedClaims('We have a Wire Wardrobe Kit and a Mounting Bracket 90mm in our range.', ['suggestion'], packOptions).forbidden, []);
assert.deepEqual(validateOkfGeneratedClaims('We have a cordless drill in our range.', ['suggestion'], packOptions).forbidden, []);

// ── 2. Invented claims that must still be removed ─────────────────────────────────────────────────────────────────────────────────────────
const invented: Array<[string, string]> = [
  ['warranty', 'This drill comes with a 5-year warranty.'],
  ['warranty', 'It is guaranteed against rust for 25 years.'],
  ['warranty', 'Covered for 10 years against manufacturing defects.'],
  ['warranty', 'I couldn’t find the guide, but the paint has a lifetime warranty.'],
  ['legal_requirement', 'This board complies with the NZ Building Code.'],
  ['legal_requirement', 'It is certified to AS/NZS 2269.'],
  ['legal_requirement', 'It meets building code requirements for bathrooms.'],
  ['legal_requirement', 'This work is legally required to be done by a licensed plumber.'],
  ['compatibility', 'This bracket fits with every GIB board.'],
  ['compatibility', 'It is compatible with all Makita 18V batteries.'],
  ['compatibility', 'This paint is suitable for exterior walls.'],
  ['compatibility', 'The adaptor works with any standard tap.'],
  ['substitution', 'The Bosch bit is an equivalent replacement for the Makita one.'],
  ['substitution', 'These two screws are interchangeable.'],
  ['installation_step', 'Install the bracket at 300 mm centres.'],
  ['installation_step', 'Drill a 6 mm pilot hole first.'],
  ['installation_step', 'Mount the bracket onto the stud with two screws.'],
  ['installation_step', 'Wire it to a 16 amp circuit.'],
  ['installation_step', 'Fix the rail to the wall with 50 mm screws.'],
  ['installation_step', 'Attach the shelf to the studs using the supplied bolts.'],
  ['installation_step', 'Fasten the boards down with a screw every 300 mm.'],
  ['installation_step', 'Connect the hose to the tap using the adaptor.'],
  ['installation_step', 'You should drill into the stud, not the plasterboard.'],
  ['requirement', 'A building consent is required for decks over 1.5 m.'],
  ['requirement', 'You must use treated timber for ground contact.'],
  ['requirement', 'You need to use a 40 mm screw for this.'],
  ['requirement', 'This needs to be sealed within two weeks.'],
  ['care_safety', 'Dilute one part cleaner to four parts water.'],
  ['safety_instruction', 'Wear a respirator when sanding.'],
  ['care_safety', 'Always apply it in a ventilated area.'],
  ['safety_instruction', 'Turn off the power at the switchboard before you start.'],
  ['catalog_fact', 'It costs $249.'],
  ['catalog_fact', 'The price is $39.90 per sheet.'],
  ['catalog_fact', 'SKU: 123456 is the one you want.'],
  ['stock', 'We have 40 in stock at the Hamilton branch.'],
  ['stock', 'It’s out of stock at Takapuna.'],
  // a claim hidden behind something that asserts nothing
  ['requirement', 'I couldn’t find the installation guide, and it must be installed by a licensed electrician.'],
  ['warranty', 'I couldn’t confirm the warranty, but it has a 10-year warranty.'],
  ['installation_step', 'If you’re unsure, drill a pilot hole first.'],
  ['requirement', 'If it’s near the coast, it must be stainless.'],
  ['requirement', 'Please speak to a builder, but it must be fixed every 300 mm.'],
  ['warranty', 'Tell me your area, and the paint has a lifetime warranty.'],
  // a product's own name does not excuse a claim made about it
  ['warranty', 'The Makita cordless hammer drill combo kit is guaranteed for 3 years.'],
  ['installation_step', 'Install the Makita 12V CXT combo kit charger on a dry wall.'],
];
for (const [expected, sentence] of invented) {
  const verdict = judge(sentence);
  assert.ok(verdict.forbidden.includes(expected as any), `an invented claim must still be caught as ${expected}: ${sentence} (got ${verdict.forbidden.join(',') || 'nothing'})`);
  assert.equal(withholdUnsupportedClaims(sentence, ['suggestion'], packOptions, { knownNames }).text, '', `removed: ${sentence}`);
}
assert.ok(invented.length >= 25);

// The same sentences pass once the release has verified the class they assert.
assert.deepEqual(validateOkfGeneratedClaims('This drill comes with a 5-year warranty.', ['suggestion', 'warranty'], packOptions, { knownNames }).forbidden, []);
assert.deepEqual(validateOkfGeneratedClaims('We have 40 in stock at the Hamilton branch.', ['suggestion', 'stock'], packOptions, { knownNames }).forbidden, []);

// ── 3. A mixed answer keeps what is fine and loses only the claim ─────────────────────────────────────────────────────────────────────────
const mixed = withholdUnsupportedClaims(
  'Good news, we found a Makita cordless hammer drill combo kit. It comes with a 3-year warranty. Tell me what you’re drilling into and how many holes you need.',
  ['suggestion'], packOptions, { knownNames },
);
assert.equal(mixed.text, 'Good news, we found a Makita cordless hammer drill combo kit. Tell me what you’re drilling into and how many holes you need.');
assert.deepEqual(mixed.removed.map((entry) => entry.classes), [['warranty']]);

// ── 3b. Hedged general know-how: a pack setting, off by default ───────────────────────────────────────────────────────────────────────────
const knowHowSentence = 'For drilling into concrete, you’ll generally want a cordless hammer drill rather than a standard drill, plus masonry drill bits.';
const withKnowHow = (setting: any) => ({ ...packOptions, conversationPolicy: { ...draft.conversationPolicy, claimPolicy: { hedgedKnowHow: setting } } });
const judgeWith = (options: any, text: string) => validateOkfGeneratedClaims(text, ['suggestion'], options, { knownNames, productNames }).forbidden;

assert.deepEqual(judgeWith(packOptions, knowHowSentence), ['installation_step'], 'off by default: the sentence is still withheld');
assert.deepEqual(judgeWith(withKnowHow({ enabled: false }), knowHowSentence), ['installation_step'], 'explicitly off');
assert.deepEqual(judgeWith(withKnowHow({ enabled: true }), knowHowSentence), [], 'on: hedged general know-how is said');
assert.ok(judgeWith(withKnowHow({ enabled: true }), 'For drilling into concrete, you’ll want a cordless hammer drill rather than a standard drill.').includes('installation_step'), 'on, but not hedged: still withheld');
assert.deepEqual(judgeWith(withKnowHow({ enabled: true, hedgeWords: ['as a rule'] }), 'As a rule, drill into the stud first.'), [], 'the pack chooses the hedge words');
assert.ok(judgeWith(withKnowHow({ enabled: true, hedgeWords: ['as a rule'] }), knowHowSentence).includes('installation_step'), 'and only those');
assert.deepEqual(judgeWith(withKnowHow({ enabled: true, hedgeWords: { 'en-NZ': ['typically'], default: ['usually'] } }), 'Typically you would drill into the stud first.'), [], 'hedge words per locale');

// What the setting must never let through, however it is hedged.
const neverHedged = [
  'This drill generally comes with a 5-year warranty.',
  'It is usually guaranteed against rust.',
  'This board typically complies with the Building Code.',
  'It generally costs $249.',
  'We usually have 40 in stock at the Hamilton branch.',
  'You should generally turn off the power at the switchboard before you drill into the wall.',
  'Generally wear a respirator when sanding.',
  'You usually dilute one part cleaner to four parts water.',
  'You generally must use treated timber for ground contact.',
  'Brackets are usually required by law for decks over 1.5 m.',
  'It is typically covered for 10 years and you drill into the stud first.',
];
for (const sentence of neverHedged) {
  assert.ok(judgeWith(withKnowHow({ enabled: true }), sentence).length > 0, `a hedge does not excuse: ${sentence}`);
}
// A setting that names a class the pack may not hedge is limited to the three that are allowed.
assert.ok(judgeWith(withKnowHow({ enabled: true, classes: ['installation_step'] }), 'This kit is generally compatible with all 18V batteries.').includes('compatibility'), 'only the classes named');
assert.deepEqual(judgeWith(withKnowHow({ enabled: true }), 'A hammer drill is generally suitable for concrete.'), [], 'general compatibility know-how, hedged');
assert.ok(judgeWith(withKnowHow({ enabled: true }), 'The Makita 12V CXT combo kit is generally compatible with all 18V batteries.').includes('compatibility'), 'a named product still needs its source');
assert.equal(
  withholdUnsupportedClaims(knowHowSentence, ['suggestion'], withKnowHow({ enabled: true }), { knownNames }).text,
  knowHowSentence,
);

// The pack setting is checked when it is saved: only the three classes can be named.
assert.equal(ConversationPolicySchema.safeParse({ claimPolicy: { hedgedKnowHow: { enabled: true, classes: ['installation_step', 'compatibility'] } } }).success, true);
for (const refused of ['warranty', 'legal_requirement', 'catalog_fact', 'stock', 'safety_instruction', 'care_safety']) {
  assert.equal(ConversationPolicySchema.safeParse({ claimPolicy: { hedgedKnowHow: { enabled: true, classes: [refused] } } }).success, false, `${refused} can never be hedged through`);
}
assert.equal(ConversationPolicySchema.safeParse({}).success, true, 'the setting is optional');

// ── 4. When the model is asked to answer again, and what the customer reads if nothing is left ──────────────────────────────────────────────
const limits = { thinBelowChars: 120, removedShareAbove: 0.5 };
assert.equal(needsRepair({ withheldCount: 0, removedChars: 0, keptChars: 0, cardShown: false, ...limits }), false, 'nothing removed, nothing to repair');
assert.equal(needsRepair({ withheldCount: 1, removedChars: 80, keptChars: 60, cardShown: false, ...limits }), true, 'little left and no card to carry it');
assert.equal(needsRepair({ withheldCount: 1, removedChars: 30, keptChars: 60, cardShown: true, ...limits }), false, 'a short reply with a card is fine');
assert.equal(needsRepair({ withheldCount: 1, removedChars: 300, keptChars: 200, cardShown: true, ...limits }), true, 'most of what was written was removed, card or not');
assert.equal(needsRepair({ withheldCount: 1, removedChars: 100, keptChars: 400, cardShown: true, ...limits }), false, 'a small part removed from a full reply is left as it is');

const found = foundMessageOf(undefined);
assert.equal(found, DEFAULT_FOUND_MESSAGE);
assert.equal(foundMessageOf({ conversationPolicy: { foundMessage: 'Have a look at these.' } }), 'Have a look at these.');
assert.equal(foundMessageOf({ conversationPolicy: { foundMessage: { 'en-NZ': 'Kia ora, these are ours.', default: 'x' } } }, 'en-NZ'), 'Kia ora, these are ours.');
const fallback = (reply: string, onlyQuestions: boolean, hasProducts: boolean, classes: any[]) =>
  chooseWithheldFallback({ reply, onlyQuestions, hasProducts, withheldClasses: classes, foundMessage: 'FOUND', withheldMessage: 'REFUSAL' });
assert.equal(fallback('', false, true, ['warranty']), 'FOUND', 'products found, a warranty line removed');
assert.equal(fallback('', false, true, ['installation_step', 'requirement']), 'FOUND');
assert.equal(fallback('', false, true, ['safety_instruction']), 'REFUSAL', 'a safety line removed: the tenant refusal');
assert.equal(fallback('', false, true, ['care_safety']), 'REFUSAL');
assert.equal(fallback('', false, true, ['legal_requirement']), 'REFUSAL');
assert.equal(fallback('', false, false, ['warranty']), 'REFUSAL', 'nothing to show: the tenant refusal');
assert.equal(fallback('Which one do you mean?', true, true, ['warranty']), undefined, 'questions kept with the cards');
assert.equal(fallback('Which one do you mean?', true, false, ['warranty']), 'REFUSAL');
assert.equal(fallback('Here are the options.', false, false, ['warranty']), undefined, 'a reply with a statement is never replaced');

console.log('✅ claim guard: real sentences kept, invented claims still removed');
