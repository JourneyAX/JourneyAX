import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { announcesNextStep } from '../src/agent/stall';

describe('Recognising a reply that stops on a promise to take another step', () => {
  test('it recognises the endings that are a promise to use a tool next', () => {
    for (const text of [
      'Now, I will look for their open cases.',
      'I found one account for Aldridge & Yardley Electrical Ltd. Their account ID is 001i8000008Uu8PAAS. Now, I will look for their open cases.',
      "Let me check the stock at Hamilton.",
      "Next, I'll pull the order history.",
      "I'm going to search the catalogue for that.",
      'Okay, I will now find the cart.',
    ]) assert.equal(announcesNextStep(text), true, text);
  });

  test('it leaves answers, questions and promises that a person will act alone', () => {
    for (const text of [
      '',
      undefined,
      'They have no open cases.',
      'I found one account. Let me know if you would like its cases.',
      'I will check with the branch and get back to you.',
      'A team member will follow up. I will let you know once they reply.',
      'Which statuses would you like me to look for?',
      'To see the open cases I need to know what you count as open. Please let me know which statuses to search for.',
      'Now, I will look for their open cases?',
      'The account has two cases, and I will not be looking at closed ones.',
    ]) assert.equal(announcesNextStep(text as any), false, String(text));
  });

  test('only the last sentence counts, so an earlier "I will" does not', () => {
    assert.equal(announcesNextStep('I will look at that now. The answer is 42 units in stock.'), false);
    assert.equal(announcesNextStep('The answer is 42 units. Now, I will look at the price.'), true);
  });
});
