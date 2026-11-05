import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';
import { executeAgentTool, type AgentToolContext } from '../src/agent/agent-tools';
import { ProductGuideRepository, indexedProductGuides } from '../src/kernel/product-guide.repository';
import { validateOkfGeneratedClaims } from '../src/kernel/okf-claim-validator';
import { normalizeCatalogProduct, resolveCatalogMapping } from '@journeyax/business-pack';
import { splitStreamingUnits, IncrementalSentenceShaper } from '../src/kernel/reply-shaper';
import { resolveInterpretationPolicy } from '../src/turn/fact-semantics';
import { collectSourceUrls, repairSourceLinks } from '../src/kernel/source-links';
import { resolveCustomerEventAction } from '../src/kernel/customer-event-policy';

const product = { projectId: 'merchant-a', parentSku: 'CAB-A', name: 'Cabinet with mixer', price: { amount: 125, currency: 'NZD' },
  availability: true, url: 'https://maker.example/cab-a', specs: { Width: '60 CMT', Height: '90 CMT', 'Warranty Duration': '5 ANN' },
  documents: [{ title: 'Written warranty', type: 'pdf', url: 'https://maker.example/cab-a.pdf' }] };
function context(products: any[] = [product]): AgentToolContext {
  return { tenantId: 'merchant-a', environmentId: 'test', correlationId: 'product-evidence', release: { profile: { primaryCurrency: 'NZD' }, extensions: {} } as any,
    catalogSearchHandler: new CatalogSearchHandler(products), productGuideRepo: ProductGuideRepository.forTest(),
    catalogProductCache: new Map(), turnProductSkus: new Set(), readSourceIds: new Set(), allowedClaimClasses: new Set(), presentedCards: [], isHumanHandoffRequested: false };
}

test('a completed missing-product lookup supports only its exact negative result', async () => {
  const ctx = context([]);
  const missing = await executeAgentTool('get_product', { sku: 'MISSING-127' }, ctx);
  assert.equal(missing.found, false);
  const evidence = { catalogueMisses: ctx.catalogueMisses, knownNumbers: new Set<string>() };
  assert.equal(validateOkfGeneratedClaims(missing.factualStatement, [], undefined, evidence).valid, true);
  assert.equal(validateOkfGeneratedClaims('I could not find SKU MISSING-127 in our catalogue.', [], undefined, evidence).valid, true);
  for (const text of [
    'SKU OTHER-127 was not found in our catalogue.',
    'SKU MISSING-127 was not found in our catalogue but costs $25.',
    'SKU MISSING-127 is available now.',
    'SKU MISSING-127 was not found in our catalogue and is guaranteed for 5 years.',
  ]) assert.equal(validateOkfGeneratedClaims(text, [], undefined, evidence).valid, false, text);
  assert.equal(validateOkfGeneratedClaims(missing.factualStatement, [], undefined, { knownNumbers: new Set() }).valid, false, 'a customer claim alone is not a negative lookup receipt');
  assert.equal(ctx.allowedClaimClasses.has('catalog_fact'), false, 'no blanket catalogue permission for an absent product');
});

test('a fuzzy result cannot substitute for an unavailable exact SKU', async () => {
  const ctx = context();
  ctx.catalogSearchHandler = { execute: async () => ({ products: [{ sku: 'OTHER', title: 'A similar product', price: 25 }] }) } as any;
  const result = await executeAgentTool('get_product', { sku: 'MISSING-127' }, ctx);
  assert.equal(result.found, false);
  assert.equal(ctx.turnProductSkus.size, 0);
  assert.equal(ctx.catalogProductCache.size, 0);
});

test('canonical product preserves nested specs, source links and the same measure display as Details', async () => {
  const ctx = context(); const result = await executeAgentTool('get_product', { sku: 'CAB-A' }, ctx);
  assert.equal(result.product.specs.Height, '90 CMT');
  assert.equal(result.product.displaySpecs.Height, '90 cm');
  assert.equal(result.product.lengthEquivalents.Height.mm, 900);
  assert.equal(result.product.displaySpecs['Warranty Duration'], '5 years');
  assert.equal(result.product.sourceUrl, product.url);
  assert.equal(result.product.documents[0].url, product.documents[0].url);
  assert.equal(result.product.specs.projectId, undefined, 'internal root fields are not specifications');
});

test('tenant-specified containers and duration keys replace defaults without reading another tenant shape', () => {
  const mapped = normalizeCatalogProduct({ ...product, technical: { Garantie: '12 MON' }, manuals: product.documents },
    resolveCatalogMapping({ attributeContainers: ['technical'], warrantyDurationKeys: ['Garantie'], documentPaths: ['manuals'] }), { title: '', category: '' });
  assert.equal(mapped.warrantyDuration, '12 MON');
  assert.equal(mapped.specs.Height, undefined);
  assert.equal(mapped.documents.length, 1);
});

test('catalogue duration survives a missing certificate and grants only a SKU-bound source statement', async () => {
  const ctx = context(); const result = await executeAgentTool('get_warranty', { productOrBrand: 'CAB-A' }, ctx);
  assert.equal(result.found, true);
  assert.equal(result.catalogue.duration, '5 years');
  assert.equal(result.termsFound, false);
  assert.equal(result.warranty.status, 'terms_not_on_file');
  assert.equal(ctx.allowedClaimClasses.has('warranty'), false, 'a duration must not authorize arbitrary warranty promises');
  const claims = { exactClaimStatements: ctx.exactClaimStatements, catalogueWarrantyFacts: ctx.catalogueWarrantyFacts };
  assert.equal(validateOkfGeneratedClaims('**Warranty Duration (SKU CAB-A): 5 years.**', [], undefined, claims).valid, true);
  assert.equal(validateOkfGeneratedClaims('The catalogue lists a 5-year warranty for SKU CAB-A.', [], undefined, claims).valid, true);
  assert.equal(validateOkfGeneratedClaims('- Catalogue warranty duration recorded for this SKU: 5 years.', [], undefined, claims).valid, true);
  for (const unsupported of ['The catalogue lists a 5-year warranty for SKU CAB-B.', 'The catalogue lists a 10-year warranty for SKU CAB-A.', 'The catalogue lists a 5-year warranty covering accidental damage.', 'Warranty Duration (SKU CAB-B): 5 years.', 'Warranty Duration (SKU CAB-A): 5 years and all damage is guaranteed.', 'This cabinet has a lifetime warranty.']) {
    assert.equal(validateOkfGeneratedClaims(unsupported, [], undefined, claims).valid, false, unsupported);
  }
});

test('a selected product title resolves exactly and a card action retains its SKU', async () => {
  assert.equal(resolveCustomerEventAction('askProduct'), 'start_turn');
  assert.equal(resolveCustomerEventAction('askProduct', { extensions: { customerEvents: { recordOnlyEvents: ['askProduct'] } } }), 'record_only');
  const ctx = context([product, { ...product, parentSku: 'CAB-B', name: 'Cabinet with mixer extra', specs: { 'Warranty Duration': '10 ANN' } }]);
  const byTitle = await executeAgentTool('get_warranty', { productOrBrand: product.name }, ctx);
  assert.equal(byTitle.catalogue.sku, 'CAB-A'); assert.equal(byTitle.catalogue.duration, '5 years');
  ctx.customerEvent = { type: 'askProduct', payload: { sku: 'CAB-A', title: product.name, question: 'What warranty does this have?' } };
  const fromCard = await executeAgentTool('get_warranty', { productOrBrand: product.name }, ctx);
  assert.equal(fromCard.sku, 'CAB-A');
  assert.equal((await executeAgentTool('get_warranty', { productOrBrand: 'Cabinet with mixer nonexistent' }, ctx)).found, false);
});

test('indexed PDFs require exact SKU or explicit product attachment and reject conflicting tenant ownership', () => {
  const rows = [
    { projectId: 'merchant-a', metadata: { brand: 'merchant-a', sku: 'CAB-A', sourceKind: 'pdf', url: 'https://maker.example/cab-a.pdf' }, chunkIndex: 1, content: 'Second warranty paragraph.' },
    { projectId: 'merchant-a', metadata: { brand: 'merchant-a', sku: 'CAB-A', sourceKind: 'pdf', url: 'https://maker.example/cab-a.pdf' }, chunkIndex: 0, content: 'First warranty paragraph.' },
    { projectId: 'merchant-a', metadata: { brand: 'merchant-a', sku: 'CAB-B', sourceKind: 'pdf', url: 'https://maker.example/cab-b.pdf' }, content: 'Another model has a different warranty.' },
    { projectId: 'merchant-b', metadata: { brand: 'merchant-a', sku: 'CAB-A', sourceKind: 'pdf', url: 'https://maker.example/private.pdf' }, content: 'Cross tenant.' },
    { projectId: 'merchant-a', metadata: { brand: 'merchant-a', sku: 'CAB-A', type: 'product', url: product.url }, content: 'A product summary is not a PDF.' },
  ];
  const found = indexedProductGuides('merchant-a', ['CAB-A'], [], rows);
  assert.equal(found.length, 1); assert.equal(found[0].text, 'First warranty paragraph.\n\nSecond warranty paragraph.');
  assert.equal(indexedProductGuides('merchant-a', ['UNRELATED'], [], rows).length, 0);
  assert.equal(indexedProductGuides('merchant-a', ['CAB-A'], ['https://maker.example/cab-b.pdf'], rows).length, 2, 'a source-owned attachment is an explicit association');
});

test('an explicit guide store failure never falls back and is not a confirmed missing guide', async () => {
  const previous = process.env.MONGODB_URI;
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/not-the-selected-store?serverSelectionTimeoutMS=10';
  try {
    const repository = new ProductGuideRepository(async () => { throw new Error('selected store offline'); });
    const result = await repository.readForProducts('merchant-a', ['CAB-A']);
    assert.deepEqual(result, { guides: [], status: 'unavailable' });
    const invalid = await new ProductGuideRepository(async () => ({})).readForProducts('merchant-a', ['CAB-A']);
    assert.equal(invalid.status, 'unavailable');
    const ctx = context(); ctx.productGuideRepo = repository;
    let gaps = 0; ctx.knowledgeGapRepo = { recordGap: async () => { gaps++; } } as any;
    const warranty = await executeAgentTool('get_warranty', { sku: 'CAB-A' }, ctx);
    assert.equal(warranty.catalogue.duration, '5 years');
    assert.equal(warranty.warranty.status, 'source_unavailable');
    const guide = await executeAgentTool('read_product_guide', { sku: 'CAB-A' }, ctx);
    assert.equal(guide.code, 'source_unavailable'); assert.equal(guide.found, false);
    assert.equal(gaps, 0, 'a failed source lookup is not evidence of missing merchant content');
  } finally { if (previous === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = previous; }
});

test('guide source partial failure preserves positive evidence without asserting complete absence', async () => {
  const rows = [{ tenantId: 'merchant-a', skus: ['CAB-A'], docId: 'positive', title: 'Warranty', text: 'Manufacturer warranty covers defects for five years.', textChars: 51 }];
  const repository = new ProductGuideRepository({ collection: (name: string) => ({ find: () => {
    if (name === 'documents') throw new Error('indexed source unavailable');
    return { limit: () => ({ toArray: async () => rows }) };
  } }) });
  const lookup = await repository.readForProducts('merchant-a', ['CAB-A']);
  assert.equal(lookup.status, 'partial'); assert.equal(lookup.guides[0].docId, 'positive');
  const emptyStore = new ProductGuideRepository({ collection: () => ({ find: () => ({ sort() { return this; }, limit() { return this; }, toArray: async () => [] }) }) });
  assert.deepEqual(await emptyStore.readForProducts('merchant-a', ['CAB-A']), { guides: [], status: 'available' });
});

test('an absent guide store is unavailable and a capped/truncated read is only partial', async () => {
  const previous = process.env.MONGODB_URI; delete process.env.MONGODB_URI;
  try { assert.equal((await new ProductGuideRepository().readForProducts('merchant-a', ['CAB-A'])).status, 'unavailable'); }
  finally { if (previous !== undefined) process.env.MONGODB_URI = previous; }
  const repository = new ProductGuideRepository({ collection: (name: string) => ({ find: () => ({ sort() { return this; }, limit() { return this; },
    toArray: async () => name === 'documents' ? [] : [{ tenantId: 'merchant-a', skus: ['CAB-A'], docId: 'limited', text: 'Partial source', textChars: 14, truncated: true }] }) }) });
  const result = await repository.readForProducts('merchant-a', ['CAB-A']);
  assert.equal(result.status, 'partial'); assert.equal(result.guides[0].docId, 'limited');
});

test('warranty reads linked product PDFs and keeps another product’s warranty unavailable', async () => {
  const ctx = context();
  ctx.productGuideRepo!.addForTest({ tenantId: 'merchant-a', skus: ['CAB-A'], docId: 'guide-a', title: 'Maker warranty', url: product.documents[0].url,
    text: 'Written manufacturer warranty: The cabinet carries a five year warranty against manufacturing defects. Keep the original receipt and consult the full terms for exclusions.', textChars: 165 });
  const result = await executeAgentTool('get_warranty', { productOrBrand: 'CAB-A' }, ctx);
  assert.equal(result.termsFound, true); assert.match(result.warranty.terms, /manufacturing defects/);
  assert.equal(result.guides[0].url, product.documents[0].url);
  const missing = await executeAgentTool('get_warranty', { productOrBrand: 'CAB-B' }, ctx);
  assert.equal(missing.found, false);
});

test('ordinary marketing guarantees are not reported as written warranty terms', async () => {
  const ctx = context();
  ctx.productGuideRepo!.addForTest({ tenantId: 'merchant-a', skus: ['CAB-A'], docId: 'marketing', title: 'Product guide',
    text: 'Our preparation process improves batch consistency, guaranteeing the user a consistent mortar time after time. Read the product instructions before choosing the appropriate materials.', textChars: 175 });
  const result = await executeAgentTool('get_warranty', { sku: 'CAB-A' }, ctx);
  assert.equal(result.found, true, 'the real source document exists even when no warranty terms are found');
  assert.equal(result.termsFound, false);
  assert.equal(result.catalogue.duration, '5 years');
});

test('a linked file naming a different catalogue SKU cannot grant warranty terms or product-guide instructions', async () => {
  const selected = { ...product, parentSku: 'CAB-A1', documents: [{ type: 'pdf', title: 'Specification', url: 'https://maker.example/CAB-B2_Specification.pdf' }] };
  const other = { ...product, parentSku: 'CAB-B2', name: 'Different model', documents: [] };
  const ctx = context([selected, other]);
  ctx.productGuideRepo!.addForTest({ tenantId: 'merchant-a', skus: ['CAB-A1'], docId: 'conflicting-file', title: 'Specification', url: selected.documents[0].url,
    text: 'Manufacturer warranty for the other model: a lifetime warranty against defects. This source text must not be transferred to a different product merely because an index links it.', textChars: 180 });
  const result = await executeAgentTool('get_warranty', { sku: 'CAB-A1' }, ctx);
  assert.equal(result.catalogue.duration, '5 years'); assert.equal(result.termsFound, false);
  assert.equal(result.rejectedGuides[0].reason, 'attachment_names_another_catalogued_product');
  assert.equal(ctx.readSourceIds.has('conflicting-file'), false);
  const reading = await executeAgentTool('read_product_guide', { sku: 'CAB-A1', question: 'Warranty terms?' }, ctx);
  assert.equal(reading.found, false); assert.equal(reading.rejectedGuides.length, 1);
});

test('honest missing-document wording survives without authorizing an appended promise', () => {
  for (const text of ['### Catalogue warranty / guarantee', '• Catalogue warranty duration:', '• Written warranty / guarantee terms (PDF or similar):', 'No separate breakdown of warranty for cabinet versus mixer.', 'The full warranty terms are not available in our records.', 'No linked PDF or detailed terms (conditions, exclusions, installation requirements) are attached in the system.', 'Guarantee terms are not available in our records.', '- No detailed written warranty / guarantee terms (coverage, exclusions, or whether cabinet, benchtop and mixer are treated separately) are attached to this record.', 'No written warranty terms were extracted from the document.', 'This is indexed as an instruction/installation type document.', 'We have no attached detailed warranty document to quote.']) {
    assert.equal(validateOkfGeneratedClaims(text, [], undefined).valid, true, text);
  }
  for (const text of ['No separate warranty document, but the product has a lifetime warranty.', 'The warranty terms are not available and it covers accidental damage.', 'No linked guide and installation must be performed at 300mm centres.', 'No separate document: this has a lifetime warranty.']) {
    assert.equal(validateOkfGeneratedClaims(text, [], undefined).valid, false, text);
  }
});

test('catalogue stock flags cannot become current inventory assertions on product cards', async () => {
  const ctx = context(); await executeAgentTool('get_product', { sku: 'CAB-A' }, ctx);
  const result = await executeAgentTool('present_card', { cardType: 'products', state: { products: [{ sku: 'CAB-A', inStock: true, availability: 'in_stock' }] } }, ctx);
  assert.equal(result.ok, true);
  const item = ctx.presentedCards[0].state.products[0];
  assert.equal(item.availability, 'unknown'); assert.equal(item.inStock, undefined);
});

test('a conflicted source record cannot authorise product-card facts or warranty', async () => {
  const source = { ...product, web: { productUrl: 'https://maker.example/another-product' }, featuresList: ['Unrelated feature'] };
  const ctx = context([source]);
  const found = await executeAgentTool('get_product', { sku: 'CAB-A' }, ctx);
  assert.equal(found.product.integrity.identityConsistent, false); assert.deepEqual(found.product.specs, {});
  assert.equal(found.product.catalogueWarranty, undefined); assert.equal(found.product.price, null);
  const result = await executeAgentTool('present_card', { cardType: 'products', state: { products: [{ sku: 'CAB-A', reason: 'Fits your room perfectly' }] } }, ctx);
  assert.equal(result.ok, false); assert.equal(result.code, 'catalogue_integrity_review'); assert.equal(ctx.presentedCards.length, 0);
  assert.equal((await executeAgentTool('get_warranty', { sku: 'CAB-A' }, ctx)).code, 'catalogue_integrity_review');
  assert.equal((await executeAgentTool('read_product_guide', { sku: 'CAB-A' }, ctx)).code, 'catalogue_integrity_review');
});

test('catalogue values alone cannot establish a completed installed-fit assessment', () => {
  for (const statement of ['At 121 cm wide, it fits your room.', 'This will fit along the wall.', 'It is the perfect fit for your space.', 'It fits comfortably into your layout.']) {
    assert.equal(validateOkfGeneratedClaims(statement, ['catalog_fact'], undefined, { knownNumbers: new Set(['121']) }).valid, false, statement);
  }
});

test('warranty cards and product explanations cannot introduce model-authored guarantees', async () => {
  const ctx = context();
  assert.equal((await executeAgentTool('present_card', { cardType: 'warranty', state: { items: [{ title: 'Invented', text: 'Lifetime guarantee' }] } }, ctx)).ok, false);
  await executeAgentTool('get_warranty', { productOrBrand: 'CAB-A' }, ctx);
  assert.equal((await executeAgentTool('present_card', { cardType: 'warranty', state: { items: [{ title: 'Invented', text: 'Lifetime guarantee' }] } }, ctx)).ok, true);
  assert.deepEqual(ctx.presentedCards.at(-1)!.state.items, [{ title: 'Warranty Duration', text: '5 years', url: product.url }]);
  await executeAgentTool('present_card', { cardType: 'products', state: { products: [{ sku: 'CAB-A', reason: 'Lifetime warranty guaranteed', highlights: ['Available now'], cautions: ['Invented'] }] } }, ctx);
  const item = ctx.presentedCards.at(-1)!.state.products[0];
  assert.equal(item.reason, undefined); assert.deepEqual(item.highlights, []); assert.deepEqual(item.cautions, []);
});

test('streaming validates a full parenthetical example and never leaves its opening fragment', () => {
  const text = 'The warranty covers accidental damage (e.g. chips and scratches). Ask the maker for written terms.';
  const parts = splitStreamingUnits(text);
  assert.equal(parts[0], 'The warranty covers accidental damage (e.g. chips and scratches).');
  const shape = new IncrementalSentenceShaper({ style: { ...resolveInterpretationPolicy().replyStyle, maxSentences: 20, dropListLines: false, forbiddenPhrases: [] }, companyNames: [], internalIds: [], questionCardShown: false }, [], true, () => {});
  for (const char of text) shape.processDelta(char);
  shape.flush();
  assert.doesNotMatch(shape.getStreamedText(), /e\.g|chips|damage/);
  assert.match(shape.getStreamedText(), /Ask the maker/);
  const incomplete = new IncrementalSentenceShaper({ style: resolveInterpretationPolicy().replyStyle, companyNames: [], internalIds: [], questionCardShown: false }, [], false, () => {});
  incomplete.processDelta('If you need details (e.g.'); incomplete.flush();
  assert.equal(incomplete.getStreamedText(), '');
});

test('source links restore only a uniquely matching returned destination and reject invented links', () => {
  const urls = new Set<string>();
  collectSourceUrls(urls, 'get_product', { found: true, sourceUrl: 'https://maker.example/catalogue/product/CAB-A' });
  collectSourceUrls(urls, 'present_card', { url: 'https://invented.example/fake' });
  assert.equal(repairSourceLinks('[product](https://maker.example/.../CAB-A)', urls), '[product](https://maker.example/catalogue/product/CAB-A)');
  assert.equal(repairSourceLinks('[warranty](https://invented.example/fake)', urls), 'warranty');
  urls.add('https://maker.example/different/CAB-A');
  assert.equal(repairSourceLinks('[product](https://maker.example/.../CAB-A)', urls), 'product', 'ambiguous abbreviations are not guessed');
});

test('source unit conversion labels and honest missing-terms statements do not become equivalence promises', () => {
  const context = { knownNumbers: new Set(['600']) };
  assert.equal(validateOkfGeneratedClaims('- Width: 600 mm (catalogue length equivalent).', ['catalog_fact'], undefined, context).valid, true);
  assert.equal(validateOkfGeneratedClaims('The full written guarantee terms (coverage details, exclusions, claim process, etc.) are not on file in our range data provided here, so I cannot specify them.', [], undefined, context).valid, true);
  assert.equal(validateOkfGeneratedClaims('This product is an equivalent replacement.', [], undefined, context).valid, false);
});
