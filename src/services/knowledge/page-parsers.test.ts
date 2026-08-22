import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecs, parseImages } from './page-parsers';

/** A page shaped the way the scraper actually produces them. */
const PAGE = `Liano II Wall Basin Mixer

Some marketing copy about the product.

Specifications
Item Code
96345C
Colour
Chrome
WELS Rating
5 Star
Flow Rate
5 L/min
Material
Brass
Warranty
20 Years

Technical Downloads
[Installation Guide](https://caroma.com.au/guide.pdf)

--- Product Images ---
https://cdn.caroma.com.au/liano-hero.jpg
https://cdn.caroma.com.au/liano-detail.jpg
`;

describe('parseSpecs', () => {
  test('extracts key/value pairs from the specifications block', () => {
    const specs = parseSpecs(PAGE);
    assert.equal(specs['Colour'], 'Chrome');
    assert.equal(specs['WELS Rating'], '5 Star');
    assert.equal(specs['Flow Rate'], '5 L/min');
    assert.equal(specs['Material'], 'Brass');
  });

  test('stops at Technical Downloads', () => {
    const specs = parseSpecs(PAGE);
    // Anything after the downloads heading is links, not specs.
    assert.ok(!Object.keys(specs).some(k => k.includes('Installation')));
    assert.ok(!Object.values(specs).some(v => v.includes('.pdf')));
  });

  test('skips the Product Codes list', () => {
    const specs = parseSpecs('Specifications\nProduct Codes\n96345C\nColour\nChrome');
    assert.equal(specs['Product Codes'], undefined);
    assert.equal(specs['Colour'], 'Chrome');
  });

  test('skips purely numeric keys, which mean the pairing has slipped', () => {
    const specs = parseSpecs('Specifications\n96345C\nsomething\nColour\nChrome');
    assert.equal(specs['96345C'], undefined);
  });

  test('returns an empty object when there is no specifications block', () => {
    assert.deepEqual(parseSpecs('Just some prose about taps.'), {});
  });

  test('rejects markup and URLs masquerading as keys', () => {
    const specs = parseSpecs('Specifications\n[link](http://x)\nvalue\nhttp://y\nvalue2');
    assert.deepEqual(specs, {});
  });

  test('rejects an over-long value', () => {
    const specs = parseSpecs(`Specifications\nColour\n${'x'.repeat(200)}`);
    assert.equal(specs['Colour'], undefined);
  });

  test('survives empty, whitespace and non-string input without throwing', () => {
    assert.deepEqual(parseSpecs(''), {});
    assert.deepEqual(parseSpecs('   \n\n  '), {});
    assert.deepEqual(parseSpecs(undefined as unknown as string), {});
    assert.deepEqual(parseSpecs(null as unknown as string), {});
  });

  test('caps output so a malformed page cannot flood the prompt', () => {
    const many = ['Specifications'];
    for (let i = 0; i < 200; i++) many.push(`Key${i}`, `Value${i}`);
    assert.ok(Object.keys(parseSpecs(many.join('\n'))).length <= 40);
  });
});

describe('parseImages', () => {
  test('reads URLs from the Product Images marker', () => {
    assert.deepEqual(parseImages(PAGE), [
      'https://cdn.caroma.com.au/liano-hero.jpg',
      'https://cdn.caroma.com.au/liano-detail.jpg',
    ]);
  });

  test('falls back to scanning for CDN URLs when the marker is absent', () => {
    const legacy = 'Copy here https://cdn.caroma.com.au/old.jpg and more text.';
    assert.deepEqual(parseImages(legacy), ['https://cdn.caroma.com.au/old.jpg']);
  });

  test('deduplicates a repeated hero image', () => {
    const dupes = `--- Product Images ---\nhttps://cdn.x/a.jpg\nhttps://cdn.x/a.jpg\nhttps://cdn.x/b.jpg`;
    assert.deepEqual(parseImages(dupes), ['https://cdn.x/a.jpg', 'https://cdn.x/b.jpg']);
  });

  test('ignores non-URL lines under the marker', () => {
    const noisy = `--- Product Images ---\nnot a url\nhttps://cdn.x/a.jpg\n\n  `;
    assert.deepEqual(parseImages(noisy), ['https://cdn.x/a.jpg']);
  });

  test('returns an empty array when there are no images', () => {
    assert.deepEqual(parseImages('No pictures here.'), []);
    assert.deepEqual(parseImages(''), []);
    assert.deepEqual(parseImages(undefined as unknown as string), []);
  });

  test('caps the number of images returned', () => {
    const lines = ['--- Product Images ---'];
    for (let i = 0; i < 50; i++) lines.push(`https://cdn.x/${i}.jpg`);
    assert.ok(parseImages(lines.join('\n')).length <= 12);
  });
});

describe('the layout assumptions these parsers depend on', () => {
  // These are the properties that break when Caroma changes their page
  // template. If one of these fails, the parser is not buggy — the source
  // format moved, and the fix is to look at a real scraped page.
  test('the specs block is introduced by the literal word "Specifications"', () => {
    assert.deepEqual(parseSpecs('Specs\nColour\nChrome'), {});
  });

  test('specs are alternating lines, not "key: value" on one line', () => {
    assert.deepEqual(parseSpecs('Specifications\nColour: Chrome\nMaterial: Brass'), {
      'Colour: Chrome': 'Material: Brass',
    });
  });
});
