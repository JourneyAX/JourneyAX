import assert from 'node:assert/strict';
import { principalFrom } from '@journeyax/shared-types';
import { WelcomeSchema, welcomeFor } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Welcome (pack extensions.welcome): what the empty chat says to each team');

const setting = WelcomeSchema.parse({
  entries: [
    { groups: ['sales'], headline: '{hello}. Who are we helping today?', subtitle: 'Accounts, deals and deliveries.', starters: [
      { label: 'Get me ready for a call', prompt: 'I have a call coming up.', needs: ['salesforce.find_account'] },
      { label: 'What deals are open?', prompt: 'Show me the open deals.', needs: ['salesforce.list_opportunities'] },
    ] },
    { groups: ['customer-service', 'csr'], headline: 'What needs sorting?' },
    { audience: 'staff', headline: 'How can we help?' },
  ],
});
const person = (role: string, groups: string[] = []) => principalFrom({ userId: `${role}@x.test`, role, groups });

check('a team gets its own words, with the tools each starter needs kept for the page to check', () => {
  const welcome = welcomeFor(setting, person('rep', ['sales']));
  assert.equal(welcome?.headline, '{hello}. Who are we helping today?');
  assert.deepEqual(welcome?.starters?.map((s) => s.needs), [['salesforce.find_account'], ['salesforce.list_opportunities']]);
});

check('the first entry that fits is used, and a team named in several ways still fits', () => {
  assert.equal(welcomeFor(setting, person('cs', ['csr']))?.headline, 'What needs sorting?');
  assert.equal(welcomeFor(setting, person('rep', ['sales', 'customer-service']))?.headline, '{hello}. Who are we helping today?', 'order decides');
});

check('an entry for the whole staff audience catches anyone in a team that has none of its own', () => {
  assert.equal(welcomeFor(setting, person('rep', ['finance']))?.headline, 'How can we help?');
});

check('a shopper never gets a staff entry, and gets nothing when no entry is for shoppers', () => {
  assert.equal(welcomeFor(setting, person('customer')), undefined);
  assert.equal(welcomeFor(setting, person('buyer')), undefined);
});

check('a team can say what its empty message box says, and a team that does not leaves it to the shop', () => {
  const words = WelcomeSchema.parse({ entries: [
    { groups: ['finance'], headline: 'Which account?', placeholder: 'Ask about an account, an invoice or what is overdue…' },
    { audience: 'staff', headline: 'How can we help?' },
  ] });
  assert.equal(welcomeFor(words, person('rep', ['finance']))?.placeholder, 'Ask about an account, an invoice or what is overdue…');
  assert.equal('placeholder' in (welcomeFor(words, person('rep', ['branch'])) ?? {}), false);
  assert.equal(WelcomeSchema.safeParse({ entries: [{ audience: 'staff', placeholder: 'x'.repeat(101) }] }).success, false, 'it has to fit in the box');
  assert.equal(WelcomeSchema.safeParse({ entries: [{ audience: 'staff', placeholder: '' }] }).success, false);
});

check('no setting, or a setting that is not a list, gives nothing', () => {
  assert.equal(welcomeFor(undefined, person('rep', ['sales'])), undefined);
  assert.equal(welcomeFor({ entries: 'x' }, person('rep', ['sales'])), undefined);
});

check('an explicit empty starter list survives the server boundary', () => {
  assert.deepEqual(welcomeFor({ entries: [{ audience: 'shopper', starters: [] }] }, person('buyer')), { starters: [] });
});

check('the setting is checked: an entry must say who it is for, a tool must look like system.tool, and nothing extra is allowed', () => {
  assert.equal(WelcomeSchema.safeParse({ entries: [{ headline: 'Hi' }] }).success, false);
  assert.equal(WelcomeSchema.safeParse({ entries: [{ audience: 'staff', starters: [{ label: 'a', prompt: 'b', needs: ['nosystem'] }] }] }).success, false);
  assert.equal(WelcomeSchema.safeParse({ entries: [{ audience: 'staff', extra: 1 }] }).success, false);
  assert.equal(WelcomeSchema.safeParse({ entries: [{ audience: 'shopper', headline: 'Welcome' }] }).success, true);
});

console.log(`\n✅ Welcome: ${passed} passed`);
