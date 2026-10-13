import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { shapeReply, type ShapeContext } from '../src/kernel/reply-shaper';
import { resolveInterpretationPolicy } from '../src/turn/fact-semantics';

const suite = createSuite('runtime: what the assistant says is shaped before a customer reads it');
const style = resolveInterpretationPolicy().replyStyle;
const context = (over: Partial<ShapeContext> = {}): ShapeContext => ({
  style, companyNames: ['PlaceMakers'], questionCardShown: false,
  internalIds: ['cleaning-and-consumables', 'cleaners-and-cleaning-equipment', 'nav_cleaning_and_consumables_cleaners_and_cleaning_equipment'], ...over,
});

// The reply a customer actually received, word for word.
const WHAT_THE_CUSTOMER_GOT = [
  'Sure — for cleaning supplies, head to the PlaceMakers **Cleaners & Cleaning Equipment** section:',
  '',
  '**Category:** `cleaners-and-cleaning-equipment`',
  '',
  'What are you looking for specifically — general cleaning products, site clean-up gear, consumables, or equipment? If you tell me the job you’re doing, I can help narrow it down.',
].join('\n');
const AFTER_THE_ANSWER = [
  'Great — you’re looking for Indoor Cleaners under Cleaners & Cleaning Equipment.',
  'Next step: tell me what you’re cleaning and I’ll help narrow it down, for example:',
  '- Floors', '- Kitchen or bathroom surfaces', '- Glass/windows', '- Mould or mildew areas',
  'If you’d rather browse, head to Cleaners & Cleaning Equipment → Indoor Cleaners.',
].join('\n');

async function main() {
  await suite.test('the reply the customer got keeps nothing that was wrong with it, and a question card means no question of its own', () => {
    const shaped = shapeReply(WHAT_THE_CUSTOMER_GOT, context({ questionCardShown: true }));
    assert.equal(shaped.text, '', 'every sentence was a problem, so nothing is left and the tenant\'s own lead-in is used');
    assert.deepEqual(shaped.removed.map((entry) => entry.reason), ['sends the customer elsewhere', 'internal id', 'second question', 'sends the customer elsewhere']);
    assert.ok(!/`|cleaners-and-cleaning|head to|PlaceMakers/.test(shaped.text));
  });

  await suite.test('after an answer: no invented list, no "next step", no "go and browse"', () => {
    const shaped = shapeReply(AFTER_THE_ANSWER, context());
    assert.equal(shaped.text, 'Great — you’re looking for Indoor Cleaners under Cleaners & Cleaning Equipment.');
    const reasons = shaped.removed.map((entry) => entry.reason);
    assert.equal(reasons.filter((reason) => reason === 'list').length, 4);
    assert.ok(reasons.includes('sends the customer elsewhere'));
  });

  await suite.test('good replies are left alone, word for word', () => {
    for (const reply of ['Here are a few for the job.', 'These are what we have for floors. Have a look through them.', 'Sure, here are some options.']) {
      const shaped = shapeReply(reply, context({ questionCardShown: true }));
      assert.equal(shaped.text, reply);
      assert.deepEqual(shaped.removed, []);
    }
  });

  await suite.test('a question is allowed when no card asks one; it is removed only when a card does', () => {
    assert.equal(shapeReply('Here are some options. Anything else you need?', context()).text, 'Here are some options. Anything else you need?');
    assert.equal(shapeReply('Here are some options. Anything else you need?', context({ questionCardShown: true })).text, 'Here are some options.');
  });

  await suite.test('the company name is not said in its own shop, and internal ids never are, in any case or markup', () => {
    assert.equal(shapeReply('At PlaceMakers we stock plenty. Here are some floor cleaners.', context()).text, 'Here are some floor cleaners.');
    assert.equal(shapeReply('This is in CLEANING-AND-CONSUMABLES. These suit floors.', context()).text, 'These suit floors.');
    assert.equal(shapeReply('Use the concept://placemakers/x/y id. These suit floors.', context()).text, 'These suit floors.');
    assert.equal(shapeReply('The code is `abc`. These suit floors.', context()).text, 'These suit floors.', 'backticks never belong to a customer');
    assert.equal(shapeReply('Our company, PlaceMakers, is great. Fine.', context({ style: { ...style, dropCompanyName: false } })).text, 'Our company, PlaceMakers, is great. Fine.', 'a tenant can switch it off');
  });

  await suite.test('ordinary category words are not mistaken for internal ids', () => {
    const ordinary = context({ internalIds: ['paint', 'vanities', 'toilets', 'cleaners-and-cleaning-equipment'] });
    for (const reply of ['Here are vanities from our range.', 'I can show you paint options.', 'Here are toilets from our range.']) {
      assert.equal(shapeReply(reply, ordinary).text, reply);
    }
    assert.equal(shapeReply('The cleaners-and-cleaning-equipment section has these items.', ordinary).text, '');
  });

  await suite.test('the reply is short: at most the configured number of sentences, kept in order', () => {
    const shaped = shapeReply('One here. Two here. Three here. Four here.', context());
    assert.equal(shaped.text, 'One here. Two here.');
    assert.deepEqual(shaped.removed.map((entry) => entry.reason), ['too long', 'too long']);
    assert.equal(shapeReply('One here. Two here. Three here.', context({ style: { ...style, maxSentences: 3 } })).text, 'One here. Two here. Three here.');
  });

  await suite.test('sentences are removed whole and never rewritten: everything left was said by the model', () => {
    const original = 'Happy to help. Head to the cleaning section. These are good for floors.';
    const kept = shapeReply(original, context()).text;
    for (const sentence of kept.split(/(?<=\.)\s+/)) assert.ok(original.includes(sentence), `"${sentence}" was in the original`);
  });

  await suite.test('the style is data: a pack can change every part of it, and it is validated', async () => {
    const strict = shapeReply('A. B. C.', context({ style: { ...style, maxSentences: 1, forbiddenPhrases: [] } }));
    assert.equal(strict.text, 'A.');
    const forbidden = shapeReply('Please visit the aisle. Good.', context({ style: { ...style, forbiddenPhrases: ['visit the aisle'] } }));
    assert.equal(forbidden.text, 'Good.');
    const release: any = { extensions: { interpretationPolicy: { replyStyle: { maxSentences: 4 } } } };
    assert.equal(resolveInterpretationPolicy(release).replyStyle.maxSentences, 4);
    assert.deepEqual(resolveInterpretationPolicy(release).replyStyle.rules, style.rules, 'untouched parts keep the platform default');
    const { validatePackSettings } = await import('../../project-service/src/pack-settings');
    assert.equal(validatePackSettings({ interpretationPolicy: { replyStyle: { maxSentences: 4, forbiddenPhrases: ['a'] } } }).ok, true);
    for (const bad of [{ maxSentences: 0 }, { maxSentences: 2.5 }, { dropListLines: 'no' }, { forbiddenPhrases: [''] }, { rules: 'x' }, { extra: 1 }]) {
      assert.equal(validatePackSettings({ interpretationPolicy: { replyStyle: bad } }).ok, false, JSON.stringify(bad));
    }
  });

  await suite.test('the platform style says what the customer asked for: short, human, no brand, no browsing, no sales pitch', () => {
    const rules = style.rules.join(' ').toLowerCase();
    for (const expected of ['short', 'company', 'category', 'question', 'pitch']) assert.ok(rules.includes(expected), `a rule covers "${expected}"`);
  });

  process.exitCode = suite.finish() ? 0 : 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
