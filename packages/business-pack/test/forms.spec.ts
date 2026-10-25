import assert from 'node:assert/strict';
import { BusinessPackContentSchema, FormDefinitionSchema, FormsSchema } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Forms (pack extensions.forms): the shop\'s own contact and enquiry forms');

const contact = {
  formId: 'contact-us',
  title: 'Contact us',
  intro: 'Tell us how we can help.',
  fields: [
    { id: 'name', label: 'Your name', type: 'text', required: true },
    { id: 'email', label: 'Email', type: 'email', required: true },
    { id: 'topic', label: 'What is it about?', type: 'select', options: ['An order', 'A product', 'Something else'] },
    { id: 'message', label: 'How can we help?', type: 'textarea', required: true },
    { id: 'callback', label: 'Please call me back', type: 'checkbox' },
  ],
  submitLabel: 'Send',
  thanks: 'Thanks, we have it. Your reference is {reference}.',
  routeTo: 'our customer service team',
  whenToOffer: 'the person wants to contact the shop or leave a message',
};

check('a form parses, and the pack accepts forms under extensions and still accepts none', () => {
  assert.equal(FormDefinitionSchema.safeParse(contact).success, true);
  assert.equal(FormsSchema.safeParse([contact]).success, true);
  const shape = (BusinessPackContentSchema as any).shape?.extensions;
  assert.equal(shape.safeParse({ forms: [contact] }).success, true);
  assert.equal(shape.safeParse({}).success, true);
});

check('anything outside the shape is refused: ids, types, options, duplicates, size', () => {
  const bad = (change: (f: any) => void) => { const copy = JSON.parse(JSON.stringify(contact)); change(copy); return FormDefinitionSchema.safeParse(copy).success; };
  assert.equal(bad(() => {}), true);
  assert.equal(bad((f) => { f.formId = 'Contact Us'; }), false, 'an id is a clean slug');
  assert.equal(bad((f) => { f.fields[0].type = 'password'; }), false, 'only the known field types');
  assert.equal(bad((f) => { delete f.fields[2].options; }), false, 'a select needs options');
  assert.equal(bad((f) => { f.fields[0].options = ['x']; }), false, 'only a select has options');
  assert.equal(bad((f) => { f.fields[1].id = 'name'; }), false, 'two fields with one id');
  assert.equal(bad((f) => { f.fields = []; }), false, 'a form has fields');
  assert.equal(bad((f) => { f.fields = Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, label: 'x', type: 'text' })); }), false, 'at most twenty fields');
  assert.equal(bad((f) => { f.extra = 1; }), false, 'no unknown keys');
  assert.equal(bad((f) => { f.messages = { required: 'Please fill in {label}.' }; }), true, 'the shop can word the mistakes');
  assert.equal(bad((f) => { f.messages = { required: 'x', unknown: 'y' }; }), false);
  assert.equal(FormsSchema.safeParse(Array.from({ length: 21 }, (_, i) => ({ ...contact, formId: `f${i}` }))).success, false, 'at most twenty forms');
});

console.log(`✅ forms: ${passed} passed, 0 failed`);
