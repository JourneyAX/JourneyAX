/**
 * The persona buttons on the sign-in screen.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/__tests__/personaLogins.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PersonaLogins from '../PersonaLogins';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const logins = [
  { id: 'csr', label: 'Customer Service: Trade Support Advisor', description: 'Answers customers about orders.', group: 'Staff' as const, team: 'Customer Service' },
  { id: 'branch', label: 'Branch: Counter Sales Associate', description: 'Stock by branch.', group: 'Staff' as const, team: 'Branch' },
  { id: 'shopper', label: 'Renovating Homeowner', description: 'Plans a bathroom.', group: 'Customers' as const },
];
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(PersonaLogins as any, { logins, busyId: '', accent: '#a8346f', onPick: () => {}, ...props }));

check('nothing is drawn when the server offers no demo people (a real shop)', () => {
  assert.equal(render({ logins: [] }), '');
});

check('a button for each person, in two groups (colleagues and customers), each with its line', () => {
  const html = render();
  assert.equal((html.match(/data-persona=/g) || []).length, 3);
  assert.ok(html.includes('Try the demo as…') && html.includes('Colleagues') && html.includes('Customers'));
  for (const login of logins) assert.ok(html.includes(login.label) && html.includes(login.description), login.id);
  assert.ok(html.includes('No password needed'));
  assert.ok(!/password"/i.test(html.replace('No password needed', '')), 'there is no password field');
});

check('while one is being signed in, it says so and every button waits', () => {
  const html = render({ busyId: 'branch' });
  assert.ok(html.includes('Signing in…'));
  assert.equal((html.match(/disabled=""/g) || []).length, 3);
});

check('a group with nobody in it is not drawn', () => {
  const html = render({ logins: logins.filter((login) => login.group === 'Staff') });
  assert.ok(html.includes('Colleagues') && !html.includes('>Customers<'));
});

console.log(`✅ web: persona sign-in buttons: ${passed} passed, 0 failed`);
