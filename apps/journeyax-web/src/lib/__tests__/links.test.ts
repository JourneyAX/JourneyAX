/**
 * Links open where the chat is. Run with:
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/__tests__/links.test.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LINK_TARGET, linkProps, openLink } from '../links';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

check('a link opens in the same place, and keeps the safe rel', () => {
  assert.equal(LINK_TARGET, '_self');
  assert.deepEqual(linkProps, { target: '_self', rel: 'noopener noreferrer' });
});

check('opening from code goes to the address in the same place, and only for web or relative addresses', () => {
  const seen: string[] = [];
  const go = (url: string) => { seen.push(url); };
  assert.equal(openLink('https://www.example.com/page', go), true);
  assert.equal(openLink('  /guides/install.pdf ', go), true);
  assert.equal(openLink('', go), false);
  assert.equal(openLink('javascript:alert(1)', go), false, 'a script address is never opened');
  assert.equal(openLink('data:text/html,hi', go), false);
  assert.deepEqual(seen, ['https://www.example.com/page', '/guides/install.pdf']);
});

check('nothing in the web app opens a new tab or window', () => {
  const root = path.resolve(__dirname, '../..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        walk(full);
      } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) {
        const text = readFileSync(full, 'utf8');
        if (/target=["']_blank["']|target:\s*['"]_blank['"]|window\.open\(/.test(text)) offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `these open a new tab: ${offenders.join(', ')}`);
});

console.log(`✅ web: links: ${passed} passed, 0 failed`);
