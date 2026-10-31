/**
 * Shell helpers: worked-for lines, tenant theme, greeting, links.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/shell.test.ts
 */
import assert from 'node:assert/strict';
import { attachTrace, buildTrace, foldSteps, formatSeconds, formatWorkedFor, isWorkedTrace } from '../worked';
import { HONOUR_TENANT_SIDEBAR_STYLE, deriveShellTheme, initials, luminance, readableInk } from '../theme';
import { displayFirstName, resolveHero, timeOfDayHello } from '../greeting';
import { preservedQuery, shellHref } from '../nav';
import { readStored, writeStored, readStoredJson } from '../storage';

type Traced = { trace?: unknown };
let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('shell helpers');

check('"Worked for" reads in seconds, then minutes', () => {
  assert.equal(formatWorkedFor(12.4), 'Worked for 12 s');
  assert.equal(formatWorkedFor(0), 'Worked for 1 s', 'never says zero');
  assert.equal(formatSeconds(59.6), '1 min');
  assert.equal(formatSeconds(60), '1 min');
  assert.equal(formatSeconds(125), '2 min 5 s');
  assert.equal(formatSeconds(Number.NaN), '1 s');
});

check('steps fold repeats and blanks, and a quick plain turn leaves no line', () => {
  assert.deepEqual(foldSteps(['Looking', 'Looking', ' ', undefined, 'Checking', 'Looking']), ['Looking', 'Checking', 'Looking']);
  assert.equal(buildTrace(1000, 2500, []), null, '1.5 s with no steps is not worth a line');
  assert.deepEqual(buildTrace(0, 1500, ['Checking']), { seconds: 2, steps: ['Checking'] }, 'any step is worth a line');
  assert.deepEqual(buildTrace(0, 4000, []), { seconds: 4, steps: [] }, 'a slow turn with no steps still says how long');
  assert.ok(isWorkedTrace({ seconds: 3, steps: ['a'] }));
  assert.ok(!isWorkedTrace({ seconds: '3', steps: [] }));
  assert.ok(!isWorkedTrace(null));
});

check('a finished turn\'s trace is stored on its last assistant reply and nowhere else', () => {
  const trace = { seconds: 5, steps: ['Checking'] };
  const thread = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'first' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'second' }];
  const out = attachTrace(thread, trace);
  assert.equal((out[3] as Traced).trace, trace);
  assert.equal((out[1] as Traced).trace, undefined, 'earlier replies are left alone');
  assert.equal(thread[3].hasOwnProperty('trace'), false, 'the original list is not mutated');
  const withTools = attachTrace([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'calls', tool_calls: [{}] }, { role: 'tool', content: '{}' }, { role: 'assistant', content: 'answer' }, { role: 'tool', content: '{}' }], trace);
  assert.equal((withTools[3] as Traced).trace, trace, 'tool messages after the answer are skipped');
  assert.equal(attachTrace([{ role: 'user', content: 'a' }], trace)[0].hasOwnProperty('trace'), false, 'a turn that ended on the customer\'s message gets nothing');
  assert.deepEqual(attachTrace([], trace), []);
});

check('the tenant accent and colours come from its config; with none set the shell keeps its own palette', () => {
  assert.deepEqual(deriveShellTheme(null), { vars: {}, sidebarTone: 'light' });
  assert.deepEqual(deriveShellTheme({ theme: {}, uiTheme: { tokens: {} } }).vars, {});
  const navy = deriveShellTheme({ theme: { primaryColor: '#002855' } });
  assert.equal(navy.vars['--ax-accent-tenant'], '#002855');
  assert.equal(navy.vars['--ax-accent-ink-tenant'], '#FFFFFF');
  const yellow = deriveShellTheme({ theme: { primaryColor: '#FFD200' } });
  assert.equal(yellow.vars['--ax-accent-ink-tenant'], '#1F1C18', 'text on a light brand colour turns dark');
  const tokens = deriveShellTheme({ theme: { primaryColor: '#111111' }, uiTheme: { tokens: { colors: { brand: '#C00000', brandText: '#FAFAFA', bg: '#101010', text: '#EEEEEE' } } } });
  assert.equal(tokens.vars['--ax-accent-tenant'], '#C00000', 'card tokens win over the legacy theme block');
  assert.equal(tokens.vars['--ax-accent-ink-tenant'], '#FAFAFA');
  assert.equal(tokens.vars['--ax-bg-tenant'], '#101010');
  assert.equal(tokens.vars['--ax-text-tenant'], '#EEEEEE');
  assert.equal(tokens.vars['--ax-surface-tenant'], undefined, 'only what the tenant set is overridden');
  assert.deepEqual(deriveShellTheme({ theme: { primaryColor: 'not a colour' } }).vars, {}, 'a bad value is ignored');
});

check('a dark sidebar is honoured only when the tenant asks for one and the shell is set to honour it', () => {
  const dark = deriveShellTheme({ theme: { sidebarStyle: 'dark', sidebarColor: '#002855' } }, { honourSidebarStyle: true });
  assert.equal(dark.sidebarTone, 'dark');
  assert.equal(dark.vars['--ax-sidebar-bg-tenant'], '#002855');
  assert.equal(dark.vars['--ax-sidebar-ink-tenant'], '#FFFFFF');
  const lightWithColour = deriveShellTheme({ theme: { sidebarStyle: 'light', sidebarColor: '#002855' } }, { honourSidebarStyle: true });
  assert.equal(lightWithColour.sidebarTone, 'light');
  assert.equal(lightWithColour.vars['--ax-sidebar-bg-tenant'], undefined);
  assert.equal(deriveShellTheme({ theme: { sidebarStyle: 'dark' } }, { honourSidebarStyle: true }).vars['--ax-sidebar-bg-tenant'], undefined, 'dark without a colour keeps the default dark sidebar');
});

check('the dark sidebar option can be switched off for every tenant in one place', () => {
  const tenant = { theme: { primaryColor: '#002855', sidebarStyle: 'dark' as const, sidebarColor: '#002855' } };
  const off = deriveShellTheme(tenant, { honourSidebarStyle: false });
  assert.equal(off.sidebarTone, 'light');
  assert.equal(off.vars['--ax-sidebar-bg-tenant'], undefined);
  assert.equal(off.vars['--ax-accent-tenant'], '#002855', 'the accent still follows the tenant');
  assert.equal(HONOUR_TENANT_SIDEBAR_STYLE, false, 'the shipped default is the warm light sidebar for every tenant');
});

check('colour maths and initials', () => {
  assert.equal(luminance('#000'), 0);
  assert.equal(luminance('#FFFFFF'), 1);
  assert.equal(luminance('red'), null);
  assert.equal(readableInk('#FFFFFF'), '#1F1C18');
  assert.equal(readableInk(undefined), '#FFFFFF');
  assert.equal(initials('PlaceMakers (Fletcher Building)'), 'PM');
  assert.equal(initials('Caroma Industries Ltd'), 'CI');
  assert.equal(initials('admin'), 'AD');
  assert.equal(initials('', 'XX'), 'XX');
});

check('the greeting is the tenant\'s own, else neutral and never names a business', () => {
  const evening = new Date(2026, 9, 23, 19, 0);
  assert.equal(timeOfDayHello(new Date(2026, 9, 23, 8)), 'Good morning');
  assert.equal(timeOfDayHello(new Date(2026, 9, 23, 13)), 'Good afternoon');
  assert.equal(timeOfDayHello(evening), 'Good evening');
  assert.equal(timeOfDayHello(new Date(2026, 9, 23, 2)), 'Hello');
  assert.equal(displayFirstName('admin'), 'Admin');
  assert.equal(displayFirstName('  mary jones'), 'Mary');
  assert.deepEqual(resolveHero({ headline: 'Build it right.', subtitle: 'Plans and quotes.', name: 'admin' }), { title: 'Build it right.', subtitle: 'Plans and quotes.' });
  assert.deepEqual(resolveHero({ name: 'admin', now: evening }), { title: 'Good evening, Admin', subtitle: '' });
  assert.deepEqual(resolveHero({ now: evening }), { title: 'How can I help today?', subtitle: '' });
  assert.equal(resolveHero({ greeting: 'Hello! What are you working on?' }).subtitle, 'Hello! What are you working on?');
  assert.equal(resolveHero({ greeting: 'x'.repeat(300) }).subtitle, '', 'a long opening message is not squeezed under a headline');
});

check('links keep the tenant and embed flags and drop everything else', () => {
  assert.equal(preservedQuery('?project=acme&order=1&status=success'), '?project=acme');
  assert.equal(preservedQuery('?embed=1&project=acme'), '?project=acme&embed=1');
  assert.equal(preservedQuery(''), '');
  assert.equal(preservedQuery(undefined), '');
  assert.equal(shellHref('/customize', '?project=acme'), '/customize?project=acme');
  assert.equal(shellHref('/', '?other=1'), '/');
});

check('storage helpers never throw when storage is missing', () => {
  assert.equal(readStored('x'), null);
  assert.equal(writeStored('x', '1'), false);
  assert.deepEqual(readStoredJson('x', { a: 1 }), { a: 1 });
});

console.log(`✅ web: shell helpers: ${passed} passed, 0 failed`);
