import type { Collections } from './engine';
import type { Rec } from './types';

/**
 * A tool's `example` arguments may point at a record instead of naming one: `"$first:products.sku"` is the `sku` of the first record of
 * `products`, `"$nth:3:products.sku"` the third, and `"$firstWith:orders.accountId"` the first that has one. The tests and the README call every tool with them, so they never go stale when the
 * seeds are rebuilt.
 */
export function resolveExample(example: Rec, data: Collections): Rec {
  const out: Rec = {};
  for (const [name, value] of Object.entries(example)) {
    if (typeof value === 'string' && value.startsWith('$')) {
      const match = /^\$(first|firstWith|nth:(\d+)):([a-z_]+)\.([A-Za-z_]+)$/.exec(value);
      if (!match) throw new Error(`Unreadable example placeholder '${value}'`);
      const rows = data.all(match[3]);
      const index = match[2] ? Number(match[2]) - 1 : 0;
      const record = match[1] === 'firstWith' ? rows.find((row) => row[match[4]] !== null && row[match[4]] !== undefined) : rows[index];
      if (!record) throw new Error(`Example '${value}': no record ${index + 1} in ${match[3]}`);
      out[name] = record[match[4]];
    } else {
      out[name] = value;
    }
  }
  return out;
}
