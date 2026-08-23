import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordReturn, returnsFor, hydrate, fitReasonFor, isSizeBearing, __clearReturns } from './return-store';
import type { Wearer } from '@/lib/fit-types';

const wearer: Wearer = { id: 'w1', name: 'Sam', size: 'M' };

describe('fitReasonFor', () => {
  test('keeps the two size-bearing reasons', () => {
    assert.equal(fitReasonFor('too-small'), 'too-small');
    assert.equal(fitReasonFor('too-large'), 'too-large');
  });

  test('collapses reasons that say nothing about size', () => {
    // "wrong colour" must never nudge somebody's size.
    assert.equal(fitReasonFor('style'), 'other');
    assert.equal(fitReasonFor('quality'), 'other');
    assert.equal(fitReasonFor('other'), 'other');
  });
});

describe('isSizeBearing', () => {
  test('only fit reasons will move a future recommendation', () => {
    assert.equal(isSizeBearing('too-small'), true);
    assert.equal(isSizeBearing('too-large'), true);
    assert.equal(isSizeBearing('style'), false);
  });
});

describe('recordReturn', () => {
  beforeEach(() => __clearReturns());

  test('writes a return that can be read back', () => {
    const res = recordReturn('w1', 'M', 'too-small');
    assert.equal(res.recorded, true);
    assert.equal(res.sizeBearing, true);
    assert.equal(returnsFor('w1').length, 1);
    assert.equal(returnsFor('w1')[0].size, 'M');
  });

  test('records a non-size reason but flags it as not size-bearing', () => {
    const res = recordReturn('w1', 'M', 'quality');
    assert.equal(res.recorded, true);
    assert.equal(res.sizeBearing, false, 'must not claim to have learned a size');
  });

  test('refuses to record without a wearer or size', () => {
    assert.equal(recordReturn('', 'M', 'too-small').recorded, false);
    assert.equal(recordReturn('w1', '', 'too-small').recorded, false);
    assert.equal(returnsFor('w1').length, 0);
  });

  test('keeps returns for different wearers apart', () => {
    recordReturn('w1', 'M', 'too-small');
    recordReturn('w2', 'L', 'too-large');
    assert.equal(returnsFor('w1').length, 1);
    assert.equal(returnsFor('w2')[0].reason, 'too-large');
  });
});

describe('hydrate', () => {
  beforeEach(() => __clearReturns());

  test('returns the wearer untouched when nothing was recorded', () => {
    assert.equal(hydrate(wearer), wearer);
  });

  test('merges recorded returns onto the wearer', () => {
    recordReturn('w1', 'M', 'too-small');
    const h = hydrate(wearer);
    assert.equal(h.returns?.length, 1);
    assert.equal(h.returns?.[0].reason, 'too-small');
  });

  test('keeps returns the wearer already carried', () => {
    // Seeded or imported history must survive hydration.
    const seeded: Wearer = { ...wearer, returns: [{ at: '2024-01-01', size: 'S', reason: 'too-large' }] };
    recordReturn('w1', 'M', 'too-small');
    const h = hydrate(seeded);
    assert.equal(h.returns?.length, 2);
  });

  test('does not duplicate a return already present on the wearer', () => {
    const at = '2024-05-05T00:00:00.000Z';
    recordReturn('w1', 'M', 'too-small', at);
    const seeded: Wearer = { ...wearer, returns: [{ at, size: 'M', reason: 'too-small' }] };
    assert.equal(hydrate(seeded).returns?.length, 1);
  });

  test('does not mutate the wearer it was given', () => {
    recordReturn('w1', 'M', 'too-small');
    hydrate(wearer);
    assert.equal(wearer.returns, undefined);
  });
});
