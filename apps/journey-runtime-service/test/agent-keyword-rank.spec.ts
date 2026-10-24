import test from 'node:test';
import assert from 'node:assert/strict';
import { rankByKeywords, MIN_WORD_WEIGHT, SYNONYM_FACTOR } from '../src/capabilities/handlers/agent-keyword-rank';

const row = (id: string, name: string, cat = '', rest = '') => ({ d: id, name, cat, rest });
const rx = (word: string) => new RegExp(`\\b(?:${word})`, 'i');

test('a product that only shares a second word does not tie with the real thing when every candidate holds the main word', () => {
  // Every candidate contains "ladder" (in the name, the shelf or the description), so the main word alone cannot separate them.
  const rows = [
    row('safety-step', 'Safety Step', 'Ladders > Safety', 'works with any ladder'),
    row('step-ladder', 'Gorilla Step Ladder 1.8m', 'Ladders > Step Ladders'),
    row('ext-ladder', 'Extension Ladder 4.2m', 'Ladders > Extension Ladders'),
  ];
  const ranked = rankByKeywords(rows, { regexes: [rx('ladder'), rx('step')], words: ['ladder', 'step'], phrases: ['step ladder'] });
  assert.equal(ranked[0], 'step-ladder');
  assert.ok(ranked.indexOf('step-ladder') < ranked.indexOf('safety-step'));
});

test('asking for the main word alone puts products named for it ahead of one that only mentions it', () => {
  const rows = [
    row('safety-step', 'Safety Step', 'Ladders > Safety', 'works with any ladder'),
    row('ext-ladder', 'Extension Ladder 4.2m', 'Ladders > Extension Ladders'),
    row('step-ladder', 'Gorilla Step Ladder 1.8m', 'Ladders > Step Ladders'),
  ];
  const ranked = rankByKeywords(rows, { regexes: [rx('ladder')], words: ['ladder'], phrases: [] });
  assert.equal(ranked[2], 'safety-step');
});

test('a word every candidate holds still counts for at least the floor', () => {
  const rows = [row('a', 'Alpha', '', 'ladder'), row('b', 'Ladder Beta')];
  const ranked = rankByKeywords(rows, { regexes: [rx('ladder')], words: ['ladder'], phrases: [] });
  assert.equal(ranked[0], 'b');
  assert.ok(MIN_WORD_WEIGHT > 0);
});

test('a phrase counts only when its words follow one another in the name', () => {
  const rows = [row('apart', 'Step Platform for a Ladder'), row('together', 'Step Ladder 1.5m')];
  const ranked = rankByKeywords(rows, { regexes: [rx('step'), rx('ladder')], words: ['step', 'ladder'], phrases: ['step ladder'] });
  assert.equal(ranked[0], 'together');
});

test('words the search dropped do not stop a phrase from counting', () => {
  const rows = [row('apart', 'Step Platform for a Ladder'), row('together', 'Step Ladder 1.5m')];
  const ranked = rankByKeywords(rows, { regexes: [rx('step'), rx('ladder')], words: ['step', 'ladder'], phrases: ['a step ladder'] });
  assert.equal(ranked[0], 'together');
});

test('equal scores keep the order they came in', () => {
  const rows = [row('first', 'Ladder One'), row('second', 'Ladder Two')];
  const ranked = rankByKeywords(rows, { regexes: [rx('ladder')], words: ['ladder'], phrases: [] });
  assert.deepEqual(ranked, ['first', 'second']);
});

test('a loose synonym does not lift a product above one that holds the word itself', () => {
  // The shop's word list says "safety" can stand for "ladder" (a shelf named "Safety & Ladders"). A "Safety Step" must not tie with a step ladder.
  const rows = [
    row('safety-step', 'Step  Safety Step 260kg Plastic', 'Safety & Ladders > Platforms'),
    row('step-ladder', 'Jumbo Step 4 Step Aluminium Step Ladder 150kg', 'Safety & Ladders > Ladders'),
  ];
  const regexes = [rx('step'), rx('ladder|safeti')];
  const exact = [rx('step'), rx('ladder')];
  const ranked = rankByKeywords(rows, { regexes, exact, words: ['step', 'ladder'], phrases: ['step ladder'] });
  assert.deepEqual(ranked, ['step-ladder', 'safety-step']);
  assert.ok(SYNONYM_FACTOR > 0 && SYNONYM_FACTOR < 1);
  // With no exact patterns given, the synonym pattern counts as before.
  const loose = rankByKeywords(rows, { regexes, words: ['step', 'ladder'], phrases: [] });
  assert.equal(loose.length, 2);
});

test('a product that holds only a synonym is still found, after those that hold the word', () => {
  const rows = [row('syn', 'Safety Cone'), row('real', 'Extension Ladder 4m')];
  const ranked = rankByKeywords(rows, { regexes: [rx('ladder|safeti')], exact: [rx('ladder')], words: ['ladder'], phrases: [] });
  assert.deepEqual(ranked, ['real', 'syn']);
});
