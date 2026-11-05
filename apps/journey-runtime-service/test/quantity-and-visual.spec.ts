import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { areaToSquareMetres, estimateQuantity, pieceSizeFromName, statedCoverage } from '../src/agent/quantity-estimate';
import { buildVisualPrompt, generateVisual, readVisual } from '../src/agent/visual-generator';
import { executeAgentTool, type AgentToolContext } from '../src/agent/agent-tools';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';

const suite = createSuite('runtime: how many to buy, and pictures of the finished job');

const pavers = (extensions: Record<string, any> = {}): AgentToolContext => {
  const product = (sku: string, name: string, extra: Record<string, any> = {}) => ({ projectId: 'test-tenant', sku, parentSku: sku, name, title: name, category: 'Paving', categoryPath: ['Outdoor', 'Paving'], price: { amount: 12, currency: 'NZD' }, inStock: true, ...extra });
  const products = [
    product('P1', 'Forum Paver 400 x 400 x 50mm Glacier Honed'),
    product('P2', 'Holland Paver 200 x 100 x 80mm Natural'),
    product('D1', 'Decking 90 x 21mm Radiata'),
    product('T1', 'Primer 1 Litre Kit', { description: 'Primer in a 1 Litre container, offers 10 m-sq coverage' }),
    product('T2', 'Wall Paint 4L'),
  ];
  return {
    tenantId: 'test-tenant', environmentId: 'test', correlationId: 'c', catalogSearchHandler: new CatalogSearchHandler(products as any),
    release: { profile: { primaryCurrency: 'NZD' }, extensions: { ...extensions, quantityHelper: { pieceAreaCategories: ['Paving'], ...extensions.quantityHelper } } } as any,
    turnProductSkus: new Set(), catalogProductCache: new Map(), readSourceIds: new Set(), allowedClaimClasses: new Set(), presentedCards: [], isHumanHandoffRequested: false,
  };
};

async function main() {
  await suite.test('areas in the shop\'s own units become square metres, and anything else is not guessed', () => {
    const units = { m2: 1, sqm: 1, sqft: 0.09290304, ft2: 0.09290304 };
    assert.equal(areaToSquareMetres(40, undefined, units), 40, 'a number with no unit is square metres');
    assert.equal(areaToSquareMetres(40, 'sqm', units), 40);
    assert.ok(Math.abs(areaToSquareMetres(100, 'sq ft', units)! - 9.290304) < 1e-6);
    assert.ok(Math.abs(areaToSquareMetres(100, 'ft²', units)! - 9.290304) < 1e-6);
    assert.equal(areaToSquareMetres(-3, undefined, units), undefined);
    assert.equal(areaToSquareMetres(Number.NaN, undefined, units), undefined);
    assert.equal(areaToSquareMetres(10, 'acres', units), undefined, 'a unit the shop does not list is not guessed');
    assert.equal(areaToSquareMetres(10, 'sqft'), undefined, 'with no units configured only plain numbers are understood');
  });

  await suite.test('a piece covers the area its own name gives, and a board sold by length covers nothing', () => {
    assert.deepEqual(pieceSizeFromName('Forum Paver 400 x 400 x 50mm Glacier'), { length: 400, width: 400 });
    assert.deepEqual(pieceSizeFromName('Wallboard 2400 x 1200 x 10mm Taper Edge'), { length: 2400, width: 1200 });
    assert.equal(pieceSizeFromName('Decking 90 x 21mm Radiata'), undefined, 'both sides must be big enough to cover an area');
    assert.equal(pieceSizeFromName('Wall Paint 4L'), undefined);
  });

  await suite.test('pieces for an area: area over one piece, rounded up, plus the tenant\'s allowance when it has one', () => {
    const product = { title: 'Forum Paver 400 x 400 x 50mm Glacier', category: 'Paving' };
    const plain = estimateQuantity(product, { areaM2: 10 }, { pieceAreaCategories: ['Paving'] });
    assert.equal(plain.ok && plain.units, 63, '10 m2 / 0.16 m2 = 62.5 -> 63');
    const withAllowance = estimateQuantity(product, { areaM2: 10 }, { allowancePercent: 10, pieceAreaCategories: ['Paving'] });
    assert.ok(withAllowance.ok && withAllowance.units === 69 && withAllowance.exactUnits === 63, JSON.stringify(withAllowance));
    const customerAllowance = estimateQuantity(product, { areaM2: 10, allowancePercent: 0 }, { allowancePercent: 10, pieceAreaCategories: ['Paving'] });
    assert.equal(customerAllowance.ok && customerAllowance.units, 63, 'what the customer asks for beats the shop default');
  });

  await suite.test('dimensions do not imply coverage without an authored category binding', () => {
    const cabinet = { title: 'Laundry Cabinet with Sink 400 x 400mm', category: 'Cabinetry' };
    assert.equal(estimateQuantity(cabinet, { areaM2: 10 }, { pieceAreaCategories: ['Paving'] }).ok, false);
    assert.equal(estimateQuantity({ title: 'Paver 400 x 400mm', category: 'Paving' }, { areaM2: 10 }).ok, false);
  });

  await suite.test('packs for an area use a stated coverage and the coats, and never a guessed one', () => {
    const coverageWords = ['offers\\s+(\\d+(?:\\.\\d+)?)\\s*m-?sq\\s+coverage'];
    assert.equal(statedCoverage(['Primer in a 1 Litre container, offers 10 m-sq coverage'], coverageWords), 10);
    assert.equal(statedCoverage(['no coverage stated'], coverageWords), undefined);
    const fromRecord = estimateQuantity({ title: 'Primer 1 Litre Kit', texts: ['offers 10 m-sq coverage'] }, { areaM2: 25, coats: 2 }, { coveragePatterns: coverageWords });
    assert.ok(fromRecord.ok && fromRecord.basis === 'pack_coverage' && fromRecord.units === 5 && fromRecord.coverageSource === 'product_record', JSON.stringify(fromRecord));
    const fromCustomer = estimateQuantity({ title: 'Wall Paint 4L' }, { areaM2: 40, coats: 2, coveragePerPack: 36 });
    assert.ok(fromCustomer.ok && fromCustomer.units === 3 && fromCustomer.coverageSource === 'customer', JSON.stringify(fromCustomer));
    const unknown = estimateQuantity({ title: 'Wall Paint 4L', texts: ['A durable acrylic'] }, { areaM2: 40 });
    assert.deepEqual(unknown, { ok: false, missing: ['coverage_per_pack'], reason: 'no_coverage' });
    assert.deepEqual(estimateQuantity({ title: 'x' }, {}), { ok: false, missing: ['area'], reason: 'no_area' });
  });

  await suite.test('estimate_quantity answers with the number, the working and a ready add button label, and a quantity card shows only that number', async () => {
    const ctx = pavers({ quantityHelper: { allowancePercent: 10, labels: { add: 'Add', total: 'To buy' } } });
    const result: any = await executeAgentTool('estimate_quantity', { sku: 'P1', area: 10 }, ctx);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.units, 69);
    assert.equal(result.working.at(-1).value, '69 pieces');
    assert.ok(ctx.turnProductSkus.has('P1'));
    // A model that writes its own number on the card is overruled by the tool's.
    const card: any = await executeAgentTool('present_card', { cardType: 'quantity', state: { product: { sku: 'P1' }, quantity: 5, working: [{ label: 'x', value: 'y' }] } }, ctx);
    assert.equal(card.ok, true, JSON.stringify(card));
    const shown: any = ctx.presentedCards[0].state;
    assert.equal(shown.quantity, 69);
    assert.equal(shown.ctaLabel, 'Add 69');
    assert.equal(shown.working.length, result.working.length);
    // No estimate, no card.
    const none: any = await executeAgentTool('present_card', { cardType: 'quantity', state: { product: { sku: 'P2' }, quantity: 5 } }, pavers());
    assert.equal(none.ok, false);
  });

  await suite.test('estimate_quantity says what is missing instead of guessing a coverage', async () => {
    const result: any = await executeAgentTool('estimate_quantity', { sku: 'T2', area: 40 }, pavers());
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['coverage_per_pack']);
    assert.match(result.message, /no honest number yet/);
    const withCoverage: any = await executeAgentTool('estimate_quantity', { sku: 'T2', area: 40, coats: 2, coveragePerPack: 36 }, pavers());
    assert.equal(withCoverage.ok && withCoverage.units, 3);
    const board: any = await executeAgentTool('estimate_quantity', { sku: 'D1', area: 12 }, pavers());
    assert.equal(board.ok, false, 'a board sold by length has no piece area');
    const unknownSku: any = await executeAgentTool('estimate_quantity', { sku: 'NOPE', area: 12 }, pavers());
    assert.equal(unknownSku.ok, false);
  });

  await suite.test('a card may show the product the customer\'s own tap named, and only that one', async () => {
    const ctx = pavers();
    ctx.customerEvent = { type: 'viewProduct', payload: { sku: 'P1', title: 'Forum Paver' } };
    const shown: any = await executeAgentTool('present_card', { cardType: 'accessories', state: { forSku: 'P1', groups: [{ key: 'g', label: 'Goes with', items: [{ sku: 'P2' }] }] } }, ctx);
    assert.equal(shown.ok, false, 'a product nobody looked up and the tap did not name is still refused');
    assert.match(shown.error, /"P2"/);
    const named: any = await executeAgentTool('present_card', { cardType: 'products', state: { products: [{ sku: 'P1' }] } }, ctx);
    assert.equal(named.ok, true, JSON.stringify(named));
    assert.equal((ctx.presentedCards[0].state as any).products[0].title, 'Forum Paver 400 x 400 x 50mm Glacier Honed', 'its facts come from the catalogue, not the tap');
  });

  await suite.test('a product the customer has just added is not put on a recommendation card again, and looking at it is still allowed', async () => {
    const ctx = pavers();
    ctx.customerEvent = { type: 'addToCart', payload: { sku: 'P1', quantity: 63, title: 'Forum Paver' } };
    const only: any = await executeAgentTool('present_card', { cardType: 'products', state: { products: [{ sku: 'P1' }] } }, ctx);
    assert.equal(only.skipped, true, JSON.stringify(only));
    assert.match(only.message, /already in the customer's cart/);
    assert.equal(ctx.presentedCards.length, 0, 'no card was shown');
    // Looking at a product that is in the cart is still allowed: only recommendations are cleaned.
    const detail: any = await executeAgentTool('present_card', { cardType: 'productDetail', state: { product: { sku: 'P1' } } }, ctx);
    assert.equal(detail.ok, true, JSON.stringify(detail));
  });

  await suite.test('the picture prompt is built from the scene and product names, and the template is the tenant\'s', () => {
    assert.equal(buildVisualPrompt('a small patio', ['Forum Paver Glacier', 'Piazza Paver'], 'Draw {scene} with {products}.'), 'Draw a small patio with Forum Paver Glacier; Piazza Paver.');
    assert.match(buildVisualPrompt('a small patio', []), /a small patio.*the products the customer chose/);
    assert.equal(buildVisualPrompt('x'.repeat(900), []).length < 700, true, 'a long scene is cut');
  });

  await suite.test('a made picture is stored under the tenant and an unguessable id, and only read back by both', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'visuals-'));
    try {
      const png = Buffer.from('not-really-a-png');
      let seenBody: any;
      const fake = (async (_url: string, init: any) => { seenBody = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) }; }) as any;
      const made = await generateVisual({ tenantId: 'shop-a', scene: 'a patio', productTitles: ['Paver'], config: { quality: 'low' }, apiKey: 'test', storeDir: dir, fetchImpl: fake });
      assert.match(made.id, /^[a-f0-9]{32}$/);
      assert.equal(seenBody.quality, 'low');
      assert.match(seenBody.prompt, /a patio/);
      assert.deepEqual(await readVisual('shop-a', made.id, dir), png);
      assert.equal(await readVisual('shop-b', made.id, dir), null, 'another tenant cannot read it');
      assert.equal(await readVisual('shop-a', '../../etc/passwd', dir), null);
      assert.equal(await readVisual('../x', made.id, dir), null);
      assert.equal((await readdir(dir)).length, 1);
      await assert.rejects(generateVisual({ tenantId: 'Bad Tenant', scene: 'x', productTitles: [], apiKey: 'k', storeDir: dir, fetchImpl: fake }), /invalid tenant/);
      await assert.rejects(generateVisual({ tenantId: 'shop-a', scene: 'x', productTitles: [], apiKey: 'k', storeDir: dir, fetchImpl: (async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 'bad' } }) })) as any }), /refused the request \(400: bad\)/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  await suite.test('generate_visual is off unless the tenant switched it on, only features products from this turn, and its card shows only the picture made', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'visuals-'));
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
    try {
      const off: any = await executeAgentTool('generate_visual', { scene: 'a patio', skus: [] }, pavers());
      assert.equal(off.ok, false);
      assert.match(off.error, /not switched on/);
      const on = pavers({ visualiser: { disclaimer: 'An illustration, not the exact product.', model: 'test-model' } });
      on.visualStoreDir = dir;
      on.imageFetch = (async () => ({ ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }) })) as any;
      const unverified: any = await executeAgentTool('generate_visual', { scene: 'a patio', skus: ['P1'] }, on);
      assert.equal(unverified.ok, false, 'a product not looked up this turn cannot be featured');
      await executeAgentTool('get_product', { sku: 'P1' }, on);
      const made: any = await executeAgentTool('generate_visual', { scene: 'a small garden patio', skus: ['P1'] }, on);
      assert.equal(made.ok, true, JSON.stringify(made));
      const card: any = await executeAgentTool('present_card', { cardType: 'visual', state: { imageUrl: 'https://elsewhere.example/x.png', caption: 'Your patio' } }, on);
      assert.equal(card.ok, true, JSON.stringify(card));
      const shown: any = on.presentedCards[0].state;
      assert.match(shown.imageUrl, /^\/api\/visuals\/test-tenant\/[a-f0-9]{32}$/, 'a link the model wrote is replaced by the made picture');
      assert.equal(shown.disclaimer, 'An illustration, not the exact product.');
      assert.equal(shown.products[0].sku, 'P1');
      const noPicture: any = await executeAgentTool('present_card', { cardType: 'visual', state: { imageUrl: 'x' } }, pavers());
      assert.equal(noPicture.ok, false);
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
      await rm(dir, { recursive: true, force: true });
    }
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
