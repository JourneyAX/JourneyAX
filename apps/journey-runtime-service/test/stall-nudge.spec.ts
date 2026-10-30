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

  test('it recognises the promises real staff chats stalled on: present tense, passive voice, waiting on its own lookup, and a promise before courtesy lines', () => {
    for (const text of [
      // HQ-05, twice: present tense, then "I will provide … as soon as I have"
      "I am checking Ngata & Penrose Joinery's account to confirm if a $7,500 order can be placed on account today, whether it fits their credit limit, and if anything is overdue. I will provide a summary of their credit status and any overdue amounts as soon as I have the verified details.",
      // HQ-04: "I am gathering", "Once I have confirmed … I will check", then an offer question
      'I am gathering the account details and delivery status for Mere Tasman. Once I have confirmed which trade account she is with, I will check if there are any deliveries currently booked for that account and provide you with a concise summary. Is there anything specific you need to know about the deliveries, such as scheduled dates or delivery locations?',
      // HQ-09: passive "will be confirmed shortly", then a courtesy line
      "The silver trade price for 36 metres of shiplap weatherboard (SKU 1357711) will be confirmed shortly, as I am verifying the current rate for your account. I'll also calculate the total for 36 metres at the silver rate. I'll update you as soon as I have the verified pricing details. If you need this for a specific branch or have a preferred pickup location, let me know so I can include local stock availability.",
      // HQ-09, first run: "I'll confirm … as soon as I have the verified figures"
      "The silver trade price for SKU 1357711 is being retrieved from our pricing system. I'll confirm these details and provide a full breakdown as soon as I have the verified figures.",
      // HQ-09, after the nudge: present tense, then a hand-off-shaped line, then courtesy
      "I'm checking the silver trade price for 36 metres of shiplap weatherboard (SKU 1357711) for your account. I'll confirm these details and let you know when they're ready. If you have a preferred branch for collection or want to check local stock, let me know.",
      'I am checking the account now. Is there anything else you need?',
      'One moment while I pull up the delivery.',
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
      // a promise followed by a question the assistant needs answered is waiting on the person, not stalling
      "I'm going to check the stock for you. Which branch do you mean?",
      // real answers from the same chats, with courtesy endings
      'Ormond & Harlow Joinery Ltd (silver tier, 30-day terms) currently owe $212.79, all within terms—nothing is overdue. Their credit limit is $5,000, so they are well within their limit. Let me know if you need details for one of the other Harlow Joinery accounts, or if you want a breakdown of recent orders.',
      "I'm unable to confirm the current account balance or any overdue amounts directly here, as this information requires access to financial records. A team member has been asked to follow up with you directly. A customer consultant has been notified and will assist you shortly.",
      'Order OPP-0022 is still showing as open in the system and is set for delivery to Oamaru. However, there is no delivery record found for this order in the dispatch system, so I cannot confirm if it has been delivered. Would you like me to help you get in touch with them?',
      'However, I do not have direct access to a report listing all accounts and their balances in one view. To provide this information, I would need to review each account individually. If you have a specific list of accounts, please provide the account names or numbers, and I can look up their balances for you.',
    ]) assert.equal(announcesNextStep(text as any), false, String(text));
  });

  test('a promise followed by the answer is not a stall; a promise followed by nothing but courtesy is', () => {
    assert.equal(announcesNextStep('I will look at that now. The answer is 42 units in stock.'), false);
    assert.equal(announcesNextStep('The answer is 42 units. Now, I will look at the price.'), true);
    assert.equal(announcesNextStep('I will look at that now. The answer is 42 units in stock. Let me know if you need anything else.'), false);
    assert.equal(announcesNextStep('I am checking the price. Let me know if you need anything else.'), true);
  });
});
