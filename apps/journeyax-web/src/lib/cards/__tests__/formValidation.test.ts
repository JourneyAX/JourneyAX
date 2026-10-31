/**
 * Checking what a person typed into a shop's form: the same function the page and the server use.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/cards/__tests__/formValidation.test.ts
 */
import assert from 'node:assert/strict';
import { cleanText, validateFormValues, type FormLike } from '@journeyax/ui-cards';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const form: FormLike = {
  fields: [
    { id: 'name', label: 'Your name', type: 'text', required: true },
    { id: 'email', label: 'Email', type: 'email', required: true },
    { id: 'phone', label: 'Phone', type: 'phone' },
    { id: 'topic', label: 'Topic', type: 'select', options: ['An order', 'A product'] },
    { id: 'message', label: 'Message', type: 'textarea', required: true, maxLength: 50 },
    { id: 'callback', label: 'Call me back', type: 'checkbox' },
    { id: 'terms', label: 'I agree', type: 'checkbox', required: true },
  ],
};
const good = { name: '  Jo   Bloggs ', email: 'jo@example.com', phone: '+64 21 555 0100', topic: 'An order', message: 'Where is my\n\n\n\norder?', callback: true, terms: 'on' };

check('a good submission is kept, cleaned: trimmed, single spaces in a line, tidy blank lines in a message', () => {
  const result = validateFormValues(form, good);
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, { name: 'Jo Bloggs', email: 'jo@example.com', phone: '+64 21 555 0100', topic: 'An order', message: 'Where is my\n\norder?', callback: true, terms: true });
  assert.deepEqual(result.errors, {});
});

check('fields the form does not declare are dropped, and empty optional answers are left out', () => {
  const result = validateFormValues(form, { ...good, phone: '', topic: '', callback: false, isAdmin: true, __proto__: { x: 1 } });
  assert.deepEqual(Object.keys(result.values).sort(), ['email', 'message', 'name', 'terms']);
});

check('each mistake gets one plain sentence naming the field', () => {
  const result = validateFormValues(form, { name: '  ', email: 'not-an-email', phone: 'abc', topic: 'Anything', message: 'x'.repeat(51) });
  assert.equal(result.ok, false);
  assert.equal(result.errors.name, 'Please fill in Your name.');
  assert.equal(result.errors.email, 'Please enter a full email address for Email.');
  assert.equal(result.errors.phone, 'Please enter a phone number for Phone.');
  assert.equal(result.errors.topic, 'Please choose one of the options for Topic.');
  assert.equal(result.errors.message, 'Message is too long.');
  assert.equal(result.errors.terms, 'Please fill in I agree.', 'a required box must be ticked');
});

check('the shop can word the mistakes', () => {
  const result = validateFormValues({ ...form, messages: { required: 'We need {label}, please.' } }, {});
  assert.equal(result.errors.name, 'We need Your name, please.');
});

check('what is not text is not accepted as text, and control characters never get through', () => {
  const result = validateFormValues(form, { ...good, name: { $gt: '' }, email: ['a@b.co'], message: 'ok\u0000\u0007 fine' });
  assert.equal(result.errors.name, 'Please fill in Your name.');
  assert.equal(result.errors.email, 'Please fill in Email.');
  assert.equal(result.values.message, 'ok fine');
  assert.equal(validateFormValues(form, null).ok, false);
  assert.equal(validateFormValues(form, 'text').ok, false);
  assert.equal(cleanText('a​ b', false).length >= 3, true);
});

check('phone numbers: digits with the usual separators, six to fifteen digits', () => {
  const phone = (value: string) => validateFormValues({ fields: [{ id: 'p', label: 'Phone', type: 'phone' }] }, { p: value }).ok;
  assert.equal(phone('021 555 0100'), true);
  assert.equal(phone('(09) 555-0100'), true);
  assert.equal(phone('12345'), false);
  assert.equal(phone('1234567890123456'), false);
  assert.equal(phone('021-abc-0100'), false);
});

console.log(`✅ web: form validation: ${passed} passed, 0 failed`);
