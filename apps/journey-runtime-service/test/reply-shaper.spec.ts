import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { shapeReply, IncrementalSentenceShaper, type ShapeContext } from '../src/kernel/reply-shaper';
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

  await suite.test('prose after a list starts a new paragraph instead of running on from the last item', () => {
    const listStyle: any = { ...style, dropListLines: false, maxSentences: 14, forbiddenPhrases: [], dropCompanyName: false };
    const shaped = shapeReply('Here is the range:\n- Standard board (15 products)\n- Specialist board (65 products)\nCustomers usually also need tape and compound.', context({ style: listStyle }));
    assert.equal(shaped.text, 'Here is the range:\n- Standard board (15 products)\n- Specialist board (65 products)\n\nCustomers usually also need tape and compound.');
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

  await suite.test('staff can discuss source references without exposing platform concept identifiers', () => {
    const staff = context({ allowCodeFormatting: true, internalIds: ['internal-stage-7'] });
    assert.equal(shapeReply('Order `DEMO-1001` has not been checked.', staff).text, 'Order `DEMO-1001` has not been checked.');
    assert.equal(shapeReply('Use `internal-stage-7` now.', staff).text, '');
    assert.equal(shapeReply('Use concept://tenant/private.', staff).text, '');
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

  // The layout the model gave a reply (a heading, numbered steps with a line under each, a closing paragraph) is what the customer reads.
  const longStyle: any = { ...style, dropListLines: false, maxSentences: 40, forbiddenPhrases: [], dropCompanyName: false };
  const STEPS = [
    'The guide gives specific steps for fixing the posts.',
    '',
    '### Installation and fixing',
    '1. **Footing:** Place a minimum 100mm concrete punch pad at the base of the hole.',
    '   Centralise the post so there is at least 100mm of concrete cover, then brace it.',
    '2. **Cuts:** All saw cuts, notches and drilled holes must be primed.',
    '3. **Fixings:** Use galvanised or stainless steel bolts.',
    '   Coat them with non-petroleum grease where they touch the timber.',
    '',
    'Seal and paint all exposed timber within 14 days of installation.',
  ].join('\n');
  const BRIEF = [
    'Harlow & Talbot Landscapes is a Silver trade account with its home branch at Silverdale.',
    'Finn Paterson is the account manager.',
    'The last order was on 25 October and is still open.',
    'Two things need a word: a missed delivery and some damaged goods.',
  ].join('\n');

  await suite.test('a heading, numbered steps and the line under each step keep their shape', () => {
    const shaped = shapeReply(STEPS, context({ style: longStyle }));
    assert.equal(shaped.text, [
      'The guide gives specific steps for fixing the posts.',
      '',
      '### Installation and fixing',
      '1. **Footing:** Place a minimum 100mm concrete punch pad at the base of the hole.',
      '   Centralise the post so there is at least 100mm of concrete cover, then brace it.',
      '2. **Cuts:** All saw cuts, notches and drilled holes must be primed.',
      '3. **Fixings:** Use galvanised or stainless steel bolts.',
      '   Coat them with non-petroleum grease where they touch the timber.',
      '',
      'Seal and paint all exposed timber within 14 days of installation.',
    ].join('\n'));
    assert.deepEqual(shaped.removed, []);
  });

  await suite.test('a brief of short lines stays short lines, not one paragraph', () => {
    const shaped = shapeReply(BRIEF, context({ style: longStyle }));
    assert.equal(shaped.text, BRIEF.split('\n').join('\n\n'));
  });

  await suite.test('sentences of one line run on, and a line under a removed list item is removed with it', () => {
    assert.equal(shapeReply('One thing. Another thing.\nA third thing.', context({ style: longStyle })).text, 'One thing. Another thing.\n\nA third thing.');
    const shaped = shapeReply('Here is what to do.\n1. Step one.\n   More about step one.\nThen call us.', context());
    assert.equal(shaped.text, 'Here is what to do.\n\nThen call us.');
    assert.deepEqual(shaped.removed.map((entry) => entry.reason), ['list', 'list']);
  });

  const DEALS = [
    'These deals are open.',
    '1. **OPP-0006, Ngata & Penrose Joinery:**',
    '   - Amount: $6,612 | Stage: Propose',
    '   - Next step: call to talk through delivery',
    '2. **OPP-0023, Okafor & Yardley Painters:**',
    '   - Amount: $5,733 | Stage: Negotiate',
    '   - Next step: call to talk through delivery',
    '3. **OPP-0030, Hartley & Hartley Concrete:**',
    '   - Amount: $798 | Stage: Propose',
    '   - Next step: send the quote',
    'The first two are due to close this week.',
  ].join('\n');

  await suite.test('an item under an item keeps how far it was indented, so nested lists stay nested', () => {
    const shaped = shapeReply(DEALS, context({ style: longStyle }));
    assert.equal(shaped.text, DEALS.replace(/\nThe first/, '\n\nThe first'), 'only the closing sentence moves: it starts a paragraph after the list');
    assert.ok(shaped.text.includes('\n   - Amount: $6,612 | Stage: Propose\n   - Next step: call to talk through delivery\n2. '));
  });

  await suite.test('a style with a list limit counts list lines apart from sentences, so a list of records is not cut in the middle', () => {
    const counted: any = { ...longStyle, maxSentences: 3, maxListLines: 40 };
    const whole = shapeReply(DEALS, context({ style: counted }));
    assert.deepEqual(whole.removed, []);
    assert.equal((whole.text.match(/^\s*- /gm) || []).length, 6, 'all six detail lines are there');
    assert.ok(whole.text.endsWith('The first two are due to close this week.'));
    const tight: any = { ...longStyle, maxSentences: 3, maxListLines: 5 };
    const cut = shapeReply(DEALS, context({ style: tight }));
    assert.equal(cut.removed.filter((entry) => entry.reason === 'too long').length, 4, 'the 6th..9th list lines are over the limit of five');
    assert.ok(!cut.text.includes('send the quote'));
  });

  await suite.test('a pack may set the list limit, and it is checked', async () => {
    const { validatePackSettings } = await import('../../project-service/src/pack-settings');
    assert.equal(validatePackSettings({ interpretationPolicy: { replyStyle: { maxListLines: 30 } } }).ok, true);
    for (const bad of [0, 2.5, 201, '30', null]) {
      assert.equal(validatePackSettings({ interpretationPolicy: { replyStyle: { maxListLines: bad } } }).ok, false, JSON.stringify(bad));
    }
  });

  await suite.test('without a list limit the old count stands: every list line is a sentence', () => {
    const old: any = { ...longStyle, maxSentences: 4 };
    const cut = shapeReply(DEALS, context({ style: old }));
    assert.equal(cut.text.split('\n').filter(Boolean).length, 4);
    assert.ok(cut.removed.every((entry) => entry.reason === 'too long'));
  });

  await suite.test('streamed in any size of piece, a nested list and a list limit read the same as the reply shaped whole', () => {
    const counted: any = { ...longStyle, maxSentences: 3, maxListLines: 40 };
    for (const size of [1, 4, 9, 1000]) {
      const shaper = new IncrementalSentenceShaper(context({ style: counted }), [], false, () => {});
      for (let at = 0; at < DEALS.length; at += size) shaper.processDelta(DEALS.slice(at, at + size));
      shaper.flush();
      assert.equal(shaper.getStreamedText(), shapeReply(DEALS, context({ style: counted })).text, `deals in pieces of ${size}`);
    }
  });

  await suite.test('streamed in any size of piece, the reply reads exactly as the one shaped whole', () => {
    const RUN_ON = 'Here is the range:\n- Standard board (15 products)\n- Specialist board (65 products)\nCustomers usually also need tape and compound. Ask us.\n\n| Size | Price |\n| 10mm | $20 |\nThat is all.';
    for (const [name, reply] of Object.entries({ STEPS, BRIEF, RUN_ON })) {
      for (const size of [1, 3, 7, 1000]) {
        const shaper = new IncrementalSentenceShaper(context({ style: longStyle }), [], false, () => {});
        for (let at = 0; at < reply.length; at += size) shaper.processDelta(reply.slice(at, at + size));
        shaper.flush();
        assert.equal(shaper.getStreamedText(), shapeReply(reply, context({ style: longStyle })).text, `${name} in pieces of ${size}`);
      }
    }
    const dropping = new IncrementalSentenceShaper(context(), [], false, () => {});
    dropping.processDelta('Here is what to do.\n1. Step one.\n   More about step one.\nThen call us.');
    dropping.flush();
    assert.equal(dropping.getStreamedText(), 'Here is what to do.\n\nThen call us.');
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
