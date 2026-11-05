import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeMeasure, metricLengthEquivalents } from '@journeyax/shared-types';
test('catalogue thousands separators are not decimal points or inferred dimensions', () => {
  assert.equal(humanizeMeasure('2,400MMT'), '2,400 mm');
  assert.deepEqual(metricLengthEquivalents('2,400MMT'), { mm: 2400, cm: 240, m: 2.4 });
  assert.deepEqual(metricLengthEquivalents('2,4MTR'), { mm: 2400, cm: 240, m: 2.4 });
  assert.equal(metricLengthEquivalents('not a dimension'), undefined);
});
