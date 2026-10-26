/**
 * The demo persona sign-in: what the server reads from its private file, what the browser is told, and that nothing secret leaves.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/auth/__tests__/demoLogins.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findDemoLogin, loadDemoLogins, parseDemoLogins, publicView } from '../demoLogins';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const entry = (over: Record<string, unknown> = {}) => ({ email: 'csr@placemakers.demo', password: 'secret-1234', label: 'Customer Service', description: 'Answers customers.', group: 'Staff', team: 'Customer Service', ...over });

console.log('the file');

check('well-formed entries are kept (a list, or {logins: [...]}); the id is the part before the @; customers are marked as customers', () => {
  const list = parseDemoLogins([entry(), entry({ email: 'Shopper@Placemakers.demo', label: 'Shopper', group: 'Customers', team: undefined })]);
  assert.deepEqual(list.map((l) => [l.id, l.group, l.team]), [['csr', 'Staff', 'Customer Service'], ['shopper', 'Customers', undefined]]);
  assert.equal(list[1].email, 'shopper@placemakers.demo', 'e-mail is lower case');
  assert.equal(parseDemoLogins({ logins: [entry()] }).length, 1);
});

check('anything not well-formed is dropped, never half-shown: no e-mail, no password, no label, a repeated id, junk, or more than forty', () => {
  const bad = [entry({ email: 'nope' }), entry({ password: '' }), entry({ label: '' }), null, 7, 'x', entry(), entry()];
  assert.equal(parseDemoLogins(bad).length, 1);
  assert.deepEqual(parseDemoLogins('nonsense'), []);
  assert.deepEqual(parseDemoLogins(null), []);
  assert.equal(parseDemoLogins(Array.from({ length: 60 }, (_, i) => entry({ email: `p${i}@x.demo` }))).length, 40);
});

console.log('what the browser is told');

check('the browser gets the id, name, line and group, never the password or the e-mail', () => {
  const view = publicView(parseDemoLogins([entry()]));
  assert.deepEqual(view, [{ id: 'csr', label: 'Customer Service', description: 'Answers customers.', group: 'Staff', team: 'Customer Service' }]);
  const text = JSON.stringify(view);
  assert.ok(!text.includes('secret-1234') && !text.includes('@') && !/password/i.test(text));
});

check('a button is found by its id only; an e-mail, a password, a number or nothing finds nobody', () => {
  const list = parseDemoLogins([entry()]);
  assert.equal(findDemoLogin(list, 'csr')?.email, 'csr@placemakers.demo');
  for (const wrong of ['csr@placemakers.demo', 'secret-1234', 'CSR', '', 5, null, undefined, { id: 'csr' }]) assert.equal(findDemoLogin(list, wrong), undefined, String(wrong));
});

console.log('the server\'s file');

check('with no file named, or a file that is missing or broken, nobody is offered (a real shop offers nothing)', () => {
  assert.deepEqual(loadDemoLogins({} as NodeJS.ProcessEnv), []);
  assert.deepEqual(loadDemoLogins({ DEMO_LOGINS_FILE: '/nonexistent/demo.json' } as unknown as NodeJS.ProcessEnv), []);
  const dir = mkdtempSync(path.join(tmpdir(), 'demo-logins-'));
  try {
    writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    assert.deepEqual(loadDemoLogins({ DEMO_LOGINS_FILE: path.join(dir, 'broken.json') } as unknown as NodeJS.ProcessEnv), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

check('the file is read, and read again when it changes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'demo-logins-'));
  const file = path.join(dir, 'demo.json');
  const env = { DEMO_LOGINS_FILE: file } as unknown as NodeJS.ProcessEnv;
  try {
    writeFileSync(file, JSON.stringify({ logins: [entry()] }));
    assert.deepEqual(loadDemoLogins(env).map((l) => l.id), ['csr']);
    writeFileSync(file, JSON.stringify({ logins: [entry(), entry({ email: 'sales@placemakers.demo', label: 'Sales' })] }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    assert.deepEqual(loadDemoLogins(env).map((l) => l.id), ['csr', 'sales']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`✅ web: demo persona sign-ins: ${passed} passed, 0 failed`);
