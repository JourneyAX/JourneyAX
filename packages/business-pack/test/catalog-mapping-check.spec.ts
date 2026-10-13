import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildCategoryScopeClauses, categoryScopeMatches, checkCatalogMapping, cleanCategoryPaths, pathCovers, resolveCatalogMapping } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Catalogue mapping check and shared category scope');
const root = path.resolve(__dirname, '../../..');
const placemakers = JSON.parse(readFileSync(path.join(root, 'docs/migrations/placemakers-catalog-mapping.json'), 'utf8')).catalogMapping;

// Shaped like the real products collection: price in priceUSD.min with the currency declared per product, a category
// hierarchy in categoryPath and the lifecycle in status.
const product = (sku: string, over: Record<string, unknown> = {}) => ({
  projectId: 'placemakers', sku, name: `Product ${sku}`, category: 'Vanities', categoryPath: ['Bathrooms & Plumbing', 'Bathrooms & Accessories', 'Vanities'],
  priceUSD: { min: 100 }, currency: 'NZD', inStock: true, brand: 'Acme', description: 'A product', images: ['https://example.invalid/a.png'], ...over,
});
const catalogue = [
  product('1000001'), product('1000002'), product('1000003', { inStock: undefined }), product('1000004', { status: 'Clearance' }), product('1000005', { status: 'Discontinued' }),
];

check('the PlaceMakers mapping reads every meaning from representative products and is safe to save', () => {
  const result = checkCatalogMapping(placemakers, catalogue);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.sampleSize, 5);
  assert.deepEqual(result.currencies, { NZD: 4 }, 'a discontinued product is not priced into the totals');
  assert.equal(result.readable.identifier, 1);
  assert.equal(result.readable.title, 1);
  assert.equal(result.readable.categoryPath, 1);
  assert.equal(result.availability.excluded, 1);
  assert.ok(result.readable.price >= 0.8);
  assert.ok(result.rows[0].sku === '1000001' && result.rows[0].priceCents === 10000 && result.rows[0].currency === 'NZD');
  assert.deepEqual(result.rows[0].categoryPath, ['Bathrooms & Plumbing', 'Bathrooms & Accessories', 'Vanities']);
});

check('the platform default mapping cannot read this catalogue\'s prices, and says so as an error', () => {
  const result = checkCatalogMapping({}, catalogue);
  assert.equal(result.ok, false);
  const issue = result.issues.find((entry) => entry.code === 'price_unreadable');
  assert.ok(issue && issue.severity === 'error' && issue.field === 'pricing.sources');
  assert.ok(issue.examples.length > 0);
});

check('a price with no declared currency is an error once most of the sample is affected, a warning before', () => {
  const noCurrency = (count: number) => [...Array(count)].map((_, index) => product(`2${index}`, { currency: undefined })).concat([...Array(5 - count)].map((_, index) => product(`3${index}`)));
  const few = checkCatalogMapping(placemakers, noCurrency(1));
  assert.equal(few.issues.find((entry) => entry.code === 'currency_undeclared')?.severity, 'warning');
  assert.equal(few.ok, true);
  const most = checkCatalogMapping(placemakers, noCurrency(4));
  assert.equal(most.issues.find((entry) => entry.code === 'currency_undeclared')?.severity, 'error');
  assert.equal(most.ok, false);
  // The fix is a declared currency: stating the feed's currency makes the same products readable.
  const fixed = checkCatalogMapping({ pricing: { sources: [{ path: 'priceUSD', rangeKey: 'min', unit: 'major', currency: 'NZD' }] } }, noCurrency(4));
  assert.equal(fixed.issues.some((entry) => entry.code === 'currency_undeclared'), false);
  assert.deepEqual(fixed.currencies, { NZD: 5 });
});

check('mixed currencies are reported, not converted', () => {
  const result = checkCatalogMapping(placemakers, [product('1'), product('2', { currency: 'USD' })]);
  const issue = result.issues.find((entry) => entry.code === 'mixed_currencies');
  assert.ok(issue && /NZD 1, USD 1|USD 1, NZD 1/.test(issue.message));
});

check('lifecycle values in use are listed with how the mapping treats each', () => {
  const result = checkCatalogMapping(placemakers, catalogue);
  assert.deepEqual(result.statuses.map((entry) => [entry.value, entry.treatedAs]).sort(), [['Clearance', 'available'], ['Discontinued', 'excluded']]);
  assert.match(result.issues.find((entry) => entry.code === 'status_values')?.message || '', /Clearance/);
  const classified = checkCatalogMapping({ ...placemakers, availability: { excludedStatuses: ['discontinued', 'clearance'] } }, catalogue);
  assert.equal(classified.availability.excluded, 2);
  assert.equal(classified.issues.some((entry) => entry.code === 'status_values'), false);
});

check('missing identifiers, titles, stock and hierarchy are called out with examples', () => {
  const sample = [product('1', { sku: undefined, _id: 'oid-1' }), product('2', { name: undefined, categoryPath: undefined, inStock: undefined })];
  const result = checkCatalogMapping(placemakers, sample);
  const byCode = Object.fromEntries(result.issues.map((entry) => [entry.code, entry]));
  assert.equal(byCode.identifier_unreadable.affected, 1);
  assert.deepEqual(byCode.identifier_unreadable.examples, ['oid-1']);
  assert.equal(byCode.title_unreadable.affected, 1);
  assert.equal(byCode.hierarchy_partial.severity, 'info');
  assert.equal(byCode.stock_unreadable, undefined, 'stock is readable on one of the two');
  assert.equal(checkCatalogMapping(placemakers, [product('1', { inStock: undefined }), product('2', { inStock: undefined })]).issues.find((entry) => entry.code === 'stock_unreadable')?.severity, 'warning');
  const none = checkCatalogMapping(placemakers, [product('9', { categoryPath: undefined })]);
  assert.equal(none.issues.find((entry) => entry.code === 'hierarchy_unreadable')?.severity, 'warning');
});

check('configured paths that read nothing are listed', () => {
  const result = checkCatalogMapping({ ...placemakers, identifierPaths: ['sku', 'partNumber'] }, catalogue);
  assert.ok(result.unusedPaths.some((entry) => entry.field === 'identifierPaths' && entry.path === 'partNumber'));
  assert.ok(!result.unusedPaths.some((entry) => entry.field === 'identifierPaths' && entry.path === 'sku'));
});

check('an invalid mapping reports each problem and checks nothing', () => {
  const result = checkCatalogMapping({ searchPaths: ['$where'], surprise: true }, catalogue);
  assert.equal(result.ok, false);
  assert.ok(result.mappingErrors.length >= 1);
  assert.equal(result.sampleSize, 0);
  assert.ok(result.issues.every((entry) => entry.code === 'mapping_invalid'));
});

check('an empty catalogue is a warning, never a pass-through error', () => {
  const result = checkCatalogMapping(placemakers, []);
  assert.equal(result.ok, true);
  assert.equal(result.issues[0].code, 'empty_sample');
});

check('the check never mutates the products it is given', () => {
  const copy = structuredClone(catalogue);
  checkCatalogMapping(placemakers, catalogue);
  assert.deepEqual(catalogue, copy);
});

check('category scope: paths match exactly by prefix, names by substring, exclusions always win', () => {
  const mapping = resolveCatalogMapping();
  const vanity = product('1');
  const stray = { projectId: 'placemakers', sku: '2', category: 'Plumbing', categoryPath: ['Outdoor', 'Plumbing'] };
  assert.equal(pathCovers(['Bathrooms & Plumbing'], vanity.categoryPath), true);
  assert.equal(pathCovers(['Plumbing'], vanity.categoryPath), false, 'positional, not anywhere');
  assert.equal(categoryScopeMatches(mapping, { categoryPaths: [['Bathrooms & Plumbing', 'Bathrooms & Accessories']] }, vanity), true);
  assert.equal(categoryScopeMatches(mapping, { categoryPaths: [['Bathrooms & Plumbing', 'Plumbing']] }, stray), false);
  assert.equal(categoryScopeMatches(mapping, { categoryIds: ['plumbing'] }, stray), true, 'a name still matches wherever it appears');
  assert.equal(categoryScopeMatches(mapping, { categoryIds: ['plumbing'], excludeCategoryIds: ['outdoor'] }, stray), false);
  assert.equal(categoryScopeMatches(mapping, {}, stray), true, 'no scope selects everything');
  assert.deepEqual(cleanCategoryPaths([['a'], [], [''], [1], 'x', ['  b  ']]), [['a'], ['b']]);
});

check('category scope clauses are literal and anchored per segment', () => {
  const mapping = resolveCatalogMapping();
  const clauses = buildCategoryScopeClauses(mapping, { categoryPaths: [['Dept (A+B)', 'Misc.']], excludeCategoryIds: ['x.y'] });
  assert.equal(clauses.length, 2);
  const [scope] = clauses as any[];
  const anchored = scope.$or.find((clause: any) => 'categoryPath.1' in clause);
  assert.equal(anchored['categoryPath.0'].source, '^Dept \\(A\\+B\\)$');
  assert.equal(anchored['categoryPath.1'].source, '^Misc\\.$');
  assert.equal(buildCategoryScopeClauses(mapping, {}).length, 0);
});

console.log(`✅ Catalogue mapping check: ${passed} passed, 0 failed`);
