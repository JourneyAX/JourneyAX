/**
 * Option-space derivation tests (AUG-41).
 *
 * These assert what a customer is OFFERED. A wrong answer here is not cosmetic:
 * offering a discontinued size books an order that fails at fulfilment, and
 * filing a sublimated pattern under "Color" makes the agent offer "Swish" as a
 * colour and then fail to find it in the palette. Run with:
 *   npx tsx apps/journeyax-web/src/services/knowledge/__tests__/option-space-derive.test.ts
 */
import { deriveOptionSpace, sortSizes, colourKeyFor } from '../option-space-derive';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`✗ ${name}`); }
  else console.log(`✓ ${name}`);
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const v = (color: string, size: string, extra: Record<string, unknown> = {}) => ({ color, size, ...extra });
const values = (d: ReturnType<typeof deriveOptionSpace>, k: string) =>
  (d?.defining[k] || []).map((x) => x.value);

// ── Nothing to derive is reported as nothing, not as an empty offer ─────
check('undefined variants derive nothing', deriveOptionSpace(undefined) === null);
check('no variant rows derive nothing', deriveOptionSpace([]) === null);
check('rows with neither colour nor size derive nothing',
  deriveOptionSpace([{ itemSku: 'X' }]) === null);

// ── The choices are the distinct values across buyable rows ─────────────
const basic = deriveOptionSpace([v('NAVY', 'S'), v('NAVY', 'M'), v('WHITE', 'S')]);
check('distinct colours collected', eq(values(basic, 'Color'), ['NAVY', 'WHITE']));
check('distinct sizes collected', eq(values(basic, 'Available Sizes'), ['S', 'M']));
check('row count reported for audit', basic?.derivedFrom === 3);

// ── A sublimated "colour" is a design line, and must be labelled as one ──
const sub = deriveOptionSpace([v('SERPENTINE', 'L'), v('SWISH', 'L')], { isSublimation: true });
check('sublimated patterns filed as Design Line', eq(values(sub, 'Design Line'), ['SERPENTINE', 'SWISH']));
check('sublimated patterns NOT filed as Color', sub?.defining['Color'] === undefined);

// ── Sizes read in garment order, not the feed's alphabetical order ──────
const sized = deriveOptionSpace([v('NAVY', '2XL'), v('NAVY', 'S'), v('NAVY', 'XL'), v('NAVY', 'M'), v('NAVY', 'L')]);
check('sizes ordered S→3XL, not 2XL,3XL,L,M,S,XL',
  eq(values(sized, 'Available Sizes'), ['S', 'M', 'L', 'XL', '2XL']));
check('youth sizes sort ahead of adult', eq(sortSizes(['L', 'YM', 'S', 'YL']), ['YM', 'YL', 'S', 'L']));
check('numeric sizes sort numerically', eq(sortSizes(['32', '8', '10']), ['8', '10', '32']));
check('unrecognised size tokens are kept, not dropped', sortSizes(['ONE SIZE', 'S', 'TALL']).length === 3);

// ── A size that cannot be bought is never offered ───────────────────────
const disc = deriveOptionSpace([v('NAVY', 'S'), v('NAVY', 'XL', { status: 'Discontinued' })]);
check('discontinued rows excluded', eq(values(disc, 'Available Sizes'), ['S']));
const noStatus = deriveOptionSpace([v('NAVY', 'S'), v('NAVY', 'XL', { status: '' })]);
check('absent status is not discontinuation', values(noStatus, 'Available Sizes').length === 2);
const allDisc = deriveOptionSpace([v('NAVY', 'S', { status: 'Discontinued' })]);
check('all-discontinued falls back to describing the style',
  eq(values(allDisc, 'Available Sizes'), ['S']));

// ── Presentation details that reach the customer ────────────────────────
const dup = deriveOptionSpace([v('Navy', 'S'), v('NAVY', 'M')]);
check('case-insensitive de-dupe keeps the feed spelling', eq(values(dup, 'Color'), ['Navy']));
const img = deriveOptionSpace([v('NAVY', 'S', { mainImage: 'https://x/navy.jpg' })]);
check('variant image carried for the picker',
  img?.defining['Color'][0].swatchImage === 'https://x/navy.jpg');
check('unknown sublimation flag defaults to a plain colour', colourKeyFor(undefined) === 'Color');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
