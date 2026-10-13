import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CatalogMappingSchema } from '@journeyax/business-pack';
import {
  emptyForm, emptyPriceSource, fromMapping, toMapping, assignFieldMeaning, validateForm, LIST_FIELDS, type MappingForm,
} from '../src/components/okf/catalog-mapping-form';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const root = path.resolve(__dirname, '../../..');
const placemakers = JSON.parse(readFileSync(path.join(root, 'docs/migrations/placemakers-catalog-mapping.json'), 'utf8')).catalogMapping;
const rules = JSON.parse(readFileSync(path.join(root, 'docs/migrations/placemakers-component-category-rules.json'), 'utf8'));
const schemaAccepts = (mapping: unknown) => CatalogMappingSchema.safeParse(mapping).success;

console.log('🧪 backoffice: catalogue mapping form model');

check('the PlaceMakers mapping round-trips through the form unchanged', () => {
  const form = fromMapping(placemakers);
  assert.deepEqual(validateForm(form), {});
  assert.deepEqual(toMapping(form), placemakers);
  assert.equal(form.priceSources[0].currencyMode, 'field');
  assert.equal(form.priceSources[0].rangeKey, 'min');
});

check('parts the form does not edit are carried through, so saving never drops them', () => {
  const original = { ...placemakers, version: '2.0.0', ...(rules.catalogMapping ?? rules) };
  const mapping = toMapping(fromMapping(original))!;
  assert.deepEqual(mapping, original);
  assert.ok(mapping.componentCategoryRules || !('componentCategoryRules' in original));
});

check('an empty form means "use the platform defaults": nothing is written, and an empty mapping is null', () => {
  assert.equal(toMapping(emptyForm()), null);
  assert.equal(toMapping(fromMapping(null)), null);
  const one = emptyForm();
  one.lists.titlePaths = 'name, title';
  assert.deepEqual(toMapping(one), { titlePaths: ['name', 'title'] });
});

check('every mapping the form produces from valid input is accepted by the service\'s schema', () => {
  const form = emptyForm();
  for (const field of LIST_FIELDS) form.lists[field.key] = field.kind === 'path' ? 'a, b.c, d_e' : 'one, two';
  form.priceSources = [
    { ...emptyPriceSource(), path: 'price.amount', unit: 'major', currencyMode: 'field', currencyPath: 'price.currency' },
    { ...emptyPriceSource(), path: 'priceCents', unit: 'minor', currencyMode: 'fixed', currency: 'nzd' },
    { ...emptyPriceSource(), path: 'priceUSD', unit: 'major', currencyMode: 'none', rangeKey: 'min' },
  ];
  form.requireDeclaredCurrency = 'no';
  form.attributeAliases = [{ key: 'toeType', aliases: 'toeProtection, toe_cap' }];
  form.candidateLimit = '300';
  assert.deepEqual(validateForm(form), {});
  const mapping = toMapping(form)!;
  assert.ok(schemaAccepts(mapping), JSON.stringify(CatalogMappingSchema.safeParse(mapping)));
  assert.equal(mapping.pricing.sources[1].currency, 'NZD', 'currency codes are upper-cased');
  assert.equal(mapping.pricing.requireDeclaredCurrency, false);
  assert.deepEqual(mapping.attributeAliases, { toeType: ['toeProtection', 'toe_cap'] });
});

check('the form rejects exactly the field paths the service rejects', () => {
  const samples = ['sku', 'a.b', 'a_b.c1', '_x', 'price.amount', '1abc', 'a..b', 'a.', '.a', 'a b', '$where', 'a$b', 'a-b', 'a/b', '', 'x'.repeat(200), 'name.0', 'a.b.c.d.e'];
  for (const sample of samples.filter(Boolean)) {
    const form = emptyForm();
    form.lists.identifierPaths = sample;
    const formAccepts = !validateForm(form).identifierPaths;
    const mapping = toMapping(form);
    // The service parses the comma/newline-split list, so compare on the items the form actually produced.
    assert.equal(formAccepts, mapping ? schemaAccepts(mapping) : true, `identifier path "${sample}"`);
  }
});

check('price sources are held to the service\'s rules, with the error beside the field', () => {
  const at = (source: Partial<ReturnType<typeof emptyPriceSource>>) => {
    const form = emptyForm();
    form.priceSources = [{ ...emptyPriceSource(), ...source }];
    return form;
  };
  assert.match(validateForm(at({ path: 'price', unit: '' }))['priceSources.0.unit'], /whole currency units or in cents/);
  assert.match(validateForm(at({ path: '', unit: 'major' }))['priceSources.0.path'], /which field/);
  assert.match(validateForm(at({ path: 'price', unit: 'major', currencyMode: 'fixed', currency: 'NZ' }))['priceSources.0.currency'], /three-letter/);
  assert.match(validateForm(at({ path: 'price', unit: 'major', currencyMode: 'field', currencyPath: '' }))['priceSources.0.currencyPath'], /Name the field/);
  assert.match(validateForm(at({ path: 'price', unit: 'major', currencyMode: 'none', rangeKey: 'a b' }))['priceSources.0.rangeKey'], /letters, digits/);
  for (const bad of [{ path: 'price', unit: 'major', currencyMode: 'fixed', currency: 'NZ' }, { path: '$x', unit: 'major', currencyMode: 'none' }, { path: 'price', unit: 'major', currencyMode: 'none', rangeKey: 'a b' }] as const) {
    const form = at(bad as any);
    const mapping = toMapping(form);
    assert.ok(Object.keys(validateForm(form)).length > 0);
    if (mapping) assert.equal(schemaAccepts(mapping), false, JSON.stringify(bad));
  }
  assert.deepEqual(validateForm(at({})), {}, 'an untouched row is ignored');
});

check('candidate limit and attribute aliases are bounded and unique', () => {
  const limit = (value: string) => { const form = emptyForm(); form.candidateLimit = value; return validateForm(form).candidateLimit; };
  for (const bad of ['0', '1001', '1.5', 'abc', '-3']) assert.ok(limit(bad), bad);
  for (const good of ['1', '150', '1000']) assert.equal(limit(good), undefined, good);
  const aliases = emptyForm();
  aliases.attributeAliases = [{ key: 'a', aliases: 'x' }, { key: 'a', aliases: 'y' }, { key: '', aliases: 'z' }, { key: 'b', aliases: '' }];
  const errors = validateForm(aliases);
  assert.match(errors['attributeAliases.1.key'], /once/);
  assert.match(errors['attributeAliases.2.key'], /Name the attribute/);
  assert.match(errors['attributeAliases.3.aliases'], /List the fields/);
});

check('lifecycle words are plain values, not field names', () => {
  const form = emptyForm();
  form.lists['availability.excludedStatuses'] = 'Discontinued, on hold';
  form.lists['availability.statusPaths'] = 'on hold';
  const errors = validateForm(form);
  assert.equal(errors['availability.excludedStatuses'], undefined);
  assert.ok(errors['availability.statusPaths'], 'a status field must still be a field name');
});

check('"this field means…" puts a found field in the right place without duplicating it', () => {
  let form: MappingForm = emptyForm();
  form = assignFieldMeaning(form, 'priceUSD.min', 'price');
  form = assignFieldMeaning(form, 'priceUSD.min', 'price');
  form = assignFieldMeaning(form, 'currency', 'currency');
  form = assignFieldMeaning(form, 'name', 'title');
  form = assignFieldMeaning(form, 'name', 'title');
  form = assignFieldMeaning(form, 'categoryPath', 'categoryPath');
  form = assignFieldMeaning(form, 'status', 'status');
  assert.equal(form.priceSources.length, 1);
  assert.deepEqual(toMapping(form), {
    titlePaths: ['name'], categoryHierarchyPaths: ['categoryPath'], availability: { statusPaths: ['status'] },
    pricing: { sources: [{ path: 'priceUSD.min', unit: 'major', currencyPath: 'currency' }] },
  });
  assert.ok(schemaAccepts(toMapping(form)));
  const cents = assignFieldMeaning(emptyForm(), 'priceCents', 'priceInCents');
  assert.equal(cents.priceSources[0].unit, 'minor');
  const currencyFirst = assignFieldMeaning(emptyForm(), 'cur', 'currency');
  assert.equal(currencyFirst.priceSources[0].currencyPath, 'cur', 'a currency chosen first waits for its price');
  assert.ok(validateForm(currencyFirst)['priceSources.0.path'], 'and the form says the price is still missing');
});

console.log(`✅ backoffice catalogue mapping form: ${passed} passed, 0 failed`);
