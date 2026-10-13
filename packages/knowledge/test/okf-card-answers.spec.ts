import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { readCardAnswers } from '../src';

const suite = createSuite('knowledge: a tapped answer is read from the release, not guessed by a model');
const registry: any[] = [
  { factKey: 'cleaning_task', type: 'enum', questionRef: 'q.a', question: 'What are you cleaning?', uiInputType: 'card_choice', options: [
    { value: 'indoor', label: 'Inside the house: kitchen, bathroom, general' }, { value: 'equipment', label: 'Floors: mopping and sweeping' }, { value: 'car', label: 'The car' } ] },
  { factKey: 'deck_size', type: 'string', questionRef: 'q.b', question: 'Roughly how big is the deck?', uiInputType: 'text' },
  { factKey: 'features', type: 'array', questionRef: 'q.c', question: 'What are you planning to include?', uiInputType: 'multi_select', options: [
    { value: 'vanity', label: 'Vanity' }, { value: 'shower', label: 'Shower' }, { value: 'bath', label: 'Bath' } ] },
  { factKey: 'where', type: 'enum', questionRef: 'q.d', question: 'Where is the water?', uiInputType: 'card_choice', options: [{ value: 'a', label: 'A' }, { value: 'car', label: 'In the car' }] },
];

async function main() {
  await suite.test('the web app\'s own format: "My answers:" then one "question → answer" line per card', () => {
    assert.deepEqual(readCardAnswers('My answers:\nWhat are you cleaning? → equipment', registry), { cleaning_task: 'equipment' });
    assert.deepEqual(readCardAnswers('My answers:\nWhat are you cleaning? → Floors: mopping and sweeping', registry), { cleaning_task: 'equipment' }, 'by label');
    assert.deepEqual(readCardAnswers('My answers:\nWhat are you cleaning? → floors mopping and sweeping', registry), { cleaning_task: 'equipment' }, 'case and punctuation do not matter');
    assert.deepEqual(readCardAnswers('My answers:\nWhat are you cleaning? -> The car', registry), { cleaning_task: 'car' }, 'an ASCII arrow too');
  });

  await suite.test('several cards at once, and a multi-choice card', () => {
    assert.deepEqual(readCardAnswers('My answers:\nWhat are you cleaning? → indoor\nWhat are you planning to include? → vanity, Shower', registry), { cleaning_task: 'indoor', features: ['vanity', 'shower'] });
  });

  await suite.test('the question decides which fact is answered, so a word that fits two questions answers only the one asked', () => {
    assert.deepEqual(readCardAnswers('My answers:\nWhat are you cleaning? → car', registry), { cleaning_task: 'car' });
    assert.deepEqual(readCardAnswers('My answers:\nWhere is the water? → car', registry), { where: 'car' });
  });

  await suite.test('without the question, an answer counts only if exactly one fact could own it', () => {
    assert.deepEqual(readCardAnswers('→ equipment', registry), { cleaning_task: 'equipment' });
    assert.deepEqual(readCardAnswers('→ car', registry), {}, '"car" is an option of two facts: never guess');
  });

  await suite.test('anything that is not a card answer is left alone', () => {
    for (const message of ['equipment', 'What are you cleaning?', 'I like arrows → but not options', 'My answers:\nWhat are you cleaning? → something else', '', 'My answers:\nUnknown question? → indoor\n→']) {
      const found = readCardAnswers(message, registry);
      assert.deepEqual(found, {}, `"${message}" is not an answer to a known card`);
    }
    assert.deepEqual(readCardAnswers('My answers:\nWhat are you cleaning? → something else', registry), {});
  });

  process.exitCode = suite.finish() ? 0 : 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
