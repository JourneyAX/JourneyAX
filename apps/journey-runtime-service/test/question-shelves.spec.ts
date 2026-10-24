import test from 'node:test';
import assert from 'node:assert/strict';
import { addOtherOption, checkShelfQuestions, DEFAULT_MIN_SHELF_SHARE } from '../src/agent/question-shelves';

const shelves = [
  { name: 'Power Tool Accessories', productCount: 3574 }, { name: 'Hand Tools', productCount: 2952 },
  { name: 'Power Tools', productCount: 1188 }, { name: 'Outdoor Power Equipment', productCount: 290 },
];
const ask = (options: unknown[]) => [{ id: 'kind', text: 'What kind?', options }];

test('each choice is the group it shares the most words with, so "Power tool accessories" is not mistaken for "Power Tools"', () => {
  const check = checkShelfQuestions(ask(['Hand tools', 'Power tool accessories', 'Not sure']), shelves);
  assert.deepEqual(check.shelfQuestions, [0]);
  assert.deepEqual(check.missing.map((shelf) => shelf.name), ['Power Tools']);
});

test('a group below the share is not required, and the share can be set', () => {
  assert.ok(290 / 8004 < DEFAULT_MIN_SHELF_SHARE);
  assert.deepEqual(checkShelfQuestions(ask(['Hand tools', 'Power tools', 'Power tool accessories']), shelves).missing, []);
  const strict = checkShelfQuestions(ask(['Hand tools', 'Power tools', 'Power tool accessories']), shelves, { minShelfShare: 0.03 });
  assert.deepEqual(strict.missing.map((shelf) => shelf.name), ['Outdoor Power Equipment']);
});

test('a question that does not offer the groups is not checked', () => {
  assert.deepEqual(checkShelfQuestions(ask(['Indoors', 'Outdoors']), shelves), { shelfQuestions: [], missing: [] });
  assert.deepEqual(checkShelfQuestions(ask(['Hand tools', 'Indoors']), shelves), { shelfQuestions: [], missing: [] }, 'one group alone is not a choice between groups');
  assert.deepEqual(checkShelfQuestions(ask(['Hand tools', 'Power tools']), [{ name: 'Hand Tools', productCount: 5 }]), { shelfQuestions: [], missing: [] }, 'a range with one group has nothing to choose between');
  assert.deepEqual(checkShelfQuestions('not questions', shelves), { shelfQuestions: [], missing: [] });
});

test('choices written as value and label objects are read by their label', () => {
  const check = checkShelfQuestions(ask([{ value: 'hand', label: 'Hand tools' }, { value: 'acc', label: 'Power tool accessories' }]), shelves);
  assert.deepEqual(check.missing.map((shelf) => shelf.name), ['Power Tools']);
});

test('the joining words of the shop\'s language are ignored when comparing words', () => {
  const fixings = [{ name: 'Nails and Screws', productCount: 500 }, { name: 'Bolts & Anchors', productCount: 500 }, { name: 'Glues', productCount: 400 }];
  const joiners = new Set(['and']);
  const check = checkShelfQuestions(ask(['Nails, screws', 'Bolts, anchors']), fixings, {}, joiners);
  assert.deepEqual(check.missing.map((shelf) => shelf.name), ['Glues']);
});

test('the shop\'s "something else" is added once, only where asked and only to the questions about the groups', () => {
  const questions: any[] = [{ id: 'a', options: ['Hand tools', 'Power tools'] }, { id: 'b', options: ['Indoors', 'Outdoors'] }];
  addOtherOption(questions, [0], 'Something else');
  addOtherOption(questions, [0], 'something else');
  assert.deepEqual(questions[0].options, ['Hand tools', 'Power tools', 'Something else']);
  assert.deepEqual(questions[1].options, ['Indoors', 'Outdoors']);
  const untouched: any[] = [{ id: 'a', options: ['x', 'y'] }];
  addOtherOption(untouched, [0], undefined);
  assert.deepEqual(untouched[0].options, ['x', 'y']);
});
