import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { guideDocId, guidesFromProductRecord, hasReadableText, headingsOf, rankPassages, readGuides, splitPassages, tidyGuideText, type ProductGuideRecord } from '../src/agent/product-guides';
import { ProductGuideRepository } from '../src/kernel/product-guide.repository';
import { validateOkfGeneratedClaims } from '../src/kernel/okf-claim-validator';
import { executeAgentTool, type AgentToolContext } from '../src/agent/agent-tools';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';

const suite = createSuite('runtime: reading a product\'s own guide');

const SPEC_TEXT = [
  'Technical Data Sheet',
  'PRODUCT DESCRIPTION',
  'A water based construction adhesive with fast initial grab.',
  ' \tRepositionable for up to 60 minutes after the bead is laid',
  ' \tBridges gaps of up to 9mm',
  'APPLICATION',
  'Apply a continuous bead around the edge of the panel and in a zigzag across the middle.',
  'Press the panel into place within 10 minutes.',
  'Surfaces must be clean, dry and free of dust before gluing.',
  'STORAGE',
  'Store in a cool dry place. Shelf life is 12 months in the unopened tube.',
].join('\n');

const INSTALL_TEXT = Array.from({ length: 40 }, (_, i) => (i === 17
  ? 'Fasteners are spaced at 200mm centres along the sheet edges and 300mm centres in the field.'
  : `Section ${i}: general notes about handling and storing sheets on site, number ${i}, nothing more to add here.`)).join('\n');

const record = (over: Partial<ProductGuideRecord> & { docId: string; title: string; text: string }): ProductGuideRecord => ({
  tenantId: 'test-tenant', skus: ['G1'], textChars: over.text.length, ...over,
});

const shop = (guides: ProductGuideRecord[], extensions: Record<string, any> = { productGuides: { unlocks: ['installation_step', 'requirement'] } }): AgentToolContext & { gaps: any[] } => {
  const products = [
    { projectId: 'test-tenant', sku: 'G1', parentSku: 'G1', name: 'Nailbond Fast Adhesive 300ml', title: 'Nailbond Fast Adhesive 300ml', category: 'Adhesives', categoryPath: ['Adhesives'], price: { amount: 12, currency: 'NZD' }, inStock: true },
    { projectId: 'test-tenant', sku: 'G2', parentSku: 'G2', name: 'Plain Sheet 2400 x 1200mm', title: 'Plain Sheet 2400 x 1200mm', category: 'Sheets', categoryPath: ['Sheets'], price: { amount: 30, currency: 'NZD' }, inStock: true },
  ];
  const repo = new ProductGuideRepository();
  for (const guide of guides) repo.addForTest(guide);
  const gaps: any[] = [];
  return Object.assign({
    tenantId: 'test-tenant', environmentId: 'test' as const, correlationId: 'c', catalogSearchHandler: new CatalogSearchHandler(products as any),
    release: { profile: { primaryCurrency: 'NZD' }, extensions } as any,
    productGuideRepo: repo,
    knowledgeGapRepo: { recordGap: async (gap: any) => { gaps.push(gap); return gap; } } as any,
    turnProductSkus: new Set<string>(), catalogProductCache: new Map<string, any>(), readSourceIds: new Set<string>(), allowedClaimClasses: new Set<any>(), presentedCards: [], isHumanHandoffRequested: false,
  }, { gaps });
};

async function main() {
  await suite.test('guide text is tidied the way a person reads it', () => {
    const tidy = tidyGuideText('A\u0000B\r\n \tfirst   point here\n\n\n\nnext');
    assert.equal(tidy, 'AB\n• first point here\n\nnext');
    assert.equal(tidyGuideText(undefined), '');
    assert.equal(tidyGuideText(42), '');
  });

  await suite.test('a guide is cut into passages at line ends, none longer than the limit, and a heading starts a new passage once one is well filled', () => {
    const passages = splitPassages(SPEC_TEXT, 220);
    assert.ok(passages.length >= 3, `expected several passages, got ${passages.length}`);
    for (const passage of passages) assert.ok(passage.length <= 220, `passage of ${passage.length} characters`);
    assert.ok(passages.join('\n').includes('Press the panel into place within 10 minutes.'), 'no text is lost');
    assert.deepEqual(splitPassages('', 300), []);
    const oneLong = splitPassages(`${'word '.repeat(300)}`.trim(), 400);
    assert.ok(oneLong.length >= 4 && oneLong.every((passage) => passage.length <= 400), 'a line longer than the limit is cut at spaces');
  });

  await suite.test('passages that share the question\'s uncommon words rank first, and words nobody uses count for nothing', () => {
    const passages = ['storing sheets on site', 'fasteners are spaced at 200mm centres', 'storing sheets flat and dry', 'handling notes'];
    assert.equal(rankPassages(passages, 'how far apart are the fasteners spaced')[0], 1);
    assert.deepEqual(rankPassages(passages, 'zzz qqq'), []);
    assert.deepEqual(rankPassages(passages, 'is it ok'), [], 'words of one or two letters are ignored');
    assert.deepEqual(rankPassages([], 'anything'), []);
  });

  await suite.test('a record\'s guides are the readable ones: no maker home page, no empty text, links only when they are web addresses', () => {
    const guides = guidesFromProductRecord({
      documents: [
        { title: 'Specification Guide', type: 'pdf', url: 'https://example.test/a.pdf', pages: 3, text: SPEC_TEXT },
        { title: 'Supplier Information - example.test', type: 'supplier', url: 'https://example.test/', text: 'Our home page' },
        { title: 'Installation Guide', type: 'pdf', url: 'https://example.test/b.pdf', pages: 24, text: '   ' },
        { title: 'Instruction Manual', type: 'pdf', url: 'javascript:alert(1)', text: 'Open the box.' },
      ],
    });
    assert.deepEqual(guides.map((g) => g.title), ['Specification Guide', 'Instruction Manual']);
    assert.equal(guides[0].pages, 3);
    assert.equal(guides[1].url, undefined, 'a link that is not a web address is dropped');
    assert.equal(guideDocId('https://example.test/a.pdf', 'x', 'y'), guideDocId('https://example.test/a.pdf', 'other', 'other'), 'the same address is the same guide');
    assert.notEqual(guideDocId('https://example.test/a.pdf', 'x', 'y'), guideDocId('https://example.test/b.pdf', 'x', 'y'));
    assert.deepEqual(guidesFromProductRecord({}), []);
  });

  await suite.test('reading a guide: the passages that answer come back in the guide\'s own order; with no question the start comes back and says where to read on', () => {
    const spec = record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT, pages: 3, url: 'https://example.test/a.pdf' });
    const answered: any = readGuides([spec], { question: 'how long can I reposition it', passageChars: 220, maxPassages: 2 });
    assert.equal(answered.matched, true);
    assert.ok(answered.passages.some((p: any) => /60 minutes/.test(p.text)), JSON.stringify(answered.passages));
    assert.ok(answered.passages.length <= 2);
    const numbers = answered.passages.map((p: any) => p.n);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'in the order of the guide');

    const install = record({ docId: 'b'.repeat(32), title: 'Installation Guide', text: INSTALL_TEXT, pages: 24 });
    const opening: any = readGuides([install], { passageChars: 300, maxPassages: 3 });
    assert.equal(opening.matched, false);
    assert.equal(opening.passages[0].n, 1);
    assert.equal(opening.next.from, 4, 'the next read starts after the last passage shown');
    const further: any = readGuides([install], { from: opening.next.from, passageChars: 300, maxPassages: 3 });
    assert.equal(further.passages[0].n, 4);
    assert.ok(further.guides[0].passages > 3);
    const found: any = readGuides([install], { question: 'fasteners spaced centres', passageChars: 300, maxPassages: 2 });
    assert.ok(found.passages.some((p: any) => /200mm centres/.test(p.text)));
  });

  await suite.test('with several guides the question picks across them, one can be chosen by title, and an unknown one says what exists', () => {
    const spec = record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT });
    const install = record({ docId: 'b'.repeat(32), title: 'Installation Guide', text: INSTALL_TEXT });
    const both: any = readGuides([spec, install], { question: 'fasteners spaced centres and shelf life', passageChars: 300, maxPassages: 4 });
    const from = new Set(both.passages.map((p: any) => p.guide));
    assert.deepEqual([...from].sort(), ['Installation Guide', 'Specification Guide']);
    const only: any = readGuides([spec, install], { guide: 'install', question: 'shelf life', passageChars: 300 });
    assert.deepEqual(only.guides.map((g: any) => g.title), ['Installation Guide']);
    const missing: any = readGuides([spec, install], { guide: 'maintenance' });
    assert.deepEqual(missing, { error: 'no_such_guide', available: ['Specification Guide', 'Installation Guide'] });
  });

  await suite.test('a long guide comes with its numbered headings and where each is, without list items, contents lines or running page headers', () => {
    assert.deepEqual(headingsOf('6.9 SHEET FIXING WITH FASTFIX ONLY\n1. Cut edges must be sealed\n5.1 General Requirements 11\n2-piece Base and Cap\nSTORAGE AND CARE\nplain sentence here'), [
      { text: '6.9 SHEET FIXING WITH FASTFIX ONLY', level: 2 },
      { text: 'STORAGE AND CARE', level: 0 },
    ]);
    const pages = Array.from({ length: 30 }, (_, i) => [
      `${i + 3} Installation Manual November 2016`,
      i === 20 ? '6.9 Sheet fixing with Fastfix only' : `6.${(i % 9) + 1} Heading ${'abcdefghij'[i % 10]}${'klmnopqrst'[i % 10]}`,
      i === 20 ? 'Sheets can be fixed at 300mm centres.' : 'Plain filler text for this section, one line of a passage.',
    ].join('\n'));
    const long = record({ docId: 'd'.repeat(32), title: 'Installation Manual', text: pages.join('\n').replace(/\n/g, '\n') });
    const reading: any = readGuides([long], { question: 'zzz', passageChars: 200, maxPassages: 3 });
    const outline: Array<{ n: number; heading: string }> = reading.guides[0].outline;
    assert.ok(Array.isArray(outline) && outline.length > 3, 'a guide longer than one read has an outline');
    assert.ok(outline.some((entry) => /6\.9 Sheet fixing with Fastfix only/.test(entry.heading)), JSON.stringify(outline.slice(0, 5)));
    assert.ok(!outline.some((entry) => /Installation Manual November/.test(entry.heading)), 'a running page header is not a heading');
    const short: any = readGuides([record({ docId: 'e'.repeat(32), title: 'Spec', text: SPEC_TEXT })], { maxPassages: 8 });
    assert.equal(short.guides[0].outline, undefined, 'a guide that fits in one read needs no outline');
    const goto: any = readGuides([long], { guide: 'manual', from: outline.find((entry) => /6\.9 Sheet fixing/.test(entry.heading))!.n, passageChars: 200, maxPassages: 2 });
    assert.ok(/300mm centres/.test(goto.passages.map((p: any) => p.text).join(' ')), 'reading from the section\'s passage reaches its text');
  });

  await suite.test('a product the model names by its exact title is found, and one it only half names is not guessed', async () => {
    const ctx = shop([record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT })]);
    const byTitle: any = await executeAgentTool('read_product_guide', { sku: 'Nailbond Fast Adhesive 300ml' }, ctx);
    assert.equal(byTitle.ok, true, JSON.stringify(byTitle));
    assert.equal(byTitle.sku, 'G1');
    const half: any = await executeAgentTool('read_product_guide', { sku: 'Nailbond Adhesive' }, shop([record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT })]));
    assert.equal(half.ok, false, 'a near match is never taken for the product');
  });

  await suite.test('the store answers for the tenant that asks, by the product or its parent, and an unreachable database is no guide rather than an error', async () => {
    const previousUri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      const repo = new ProductGuideRepository();
      repo.addForTest(record({ docId: 'a'.repeat(32), title: 'Spec', text: 'x', skus: ['P1', 'P2'] }));
      repo.addForTest(record({ docId: 'b'.repeat(32), title: 'Other shop', text: 'y', skus: ['P1'], tenantId: 'other-tenant' }));
      assert.deepEqual((await repo.findForProducts('test-tenant', ['P2', ''])).map((g) => g.title), ['Spec']);
      assert.deepEqual((await repo.findForProducts('other-tenant', ['P1'])).map((g) => g.title), ['Other shop']);
      assert.deepEqual(await repo.findForProducts('test-tenant', ['NOPE']), []);
      assert.deepEqual(await repo.findForProducts('', ['P1']), []);

      let asked: any;
      const db = { collection: () => ({ find: (query: any, options: any) => { asked = { query, options }; return { limit: () => ({ toArray: async () => [{ title: 'From the database' }] }) }; } }) };
      const live = new ProductGuideRepository(db);
      assert.equal((await live.findForProducts('test-tenant', ['P1', 'P1', ' P2 ']))[0].title, 'From the database');
      assert.deepEqual(asked.query, { tenantId: 'test-tenant', skus: { $in: ['P1', 'P2'] } }, 'every read names the tenant');
      assert.deepEqual(asked.options.projection, { _id: 0 });
      const broken = new ProductGuideRepository({ collection: () => ({ find: () => { throw new Error('down'); } }) });
      assert.deepEqual(await broken.findForProducts('test-tenant', ['P1']), []);
    } finally {
      if (previousUri !== undefined) process.env.MONGODB_URI = previousUri;
    }
  });

  await suite.test('read_product_guide hands the agent the supplier\'s passages and unlocks only the claim classes the shop named', async () => {
    const ctx = shop([record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT, pages: 3, url: 'https://example.test/a.pdf' })]);
    const result: any = await executeAgentTool('read_product_guide', { sku: 'G1', question: 'how long can I reposition it' }, ctx);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.found, true);
    assert.equal(result.answeredFromGuide, true);
    assert.ok(result.passages.some((p: any) => /60 minutes/.test(p.text)));
    assert.equal(result.guides[0].link, 'https://example.test/a.pdf');
    assert.match(result.passages[0].passage, /^\d+ of \d+$/);
    assert.ok(ctx.turnProductSkus.has('G1'), 'the product was looked up for real');
    assert.deepEqual([...ctx.allowedClaimClasses].sort(), ['installation_step', 'requirement']);
    assert.equal(validateOkfGeneratedClaims('Install the panel within 10 minutes.', [], {}).valid, false, 'without the unlock the reply guard holds the sentence back');
    assert.equal(validateOkfGeneratedClaims('Install the panel within 10 minutes.', [...ctx.allowedClaimClasses], {}).valid, true, 'with it the supplier\'s instruction can be passed on');
    assert.equal(validateOkfGeneratedClaims('This is compliant with the building code.', [...ctx.allowedClaimClasses], {}).valid, false, 'a class the shop did not name stays held back');

    const noUnlock = shop([record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT })], { productGuides: {} });
    await executeAgentTool('read_product_guide', { sku: 'G1' }, noUnlock);
    assert.equal(noUnlock.allowedClaimClasses.size, 0, 'a shop that names nothing unlocks nothing');
    const unknownClass = shop([record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT })], { productGuides: { unlocks: ['not_a_class', 'care_safety'] } });
    await executeAgentTool('read_product_guide', { sku: 'G1' }, unknownClass);
    assert.deepEqual([...unknownClass.allowedClaimClasses], ['care_safety']);
  });

  await suite.test('read_product_guide says plainly when there is no guide text, records the gap, and refuses what it cannot honestly read', async () => {
    const ctx = shop([record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT })]);
    const none: any = await executeAgentTool('read_product_guide', { sku: 'G2', question: 'fixing' }, ctx);
    assert.deepEqual([none.ok, none.found], [true, false]);
    assert.match(none.message, /do not have the text of a guide/);
    assert.equal(ctx.gaps.length, 1);
    assert.equal(ctx.gaps[0].toolName, 'read_product_guide');
    assert.equal(ctx.allowedClaimClasses.size, 0, 'nothing is unlocked when nothing was read');

    const unknownProduct: any = await executeAgentTool('read_product_guide', { sku: 'ZZZ' }, ctx);
    assert.equal(unknownProduct.ok, false);
    const noSku: any = await executeAgentTool('read_product_guide', {}, ctx);
    assert.equal(noSku.ok, false);
    const wrongGuide: any = await executeAgentTool('read_product_guide', { sku: 'G1', guide: 'warranty' }, ctx);
    assert.equal(wrongGuide.ok, false);
    assert.match(wrongGuide.error, /Specification Guide/);
    const off = shop([record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT })], { productGuides: { enabled: false } });
    const switchedOff: any = await executeAgentTool('read_product_guide', { sku: 'G1' }, off);
    assert.equal(switchedOff.ok, false);
    assert.match(switchedOff.error, /not switched on/);

    const another = shop([record({ docId: 'c'.repeat(32), title: 'Their guide', text: SPEC_TEXT, tenantId: 'other-tenant' })]);
    const crossTenant: any = await executeAgentTool('read_product_guide', { sku: 'G1' }, another);
    assert.equal(crossTenant.found, false, 'another shop\'s guide is never read');
  });

  const SCAN_TEXT = Array.from({ length: 16 }, (_, i) => `-- ${i + 1} of 16 --`).join('\n\n');

  await suite.test('a scanned guide that came through as page markers alone has no readable text; a guide with words has, markers or not', () => {
    assert.equal(hasReadableText(SCAN_TEXT), false);
    assert.equal(hasReadableText(''), false);
    assert.equal(hasReadableText('Page 1\n\n12\n\n-- 3 de 16 --'), false, 'markers in another language are markers too');
    assert.equal(hasReadableText(`${SCAN_TEXT}\n\n${SPEC_TEXT}`), true);
    assert.equal(hasReadableText(SPEC_TEXT), true);
  });

  await suite.test('read_product_guide on a scanned guide says it cannot read it, gives the link, records the gap and never passes page markers on as passages', async () => {
    const scan = record({ docId: 'd'.repeat(32), title: 'Instruction Manual', kind: 'pdf', pages: 16, url: 'https://example.test/manual.pdf', text: SCAN_TEXT });
    const ctx = shop([scan]);
    const result: any = await executeAgentTool('read_product_guide', { sku: 'G1', question: 'how do I fit it' }, ctx);
    assert.deepEqual([result.ok, result.found, result.readable], [true, false, false]);
    assert.equal(result.passages, undefined, 'no page markers are handed over as if they were the guide');
    assert.deepEqual(result.guides, [{ guide: 'Instruction Manual', kind: 'pdf', pages: 16, link: 'https://example.test/manual.pdf' }]);
    assert.match(result.message, /cannot read its words/);
    assert.match(result.message, /Never say what such a guide contains/);
    assert.equal(ctx.gaps.length, 1);
    assert.match(ctx.gaps[0].topic, /no readable text/);
    assert.equal(ctx.allowedClaimClasses.size, 0, 'nothing is unlocked when nothing was read');
    const named: any = await executeAgentTool('read_product_guide', { sku: 'G1', guide: 'manual' }, shop([scan]));
    assert.equal(named.readable, false, 'asking for the scanned guide by name gets the same plain answer, not "no such guide"');
  });

  await suite.test('when a product has a scanned guide and a readable one, the readable one is read and the scanned one is named with its link', async () => {
    const ctx = shop([
      record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT }),
      record({ docId: 'd'.repeat(32), title: 'Instruction Manual', kind: 'pdf', url: 'https://example.test/manual.pdf', text: SCAN_TEXT }),
    ]);
    const result: any = await executeAgentTool('read_product_guide', { sku: 'G1', question: 'how long can I reposition it' }, ctx);
    assert.equal(result.found, true);
    assert.ok(result.passages.every((passage: any) => passage.guide === 'Specification Guide'));
    assert.deepEqual(result.alsoKept.map((entry: any) => [entry.guide, entry.link]), [['Instruction Manual', 'https://example.test/manual.pdf']]);
  });

  await suite.test('search_guides, which only finds general guides, points the agent at the product\'s own guide unless the shop switched it off', async () => {
    const on = shop([record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT })]);
    const found: any = await executeAgentTool('search_guides', { query: 'specification guide', productOrCategory: 'Nailbond' }, on);
    assert.equal(found.found, false);
    assert.match(found.productGuide, /read_product_guide/);
    const off = shop([record({ docId: 'a'.repeat(32), title: 'Specification Guide', text: SPEC_TEXT })], { productGuides: { enabled: false } });
    const quiet: any = await executeAgentTool('search_guides', { query: 'specification guide' }, off);
    assert.equal(quiet.productGuide, undefined);
  });

  await suite.test('a guide stored cut short says so, and a customer\'s own tap names the product', async () => {
    const ctx = shop([record({ docId: 'a'.repeat(32), title: 'Instruction Manual', text: SPEC_TEXT, truncated: true })]);
    ctx.customerEvent = { type: 'viewProduct', payload: { sku: 'G1' } };
    const result: any = await executeAgentTool('read_product_guide', { sku: '' }, ctx);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.guides[0].note, /stops before the end/);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
