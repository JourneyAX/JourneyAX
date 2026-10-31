import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { applyVoiceRules, compileVoiceRules, IncrementalSentenceShaper } from '../src/kernel/reply-shaper';

const suite = createSuite('runtime: the shop\'s own voice');

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const rules = compileVoiceRules(draft.extensions.voice.rewrites);
const say = (text: string) => applyVoiceRules(text, rules);

async function main() {
  await suite.test('the shop is "we" and "our" in its own consultant\'s mouth, and only the matched words change', () => {
    assert.equal(say('PlaceMakers’ page “Pergolas Guide” says the posts are treated.'), 'Our page “Pergolas Guide” says the posts are treated.');
    assert.equal(say('I found the PlaceMakers catalogue entry.'), 'I found our catalogue entry.');
    assert.equal(say('PlaceMakers has a range of pavers.'), 'We have a range of pavers.');
    assert.equal(say('PlaceMakers does not list a kit.'), 'We do not list a kit.');
    assert.equal(say('PlaceMakers offers click and collect.'), 'We offer click and collect.');
    assert.equal(say('PlaceMakers can check stock.'), 'We can check stock.');
    assert.equal(say('Tell me your nearest PlaceMakers branch.'), 'Tell me your nearest branch.');
    assert.equal(say('Choose a PlaceMakers store.'), 'Choose a store.');
    assert.equal(say('The PlaceMakers team can check.'), 'Our team can check.');
    assert.equal(say('I found PlaceMakers paving inspiration pages.'), 'I found PlaceMakers paving inspiration pages.');
    assert.equal(say('The product record says it is water based.'), 'What we have on file says it is water based.');
    assert.equal(say('I could not find it in the catalogue.'), 'I could not find it in our range.');
  });

  await suite.test('a product or programme name that happens to start with the shop\'s name is left alone, and so is everything else', () => {
    assert.equal(say('PlaceMakers Plus members save on trade orders.'), 'PlaceMakers Plus members save on trade orders.');
    assert.equal(say('See PlaceMakers E-Tools Quotes for details.'), 'See PlaceMakers E-Tools Quotes for details.');
    assert.equal(say('Forum Paver 400 x 400 x 50mm Glacier Honed.'), 'Forum Paver 400 x 400 x 50mm Glacier Honed.');
    assert.equal(say('Landscaping Catalogue is out now.'), 'Landscaping Catalogue is out now.');
  });

  await suite.test('"Next step:" is dropped and the sentence still starts with a capital', () => {
    assert.equal(say('Next step: tell me your nearest branch and I can check stock.'), 'Tell me your nearest branch and I can check stock.');
  });

  await suite.test('a rule that is not a pattern is ignored, and no rules means no change', () => {
    assert.deepEqual(compileVoiceRules([{ pattern: '(', replacement: 'x' }, { pattern: 'a', replacement: 'b' }]).map((r) => r.replacement), ['b']);
    assert.deepEqual(compileVoiceRules(undefined), []);
    assert.equal(applyVoiceRules('Anything at all.', []), 'Anything at all.');
  });

  await suite.test('while a reply streams, each sentence is spoken in the shop\'s voice before it goes out', () => {
    const out: string[] = [];
    const shaper = new IncrementalSentenceShaper(
      { style: { maxSentences: 10, dropListLines: false, forbiddenPhrases: [], rules: [] } as any, companyNames: ['placemakers'], internalIds: [], questionCardShown: false },
      new Set(), false, (sentence) => out.push(sentence), { extensions: { voice: draft.extensions.voice } },
    );
    shaper.processDelta('PlaceMakers’ page on pergolas says use treated posts. ');
    shaper.processDelta('Next step: tell me the height you want.');
    shaper.flush();
    assert.deepEqual(out, ['Our page on pergolas says use treated posts.', 'Tell me the height you want.']);
    assert.equal(shaper.getStreamedText(), 'Our page on pergolas says use treated posts. Tell me the height you want.');
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
