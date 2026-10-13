import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogMappingForm } from '../src/components/okf/CatalogMappingForm';
import { CoveragePanel } from '../src/components/okf/CoveragePanel';
import { DecisionPreview } from '../src/components/okf/DecisionPreview';
import { LifecyclePanel } from '../src/components/okf/LifecyclePanel';
import { MappingCheckReport } from '../src/components/okf/MappingCheckReport';
import type { KnowledgeCoverage, KnowledgeLifecycle, MappingCheck } from '../src/lib/api';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const diff = (identical: boolean, names: string[] = []) => ({
  identical, concepts: { added: [], removed: [], changed: names.map((name) => ({ conceptId: name, name })), total: names.length },
  relationships: { added: 0, removed: 0, changed: 0 }, facts: { added: [], removed: [], changed: [] }, sources: { added: 0, removed: 0 }, verifications: { added: 0, removed: 0, changed: 0 },
});
const lifecycle: KnowledgeLifecycle = {
  environmentId: 'production',
  draft: { revision: 5, valid: true, issues: 0, checksum: null, updatedAt: null, updatedBy: null, concepts: 475 },
  releases: [{ releaseId: 'r1', version: '1.0.0', checksum: 'a'.repeat(64), status: 'ready', publishedAt: null, publishedBy: null }],
  staged: { releaseId: 'r1', version: '1.0.0', checksum: 'a'.repeat(64), required: true, failurePolicy: 'fail_closed' },
  active: { packVersion: '1.0.38', publishedAt: null, publishedBy: null, currency: 'NZD', hasCatalogMapping: false, knowledge: null },
  state: { draftHasChanges: true, stagedIsLatestRelease: true, activeIsStaged: false, knowledgeRequiredByPack: null },
  changes: { draftVsStaged: diff(false, ['Vanities']), stagedVsActive: diff(false, ['Screws']) },
  nextStep: 'publish_release',
};
const coverage: KnowledgeCoverage = {
  environmentId: 'production', revision: 5, pack: { version: '1.0.38', journeyIds: ['placemakers_shop'] },
  totals: { concepts: 475, relationships: 480, sources: 520, evidenceChunks: 0, verifications: 0, facts: 99 },
  layers: { derived: 457, authored: 18, manual: 0 }, lenses: { product: 450 },
  departments: [
    { name: 'Bathrooms & Plumbing', concepts: 17, authoredConcepts: 3, conceptsWithCandidateSources: 12, products: 15256, productsCovered: 15256 },
    { name: 'Other products', concepts: 14, authoredConcepts: 0, conceptsWithCandidateSources: 0, products: 395, productsCovered: 14 },
  ],
  authored: { families: [{ conceptId: 'f', name: 'Screws' }], projects: [{ conceptId: 'p', name: 'Deck build' }], problems: [], care: [], other: [] },
  journeys: [{ journeyId: 'placemakers_plan_your_space', existsInPack: false, concepts: [{ conceptId: 'b', name: 'Bathroom renovation' }] }, { journeyId: 'placemakers_shop', existsInPack: true, concepts: [] }],
  projectsWithoutJourney: [{ conceptId: 'p', name: 'Deck build' }],
  verification: {
    verifiedClaims: 0, unverifiedClaims: 3, byClaimClass: { care_safety: { verified: 0, unverified: 3 } }, conceptsWithCandidateSources: 149, candidateSources: 514, stale: 400,
    guidanceGaps: [{ conceptId: 'g', name: 'Gas hazard', kind: 'problem', reason: 'No first-response guidance has been written.' }],
  },
  catalogue: { products: 42436, covered: 42055, uncovered: 381, uncoveredCategories: [{ path: [], products: 381 }] },
};
const live = { products: 2, sample: [{ sku: '1000101', title: 'Vanity unit 750mm', category: 'Vanities', priceCents: 49900, currency: 'NZD', inStock: true }] };

console.log('🧪 backoffice: knowledge insight components render');

check('lifecycle shows the four places, the next step and the named differences', () => {
  const html = renderToStaticMarkup(<LifecyclePanel lifecycle={lifecycle} />);
  for (const step of ['draft', 'release', 'staged', 'active']) assert.match(html, new RegExp(`data-step="${step}"`));
  assert.match(html, /data-step="active" data-state="current"/);
  assert.match(html, /Publish an immutable release/);
  assert.match(html, /The draft differs from the staged release: changed Vanities/);
  assert.match(html, /The staged release differs from what is live: changed Screws/);
  assert.match(html, /carries no business knowledge/, 'a live pack without knowledge is called out');
  assert.match(renderToStaticMarkup(<LifecyclePanel lifecycle={null} />), /once the service has loaded it/);
});

check('coverage shows department figures with accessible bars, the unreachable products, journeys and unverified guidance', () => {
  const html = renderToStaticMarkup(<CoveragePanel coverage={coverage} />);
  assert.match(html, /42,055 of 42,436 listed products \(99%\)/);
  assert.match(html, /aria-label="100% of Bathrooms &amp; Plumbing products covered"/);
  assert.match(html, /aria-label="4% of Other products products covered"/);
  assert.match(html, /381 listed products are outside every concept&#x27;s scope|381 listed products are outside every concept's scope/);
  assert.match(html, /No department and no category — 381/);
  assert.match(html, /placemakers_plan_your_space/);
  assert.match(html, /missing from the live pack/);
  assert.match(html, /in the live pack/);
  assert.match(html, /Answered by the knowledge alone \(no journey\): Deck build/);
  assert.match(html, /care safety/);
  assert.match(html, /0 unverified|0 verified · 3 unverified/);
  assert.match(html, /Gas hazard \(problem\)/);
  assert.match(html, /0 verified claims/);
  assert.match(renderToStaticMarkup(<CoveragePanel coverage={null} />), /once a draft exists/);
});

check('coverage without a catalogue says so instead of inventing percentages', () => {
  const html = renderToStaticMarkup(<CoveragePanel coverage={{ ...coverage, catalogue: undefined, departments: [{ name: 'Tools', concepts: 3, authoredConcepts: 0, conceptsWithCandidateSources: 0 }] }} />);
  assert.match(html, /Catalogue figures are not available/);
  assert.doesNotMatch(html, /% of Tools/);
});

check('the decision preview explains a product answer: question, live products, cross-sell, basket, claims', () => {
  const preview = {
    previewable: true, revision: 5, conceptName: 'Vanities',
    decision: {
      mode: 'direct_results', retrieval: { permission: 'allowed' }, commerce: { addToCart: 'allowed', checkout: 'requires_professional_confirmation' },
      claims: { allowedClasses: ['catalog_fact'], disclaimers: ['Compatibility must be verified before checkout.'] },
      clarification: { factKey: 'room', question: 'Which room?', options: [{ value: 'bath', label: 'Bathroom' }] },
      suggestions: [{ note: 'These are suggestions only.' }], trace: { matchedBy: 'phrase', reasonCodes: ['required_facts_known'] },
    },
    live: { scope: live, groups: [], suggestions: [{ conceptId: 's', name: 'Mirrors', label: 'Have you considered?', ...live, products: 1 }] },
  };
  const html = renderToStaticMarkup(<DecisionPreview preview={preview} onAnswer={() => undefined} />);
  assert.match(html, /Vanities/);
  assert.match(html, /Shows matching products straight away/);
  assert.match(html, /Which room\?/);
  assert.match(html, /<button[^>]*>Bathroom<\/button>/, 'options are buttons that re-run the preview');
  assert.match(html, /<b>2<\/b> listed product/);
  assert.match(html, /Vanity unit 750mm/);
  assert.match(html, /NZ\$|NZD/);
  assert.match(html, /Have you considered\?/);
  assert.match(html, /Mirrors/);
  assert.match(html, /These are suggestions only/);
  assert.match(html, /Checkout needs a qualified professional to confirm/);
  assert.match(html, /Compatibility must be verified before checkout/);
  assert.doesNotMatch(renderToStaticMarkup(<DecisionPreview preview={preview} />), /<button/, 'without a handler the options are plain labels');
});

check('the decision preview for a problem shows paused products and a referral, and no product sections', () => {
  const html = renderToStaticMarkup(<DecisionPreview preview={{
    previewable: true, revision: 5, conceptName: 'Gas hazard',
    decision: { mode: 'safety_then_diagnose', retrieval: { permission: 'blocked' }, commerce: { addToCart: 'blocked', checkout: 'blocked' }, safety: { blocksProducts: true, guidanceUnavailable: true }, claims: { allowedClasses: [], disclaimers: [] }, trace: { reasonCodes: ['safety_or_problem'] } },
    live: { scope: null, groups: [], suggestions: [] },
  }} />);
  assert.match(html, /Products and checkout are paused; no verified guidance exists, so the customer is referred to a qualified professional/);
  assert.match(html, /No products would be retrieved/);
  assert.match(html, /Add to cart blocked/);
  assert.match(html, /Nothing beyond what the catalogue lists/);
  assert.doesNotMatch(html, /Products it would draw from/);
  assert.match(renderToStaticMarkup(<DecisionPreview preview={{ previewable: false }} />), /must validate/);
  assert.equal(renderToStaticMarkup(<DecisionPreview preview={null} />), '');
});

const mappingCheck: MappingCheck = {
  ok: false, mappingErrors: [], sampleSize: 200, catalogueProducts: 42436,
  readable: { identifier: 1, title: 1, description: 0.9, brand: 0.5, category: 1, categoryPath: 0.99, price: 0.4, currency: 0, stock: 0.2, image: 1 },
  currencies: {}, availability: { available: 190, excluded: 10, unpriced: 0 }, fields: [{ path: 'priceUSD.min', type: 'number', seen: 0.98, example: '12.5' }, { path: 'currency', type: 'string', seen: 1, example: 'NZD' }],
  statuses: [{ value: 'Clearance', count: 4, treatedAs: 'available' }], unusedPaths: [{ field: 'identifierPaths', path: 'partNumber' }],
  issues: [
    { severity: 'info', code: 'status_values', field: 'availability', message: 'Lifecycle values in use…', affected: 0, share: 0, examples: [] },
    { severity: 'error', code: 'currency_undeclared', field: 'pricing.sources', message: '120 of 190 products have a price but no declared currency.', affected: 120, share: 0.63, examples: ['1000001', '1000002'] },
  ],
  rows: [{ sku: '1000001', title: 'Vanity', category: 'Vanities', categoryPath: ['Bathrooms & Plumbing', 'Vanities'], priceCents: null, currencyUndeclared: true, availability: 'available' }],
};

check('the check report leads with the verdict, puts errors first and shows products as they would be read', () => {
  const html = renderToStaticMarkup(<MappingCheckReport check={mappingCheck} stale={false} />);
  assert.match(html, /Checked 200 of 42,436 products/);
  assert.match(html, /1 problem to fix/);
  assert.ok(html.indexOf('data-severity="error"') < html.indexOf('data-severity="info"'), 'errors come first');
  assert.match(html, /120 products \(63% of the sample\), e\.g\. 1000001, 1000002/);
  assert.match(html, /Change: pricing\.sources/);
  assert.match(html, /data-readable="price"[^>]*>[\s\S]*?40%/);
  assert.match(html, /Price found, currency not declared/);
  assert.match(html, /Bathrooms &amp; Plumbing › Vanities/);
  assert.match(html, /Clearance/);
  assert.match(html, /1 configured field found on no sampled product/);
  assert.match(renderToStaticMarkup(<MappingCheckReport check={mappingCheck} stale />), /Out of date — check again/);
  assert.match(renderToStaticMarkup(<MappingCheckReport check={{ ...mappingCheck, ok: true, issues: [] }} stale={false} />), /Safe to save/);
});

check('an invalid mapping is reported as an alert and checks nothing', () => {
  const html = renderToStaticMarkup(<MappingCheckReport check={{ ...mappingCheck, ok: false, sampleSize: 0, mappingErrors: ['searchPaths.0: invalid field path'], issues: [], rows: [], readable: { ...mappingCheck.readable } }} stale={false} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /searchPaths\.0: invalid field path/);
});

const defaults = { identifierPaths: ['parentSku', 'sku', 'id'], titlePaths: ['name', 'title'], candidateLimit: 150, pricing: { sources: [{ path: 'priceCents' }] } };

check('the mapping form lists every group, shows platform defaults as placeholders, and cannot save before a check', () => {
  const html = renderToStaticMarkup(<CatalogMappingForm project={{ projectId: 'p', catalogMapping: { titlePaths: ['name'] } }} initial={{ defaults, mapping: { titlePaths: ['name', 'label'] } }} />);
  for (const title of ['Product identity and text', 'Categories', 'Price and currency', 'Stock', 'Product lifecycle', 'Attributes and media', 'Advanced']) assert.match(html, new RegExp(title));
  assert.match(html, /placeholder="Platform default: parentSku, sku, id"/);
  assert.match(html, /placeholder="Platform default: 150"/);
  assert.match(html, /value="name, label"/);
  assert.match(html, /Check the mapping against your catalogue to enable saving/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?Save mapping/);
  assert.match(html, /Check against my catalogue/);
  assert.match(html, /Use platform defaults/);
  assert.match(html, /Advanced: edit as JSON/);
  assert.match(renderToStaticMarkup(<CatalogMappingForm project={{ projectId: 'p', catalogMapping: { titlePaths: ['name'] } }} initial={{ defaults }} />), /No changes to save/);
});

check('mistakes are flagged beside the field, with the control marked invalid, before anything is sent', () => {
  const html = renderToStaticMarkup(<CatalogMappingForm
    project={{ projectId: 'p', catalogMapping: { identifierPaths: ['not a field'], pricing: { sources: [{ path: 'price', unit: 'major' }] }, candidateLimit: 5000 } as any }} initial={{ defaults }} />);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /role="alert"[^>]*>Not a field name: not a field/);
  assert.match(html, /A whole number from 1 to 1000/);
  assert.match(html, /Without a declared currency these prices are never quoted/, 'a price source with no currency says what that means');
  assert.match(html, /Fix the highlighted fields first/);
});

check('after a passing check of the current mapping, the found fields are offered and saving is explained', () => {
  const mapping = { titlePaths: ['name'] };
  const html = renderToStaticMarkup(<CatalogMappingForm project={{ projectId: 'p', catalogMapping: undefined }} initial={{ defaults, mapping, check: { ...mappingCheck, ok: true, issues: [] } }} />);
  assert.match(html, /Fields found on your products \(2\)/);
  assert.match(html, /priceUSD\.min/);
  assert.match(html, /aria-label="What priceUSD\.min means"/);
  assert.match(html, /Price \(whole units\)/);
  assert.match(html, /Safe to save/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?Save mapping/, 'a current, passing check of a changed mapping enables Save');
  const failing = renderToStaticMarkup(<CatalogMappingForm project={{ projectId: 'p', catalogMapping: undefined }} initial={{ defaults, mapping, check: mappingCheck }} />);
  assert.match(failing, /Fix the problems in the check before saving/);
  assert.match(failing, /<button[^>]*disabled=""[^>]*>[\s\S]*?Save mapping/);
});

console.log(`✅ backoffice knowledge insight components: ${passed} passed, 0 failed`);
