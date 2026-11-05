import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductMeasurementEvidence, lengthEvidence } from '../src/kernel/product-measurement-evidence';
import { IncrementalSentenceShaper } from '../src/kernel/reply-shaper';

const boards = [
  { sku: 'BOARD-A', title: 'Panel 1800 x 930 x 36mm', specs: { Width: '93 CMT', Depth: '180 CMT', Height: '3.6 CMT' } },
  { sku: 'BOARD-B', title: 'Panel 1800 x 615 x 36mm', specs: { Width: '61.5 CMT', Depth: '180 CMT', Height: '3.6 CMT' } },
];
function guard() { const result = new ProductMeasurementEvidence(); result.update(boards, 'Your space is 2.4m by 1.8m. Target length 1.2m.'); return result; }

test('dimension-like source URL slugs are not measurements, but adjacent visible claims still are', () => {
  const evidence = guard(); evidence.check('SKU BOARD-A');
  const link = '[Catalogue source](https://catalogue.example/panel-2400mm-615mm/p/BOARD-B)';
  assert.equal(evidence.check(link), undefined);
  assert.equal(evidence.check(`${link} This product is 615mm deep.`), 'cross_product_measurement');
});

test('measurements bind to the explicitly named SKU instead of another product in the same turn', () => {
  const evidence = guard();
  assert.equal(evidence.check('Panel 1800 x 615 x 36mm — SKU BOARD-A'), 'cross_product_measurement');
  assert.equal(evidence.check('SKU BOARD-A is 615mm deep.'), 'cross_product_measurement');
  assert.equal(evidence.check('SKU BOARD-A is 930mm wide.'), undefined);
  assert.equal(evidence.check('SKU BOARD-B is 615mm wide.'), undefined);
  assert.equal(evidence.check('SKU BOARD-A is 1800mm wide.'), 'cross_product_measurement', 'a value from the same product cannot swap specification labels');
  evidence.check('SKU BOARD-A'); assert.equal(evidence.check('Depth (front to back): 930mm.'), 'cross_product_measurement');
  assert.equal(evidence.check('SKU BOARD-A is 930mm and SKU BOARD-B is 615mm.'), undefined);
});

test('product headings scope subsequent detail lines and a fresh general section resets attribution', () => {
  const evidence = guard(); evidence.check('**Panel — SKU BOARD-A**');
  assert.equal(evidence.check('- Depth: 615mm'), 'cross_product_measurement');
  assert.equal(evidence.check('- Width: 93cm'), undefined);
  evidence.check('## Your project', true);
  assert.equal(evidence.check('Your available width is 2.4m.'), undefined);
  assert.equal(evidence.check('You said the space is 2.4m by 1.8m.'), undefined);
});

test('cutting cannot enlarge source stock; a genuinely smaller target is allowed', () => {
  const evidence = guard(); evidence.check('SKU BOARD-A');
  assert.equal(evidence.check('Trim on site to ~2.0–2.4 m.'), 'impossible_cut');
  assert.equal(evidence.check('Cut it to 2400mm.'), 'impossible_cut');
  assert.equal(evidence.check('It cannot be trimmed to 2.4m.'), undefined, 'a truthful limitation must survive');
  assert.equal(evidence.check('You cannot trim an 1800mm panel to 2400mm.'), undefined);
  assert.equal(evidence.check('Cut it to your 1.2m target.'), undefined);
  assert.equal(evidence.check('Trim to 1200 mm.'), undefined);
  assert.equal(lengthEvidence('1800 x 930 x 36 mm').length, 3);
  assert.equal(lengthEvidence('2.4m²').length, 0, 'surface area cannot authorise a stock length');
  assert.equal(lengthEvidence('0.378 MTQ').length, 0, 'volume cannot authorise a stock length');
  assert.equal(lengthEvidence('2,400 mm')[0].mm, 2400);
  assert.equal(lengthEvidence('2,5 CMT')[0].mm, 25);
});

test('the actual failure shape is withheld before streaming even when every number exists elsewhere', () => {
  const evidence = [
    { ...boards[0], sku: '5708222', title: 'Formica Handitops 1800 x 930 x 36mm Pure Marble Velour' },
    { ...boards[1], sku: '5708209' },
  ];
  const shape = new IncrementalSentenceShaper({ style: { maxSentences: 100, maxQuestions: 5, dropListLines: false, forbiddenPhrases: [], dropCompanyName: false }, companyNames: [], internalIds: [], questionCardShown: false } as any, ['catalog_fact', 'installation_step'], true, () => {});
  shape.updateNumericEvidence(new Set(['5708222', '5708209', '1800', '930', '615', '36', '2.4', '2.0', '1.8']));
  shape.updateProductEvidence(evidence, 'My space is 2.4m by 1.8m.');
  shape.processDelta('**Formica Handitops 1800 x 615 x 36mm Pure Marble Velour – SKU 5708222**\n- Premade, 615 mm deep.\n- Trim on site to ~2.0–2.4 m.\nYour space is 2.4m by 1.8m.\n'); shape.flush();
  assert.equal(shape.getWithheldSentences().length, 3);
  assert.equal(shape.getStreamedText().includes('615'), false); assert.equal(shape.getStreamedText().includes('Trim'), false);
  assert.match(shape.getStreamedText(), /Your space is 2.4m by 1.8m/);
});
