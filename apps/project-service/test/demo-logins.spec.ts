import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { DEMO_STAFF } from '../../../scripts/placemakers/demo-staff';
import { demoLoginEntries } from '../../../scripts/placemakers/demo-logins';

/**
 * The file that makes the sign-in screen offer one button per demo persona: who each button is, and that nothing secret is in what the
 * browser is told (that part is tested with the web app; here the file's own shape).
 */
const library = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/personas/placemakers-personas.json'), 'utf8'));
const suite = createSuite('project-service: the demo persona sign-in file');

async function main() {
  await suite.test('every demo person has a button: staff are named after their team and persona, customers after their persona, each with a line about them', () => {
    const entries = demoLoginEntries(DEMO_STAFF, library);
    assert.equal(entries.length, DEMO_STAFF.length);
    const by = (email: string) => entries.find((entry) => entry.email === email)!;
    assert.deepEqual([by('csr@placemakers.demo').group, by('csr@placemakers.demo').team], ['Staff', 'Customer Service']);
    assert.equal(by('csr@placemakers.demo').label, 'Customer Service: Trade Support Advisor / Telesales');
    assert.equal(by('sales.manager@placemakers.demo').label, 'Sales Managers', 'a person who stands for no persona is named after the team');
    assert.equal(by('shopper@placemakers.demo').label, 'Renovating Homeowner');
    assert.equal(by('shopper@placemakers.demo').group, 'Customers');
    assert.equal(by('shopper@placemakers.demo').team, undefined);
    for (const entry of entries) { assert.ok(entry.description.length > 20, entry.email); assert.ok(entry.password.length >= 8, entry.email); }
    assert.equal(new Set(entries.map((entry) => entry.label)).size, entries.length, 'two buttons never read the same');
  });

  await suite.test('staff buttons describe what the team does, and the file keeps each person\'s own password', () => {
    const entries = demoLoginEntries(DEMO_STAFF, library);
    assert.match(entries.find((entry) => entry.email === 'branch@placemakers.demo')!.description, /stock by branch/);
    for (const person of DEMO_STAFF) assert.equal(entries.find((entry) => entry.email === person.email)!.password, person.password);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
