import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, validateBomLine, verifyQuote, toCents, PRICING } from './pricing';
import type { BOMLine } from './types';

/** A minimal valid line. Tests override just the field under examination. */
function line(over: Partial<BOMLine> = {}): Partial<BOMLine> {
  return { sku: 'SKU-1', price: 100, quantity: 1, lineTotal: 100, ...over };
}

describe('computeTotals', () => {
  test('applies discount before GST', () => {
    const t = computeTotals([line({ price: 1000, lineTotal: 1000 })], [], 1);
    assert.equal(t.subtotal, 1000);
    assert.equal(t.discount, 120);          // 12%
    assert.equal(t.gst, 88);                // 10% of 880
    assert.equal(t.total, 968);
  });

  test('multiplies price by quantity, not by the claimed lineTotal', () => {
    // The client claims a total of 1; the honest answer is price x quantity.
    const t = computeTotals([line({ price: 500, quantity: 2, lineTotal: 1 })], [], 1);
    assert.equal(t.subtotal, 1000);
  });

  test('ignores lines with a non-numeric price rather than producing NaN', () => {
    const t = computeTotals(
      [line({ price: undefined }), line({ price: 200, lineTotal: 200 })],
      [], 1,
    );
    assert.equal(t.subtotal, 200);
    assert.ok(Number.isFinite(t.total));
  });

  test('empty quote is zero, not NaN', () => {
    const t = computeTotals([], [], 1);
    assert.deepEqual(t, { subtotal: 0, discount: 0, gst: 0, total: 0 });
  });

  test('rounds to whole cents', () => {
    const t = computeTotals([line({ price: 33.33, quantity: 3, lineTotal: 99.99 })], [], 1);
    assert.equal(t.subtotal, toCents(t.subtotal));
    assert.equal(t.total, toCents(t.total));
  });
});

describe('validateBomLine', () => {
  test('accepts a well-formed line', () => {
    assert.deepEqual(validateBomLine(line()), []);
  });

  test('rejects a negative price', () => {
    const issues = validateBomLine(line({ price: -50 }));
    assert.ok(issues.some(i => i.field === 'price'));
  });

  test('rejects a fractional quantity', () => {
    const issues = validateBomLine(line({ quantity: 1.5 }));
    assert.ok(issues.some(i => i.field === 'quantity'));
  });

  test('rejects a zero quantity', () => {
    assert.ok(validateBomLine(line({ quantity: 0 })).some(i => i.field === 'quantity'));
  });

  test('catches a lineTotal that disagrees with price x quantity', () => {
    const issues = validateBomLine(line({ price: 100, quantity: 2, lineTotal: 100 }));
    assert.ok(issues.some(i => i.field === 'lineTotal'));
  });

  test('tolerates sub-cent floating point drift on lineTotal', () => {
    const issues = validateBomLine(line({ price: 0.1, quantity: 3, lineTotal: 0.30000000000000004 }));
    assert.deepEqual(issues, []);
  });

  test('rejects an absurd price', () => {
    const issues = validateBomLine(line({ price: PRICING.maxLinePrice + 1, lineTotal: PRICING.maxLinePrice + 1 }));
    assert.ok(issues.some(i => i.field === 'price'));
  });

  test('reports every problem, not just the first', () => {
    assert.ok(validateBomLine({ sku: 'X' }).length >= 2);
  });
});

describe('verifyQuote', () => {
  test('a clean quote is acceptable', () => {
    const v = verifyQuote([line()], [], 1);
    assert.equal(v.acceptable, true);
    assert.deepEqual(v.issues, []);
  });

  test('a tampered price makes the quote unacceptable', () => {
    // The scenario this whole module exists for: the shopper edits a price
    // in the browser and tries to order at the fake figure.
    const v = verifyQuote([line({ price: -9999, lineTotal: -9999 })], [], 1);
    assert.equal(v.acceptable, false);
  });

  test('still returns totals when rejecting, so the caller can log them', () => {
    const v = verifyQuote([line({ quantity: 0 })], [], 1);
    assert.equal(v.acceptable, false);
    assert.ok(Number.isFinite(v.totals.total));
  });
});
