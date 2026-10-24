import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { contentPageFromRow, contentPageId, findPage, pageAsGuide, searchPages, type ContentPageRecord } from '../src/agent/content-pages';
import { ContentPageRepository } from '../src/kernel/content-page.repository';
import { validateOkfGeneratedClaims } from '../src/kernel/okf-claim-validator';
import { executeAgentTool, type AgentToolContext } from '../src/agent/agent-tools';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';

const suite = createSuite('runtime: reading the shop\'s own pages');

const row = (over: Record<string, any> = {}) => ({
  url: 'https://shop.example/online/pergolas', title: 'How to build a pergola', summary: 'Plan, frame and fix a freestanding pergola.',
  contentCategory: ['Landscaping '], job: ['Projects'], urlCategory: 'projects',
  headings: [{ level: 1, text: 'How to build a pergola' }, { level: 2, text: 'Choosing posts' }],
  text: 'Home / Projects\n\nHow to build a pergola\nA pergola gives shade over a deck or patio.\nChoosing posts\nUse treated posts set 600mm into the ground.\nFixing the rafters\nFix rafters at 600mm centres.',
  featuredProducts: [{ sku: 'P1', name: 'Pergola Post' }, { sku: 'GONE', name: 'Retired post' }, { sku: 'P1', name: 'again' }, { sku: 'D1', name: 'Old discontinued' }],
  ...over,
});

const pageRecord = (tenantId: string, over: Record<string, any> = {}): ContentPageRecord => ({ tenantId, ...contentPageFromRow(row(over))! });

const shop = (pages: ContentPageRecord[], extensions: Record<string, any> = { contentPages: { unlocks: ['installation_step', 'legal_requirement'] } }): AgentToolContext & { gaps: any[] } => {
  const product = (sku: string, name: string, extra: Record<string, any> = {}) => ({ projectId: 'test-tenant', sku, parentSku: sku, name, title: name, category: 'Outdoor', categoryPath: ['Outdoor'], price: { amount: 10, currency: 'NZD' }, inStock: true, ...extra });
  const products = [product('P1', 'Pergola Post 100 x 100 H4'), product('D1', 'Old Post', { discontinued: true }), product('X1', 'Unrelated Item')];
  const repo = new ContentPageRepository();
  for (const page of pages) repo.addForTest(page);
  const gaps: any[] = [];
  return Object.assign({
    tenantId: 'test-tenant', environmentId: 'test' as const, correlationId: 'c', catalogSearchHandler: new CatalogSearchHandler(products as any),
    release: { profile: { primaryCurrency: 'NZD' }, extensions } as any,
    contentPageRepo: repo,
    knowledgeGapRepo: { recordGap: async (gap: any) => { gaps.push(gap); return gap; } } as any,
    turnProductSkus: new Set<string>(), catalogProductCache: new Map<string, any>(), readSourceIds: new Set<string>(), allowedClaimClasses: new Set<any>(), presentedCards: [], isHumanHandoffRequested: false,
  }, { gaps });
};

const energy = (tenantId = 'test-tenant') => pageRecord(tenantId, {
  url: 'https://shop.example/online/compliance-pathways', title: 'Compliance Pathways', summary: 'How to show a building meets the energy efficiency rules.',
  contentCategory: ['Trade', 'H1'], job: ['Trade'], urlCategory: 'compliance-pathways', headings: [{ text: 'Acceptable solutions' }],
  text: 'Compliance Pathways\nThere are different ways to show that a building complies with the Building Code.\nAcceptable solutions and verification methods can be used.', featuredProducts: [],
});

async function main() {
  await suite.test('a crawled row becomes a page: tidy text, labels without stray spaces, each featured product once, and a row without a title, address or text is not a page', () => {
    const page = contentPageFromRow(row())!;
    assert.equal(page.pageId, contentPageId('https://shop.example/online/pergolas'));
    assert.deepEqual(page.categories, ['Landscaping', 'Projects']);
    assert.deepEqual(page.headings, ['How to build a pergola', 'Choosing posts']);
    assert.deepEqual(page.products.map((p) => p.sku), ['P1', 'GONE', 'D1'], 'a product listed twice is kept once');
    assert.equal(page.textChars, page.text.length);
    assert.equal(contentPageFromRow(row({ title: '', displayTitle: '' })), undefined);
    assert.equal(contentPageFromRow(row({ text: '   ' })), undefined);
    assert.equal(contentPageFromRow(row({ url: 'javascript:alert(1)' })), undefined);
    assert.equal(contentPageFromRow(row({ text: 'x'.repeat(130_000) }))!.truncated, true);
  });

  await suite.test('pages are found by the question\'s words: a title word beats a body word, a rare word beats a common one, and nothing matching is an empty answer', () => {
    const pergola = pageRecord('t');
    const other = pageRecord('t', { url: 'https://shop.example/online/decks', title: 'Decking guide', summary: 'Choose boards.', headings: [], contentCategory: [], job: [], urlCategory: 'projects', text: 'Decking boards. A pergola can go over a deck.', featuredProducts: [] });
    const hits = searchPages([other, pergola], 'how do I build a pergola', 5);
    assert.equal(hits[0].title, 'How to build a pergola', 'the page about it comes before a page that only mentions it');
    assert.equal(hits[0].products, 3);
    assert.deepEqual(searchPages([pergola], 'zzz qqq'), []);
    assert.deepEqual(searchPages([], 'pergola'), []);
    assert.equal(searchPages([pergola, other], 'pergola', 1).length, 1);
  });

  await suite.test('a page is opened by its id, its address, its exact title, or a title only it contains; two candidates are not guessed between', () => {
    const a = pageRecord('t');
    const b = pageRecord('t', { url: 'https://shop.example/online/pergola-roofing', title: 'Pergola roofing options' });
    assert.equal((findPage([a, b], a.pageId) as ContentPageRecord).pageId, a.pageId);
    assert.equal((findPage([a, b], a.pageId.slice(0, 8)) as ContentPageRecord).pageId, a.pageId);
    assert.equal((findPage([a, b], 'https://shop.example/online/pergolas') as ContentPageRecord).pageId, a.pageId);
    assert.equal((findPage([a, b], 'how to BUILD a pergola') as ContentPageRecord).pageId, a.pageId);
    assert.equal((findPage([a, b], 'roofing') as ContentPageRecord).pageId, b.pageId);
    const ambiguous: any = findPage([a, b], 'pergola');
    assert.equal(ambiguous.error, 'ambiguous');
    assert.equal((findPage([a, b], 'nothing like it') as any).error, 'not_found');
    assert.equal(pageAsGuide(a).docId, a.pageId);
  });

  await suite.test('the store answers for the tenant that asks, keeps a read for a while, and an unreachable database is no pages', async () => {
    const previousUri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      let clock = 1_000;
      const repo = new ContentPageRepository(undefined, () => clock);
      repo.addForTest(pageRecord('test-tenant'));
      repo.addForTest(pageRecord('other-tenant'));
      assert.equal((await repo.listPages('test-tenant')).length, 1);
      assert.equal((await repo.listPages('other-tenant')).length, 1);
      assert.deepEqual(await repo.listPages('nobody'), []);
      assert.deepEqual(await repo.listPages(''), []);

      let reads = 0;
      const db = { collection: () => ({ find: (query: any) => { reads++; assert.deepEqual(query, { tenantId: 'test-tenant' }, 'every read names the tenant'); return { limit: () => ({ toArray: async () => [pageRecord('test-tenant')] }) }; } }) };
      const live = new ContentPageRepository(db, () => clock);
      await live.listPages('test-tenant');
      await live.listPages('test-tenant');
      assert.equal(reads, 1, 'two customers a minute apart share one read');
      clock += 11 * 60 * 1000;
      await live.listPages('test-tenant');
      assert.equal(reads, 2, 'the pages are read again after ten minutes');
      const broken = new ContentPageRepository({ collection: () => ({ find: () => { throw new Error('down'); } }) });
      assert.deepEqual(await broken.listPages('test-tenant'), []);
    } finally {
      if (previousUri !== undefined) process.env.MONGODB_URI = previousUri;
    }
  });

  await suite.test('read_content_page finds the page, returns its words, only catalogue products it features, and unlocks only the classes the shop named', async () => {
    const ctx = shop([pageRecord('test-tenant'), energy()]);
    const result: any = await executeAgentTool('read_content_page', { query: 'how do I build a pergola' }, ctx);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.page.title, 'How to build a pergola');
    assert.equal(result.page.link, 'https://shop.example/online/pergolas');
    assert.equal(result.answeredFromPage, true);
    assert.ok(result.passages.some((p: any) => /600mm centres/.test(p.text)));
    assert.deepEqual(result.featuredProducts, [{ sku: 'P1', title: 'Pergola Post 100 x 100 H4' }], 'a retired or discontinued product is left out');
    assert.ok(ctx.turnProductSkus.has('P1'), 'a featured product can be shown on a card');
    assert.deepEqual([...ctx.allowedClaimClasses].sort(), ['installation_step', 'legal_requirement']);
    assert.equal(validateOkfGeneratedClaims('A building must comply with the Building Code.', [], {}).valid, false);
    assert.equal(validateOkfGeneratedClaims('PlaceMakers\' page says a building complies with the Building Code through acceptable solutions.', [...ctx.allowedClaimClasses], {}).valid, true);

    const none = shop([pageRecord('test-tenant')], { contentPages: {} });
    await executeAgentTool('read_content_page', { query: 'pergola' }, none);
    assert.equal(none.allowedClaimClasses.size, 0, 'a shop that names nothing unlocks nothing');
  });

  await suite.test('read_content_page opens a chosen page, reads on, lists the other pages, and says plainly when nothing matches', async () => {
    const ctx = shop([pageRecord('test-tenant'), energy()]);
    const search: any = await executeAgentTool('read_content_page', { query: 'building code compliance pathways for the pergola' }, ctx);
    assert.ok(search.otherPages.length >= 1 && search.otherPages.every((p: any) => p.page && p.title && p.link), JSON.stringify(search.otherPages));
    const opened: any = await executeAgentTool('read_content_page', { page: 'Compliance Pathways' }, ctx);
    assert.equal(opened.ok, true);
    assert.equal(opened.page.title, 'Compliance Pathways');
    assert.deepEqual(opened.featuredProducts, []);
    assert.equal(opened.otherPages, undefined, 'opening a page is not a search');
    const missing: any = await executeAgentTool('read_content_page', { page: 'no such page here' }, ctx);
    assert.equal(missing.ok, false);

    const noMatch: any = await executeAgentTool('read_content_page', { query: 'zzz qqq' }, ctx);
    assert.deepEqual([noMatch.ok, noMatch.found], [true, false]);
    assert.equal(ctx.gaps.at(-1).toolName, 'read_content_page');
    const nothingAsked: any = await executeAgentTool('read_content_page', {}, ctx);
    assert.equal(nothingAsked.ok, false);
  });

  await suite.test('read_content_page never reads another shop\'s pages, and a shop that switched it off or has no pages gets an honest answer', async () => {
    const other = shop([pageRecord('other-tenant')]);
    const crossTenant: any = await executeAgentTool('read_content_page', { query: 'pergola' }, other);
    assert.deepEqual([crossTenant.ok, crossTenant.found], [true, false]);
    const off = shop([pageRecord('test-tenant')], { contentPages: { enabled: false } });
    const switchedOff: any = await executeAgentTool('read_content_page', { query: 'pergola' }, off);
    assert.equal(switchedOff.ok, false);
    assert.match(switchedOff.error, /not switched on/);
  });

  await suite.test('search_guides also points at the shop\'s own pages when they can be read', async () => {
    const ctx = shop([pageRecord('test-tenant')]);
    const result: any = await executeAgentTool('search_guides', { query: 'pergola' }, ctx);
    assert.match(result.sitePages, /read_content_page/);
    const off = shop([pageRecord('test-tenant')], { contentPages: { enabled: false } });
    const quiet: any = await executeAgentTool('search_guides', { query: 'pergola' }, off);
    assert.equal(quiet.sitePages, undefined);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
