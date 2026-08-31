import fs from 'node:fs';
import path from 'node:path';

const directory = new URL('.', import.meta.url).pathname;
const files = fs.readdirSync(directory).filter((file) => file.endsWith('.html'));
const issues = [];

for (const file of files) {
  const html = fs.readFileSync(path.join(directory, file), 'utf8');
  const required = ['<!doctype html>', '<title>', 'meta name="description"', 'data-site-header', 'data-site-footer'];
  for (const marker of required) {
    if (!html.includes(marker)) issues.push(`${file}: missing ${marker}`);
  }

  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    if (/^(https?:|mailto:|#)/.test(href) || href === 'styles.css') continue;
    const target = href.split('#')[0];
    if (target && !fs.existsSync(path.join(directory, target))) issues.push(`${file}: missing link ${href}`);
  }
  console.log(`${file}: ${html.length} bytes`);
}

const css = fs.readFileSync(path.join(directory, 'styles.css'), 'utf8');
const openingBraces = (css.match(/{/g) || []).length;
const closingBraces = (css.match(/}/g) || []).length;
if (openingBraces !== closingBraces) issues.push(`styles.css: brace mismatch ${openingBraces}/${closingBraces}`);

if (issues.length) {
  console.error(issues.join('\n'));
  process.exit(1);
}

console.log(`Validated ${files.length} HTML pages with no broken local file links.`);
