import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import {
  ConceptSchema, buildServerOwnedOkfContent, categoryPathCovers, computeKnowledgeEntityHash, mergeSearchScopes, resolveOkfBasketCommerce,
  resolveOkfGate, scopeSelectsProduct, validateOkfDraftContent,
} from '../src';
import { buildOkfContent } from './fixtures';

const suite = createSuite('knowledge: hierarchy-scoped category selection');
const TENANT = 'placemakers';
const id = (path: string) => `concept://${TENANT}/${path}`;

function concept(overrides: Record<string, any>): any {
  const value: any = {
    tenantId: TENANT, type: 'product_category', description: 'Test concept', synonyms: [], customerPhrases: [], lens: 'product', riskClass: 'standard',
    compatibilitySensitive: false, requiredFacts: [], discriminators: [],
    searchScope: { catalogCategoryIds: [], enrichmentFacets: [], excludeCategoryIds: [] },
    commercePolicy: { addToCart: 'allowed', checkout: 'allowed' }, safety: { blocksProducts: false, stepRefs: [] },
    evidenceRefs: [], lifecycle: { status: 'active_draft' }, version: 1, ...overrides,
  };
  value.contentHash = computeKnowledgeEntityHash(value);
  return value;
}

// Two departments that both have a category called "Plumbing" (the real catalogue has exactly this collision).
const bathroomPlumbing = ['Bathrooms & Plumbing', 'Plumbing'];
const toolPlumbing = ['Tools', 'Power Tools', 'Plumbing'];
function content() {
  const base = buildOkfContent();
  return {
    ...base,
    concepts: [
      concept({
        conceptId: id('bathrooms/plumbing'), name: 'Plumbing (Bathrooms)', description: 'Pipes and fittings',
        customerPhrases: ['plumbing supplies'], searchScope: { catalogCategoryIds: [], catalogCategoryPaths: [bathroomPlumbing], enrichmentFacets: [], excludeCategoryIds: [] },
      }),
      concept({
        conceptId: id('tools/plumbing'), name: 'Plumbing (Tools)', description: 'Plumbing power tools',
        commercePolicy: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' },
        searchScope: { catalogCategoryIds: [], catalogCategoryPaths: [toolPlumbing], enrichmentFacets: [], excludeCategoryIds: [] },
      }),
      concept({
        conceptId: id('legacy/vanities'), name: 'Vanities', description: 'Name scoped', customerPhrases: ['vanities'],
        searchScope: { catalogCategoryIds: ['Vanities'], enrichmentFacets: [], excludeCategoryIds: [] },
      }),
    ],
    relationships: [], verifications: [], evidenceChunks: [], sources: [],
  } as any;
}

async function main() {
  await suite.test('a path covers exactly its own subtree, compared exactly and case-insensitively', () => {
    assert.equal(categoryPathCovers(['Tools'], ['tools', 'Power Tools', 'Plumbing']), true, 'a department covers everything below it');
    assert.equal(categoryPathCovers(toolPlumbing, ['TOOLS', ' Power Tools ', 'plumbing']), true);
    assert.equal(categoryPathCovers(toolPlumbing, ['Tools', 'Power Tools']), false, 'a shorter product path is not covered');
    assert.equal(categoryPathCovers(['Tools', 'Plumbing'], ['Tools', 'Power Tools', 'Plumbing']), false, 'segments are positional, not "anywhere"');
    assert.equal(categoryPathCovers(['Plumb'], ['Plumbing']), false, 'no substring matching');
    assert.equal(categoryPathCovers([], ['Tools']), false, 'an empty scope covers nothing rather than everything');
  });

  await suite.test('the same leaf name in two departments never selects the other department\'s products', () => {
    const bathroom = { categoryPath: ['Bathrooms & Plumbing', 'Plumbing', 'Pipes'] };
    const tools = { categoryPath: ['Tools', 'Power Tools', 'Plumbing'] };
    const bathScope = { catalogCategoryIds: [], catalogCategoryPaths: [bathroomPlumbing] };
    const toolScope = { catalogCategoryIds: [], catalogCategoryPaths: [toolPlumbing] };
    assert.equal(scopeSelectsProduct(bathScope, bathroom), true);
    assert.equal(scopeSelectsProduct(bathScope, tools), false);
    assert.equal(scopeSelectsProduct(toolScope, tools), true);
    assert.equal(scopeSelectsProduct(toolScope, bathroom), false);
    // The legacy name scope still behaves as before (matches the id or any path segment) — the collision the paths remove.
    assert.equal(scopeSelectsProduct({ catalogCategoryIds: ['Plumbing'] }, tools), true);
    assert.equal(scopeSelectsProduct({ catalogCategoryIds: ['Plumbing'] }, bathroom), true);
  });

  await suite.test('scopes union without duplicates and keep paths as paths', () => {
    const merged = mergeSearchScopes([
      { catalogCategoryIds: ['A'], catalogCategoryPaths: [['X', 'Y']] },
      { catalogCategoryIds: ['A', 'B'], catalogCategoryPaths: [['x', 'y'], ['Z']] },
      { catalogCategoryIds: [] },
    ]);
    assert.deepEqual(merged.categoryIds, ['A', 'B']);
    assert.deepEqual(merged.categoryPaths, [['X', 'Y'], ['Z']]);
  });

  await suite.test('the contract accepts paths, rejects malformed ones, and a missing field leaves the entity hash unchanged', () => {
    const plain = concept({ conceptId: id('misc/plain'), name: 'Plain' });
    const parsed = ConceptSchema.parse(plain);
    assert.equal(parsed.searchScope.catalogCategoryPaths, undefined, 'no default is injected, so existing hashes stay valid');
    assert.equal(computeKnowledgeEntityHash(parsed), plain.contentHash);
    for (const bad of [[], [[]], [['Tools', '']], [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']]]) {
      assert.equal(ConceptSchema.safeParse({ ...plain, searchScope: { ...plain.searchScope, catalogCategoryPaths: bad } }).success, bad.length === 0, JSON.stringify(bad));
    }
    const withPath = concept({ conceptId: id('misc/path'), name: 'Path', searchScope: { catalogCategoryIds: [], catalogCategoryPaths: [['Tools']], enrichmentFacets: [], excludeCategoryIds: [] } });
    assert.notEqual(withPath.contentHash, concept({ conceptId: id('misc/path'), name: 'Path' }).contentHash, 'a scope change is a visible content change');
  });

  await suite.test('the gate hands the runtime the paths for the concept, the overview groups and cross-sell targets', () => {
    const release = content();
    const decision = resolveOkfGate(release, { tenantId: TENANT, environmentId: 'test', releaseId: 'r', message: 'plumbing supplies' }) as any;
    assert.equal(decision.mode, 'direct_results');
    assert.deepEqual(decision.retrieval.categoryPaths, [bathroomPlumbing]);
    assert.deepEqual(decision.retrieval.categoryIds, []);
    const legacy = resolveOkfGate(release, { tenantId: TENANT, environmentId: 'test', releaseId: 'r', message: 'vanities' }) as any;
    assert.deepEqual(legacy.retrieval.categoryPaths, [], 'a name-scoped concept reports no paths');
    assert.deepEqual(legacy.retrieval.categoryIds, ['Vanities']);

    const parent = concept({
      conceptId: id('families/plumbing'), name: 'Plumbing', type: 'product_family', customerPhrases: ['plumbing'],
      searchScope: { catalogCategoryIds: [], catalogCategoryPaths: [bathroomPlumbing, toolPlumbing], enrichmentFacets: [], excludeCategoryIds: [] },
      broadQueryPolicy: { groupConceptIds: [id('bathrooms/plumbing'), id('tools/plumbing')], maxItemsPerGroup: 2, productRetrievalAllowed: true },
    });
    const family = { ...release, concepts: [...release.concepts, parent] };
    const overview = resolveOkfGate(family, { tenantId: TENANT, environmentId: 'test', releaseId: 'r', message: 'plumbing' }) as any;
    assert.equal(overview.mode, 'overview_then_ask');
    assert.deepEqual(overview.retrieval.groups.map((group: any) => group.categoryPaths), [[bathroomPlumbing], [toolPlumbing]]);
    assert.deepEqual(overview.retrieval.categoryPaths, [bathroomPlumbing, toolPlumbing]);

    const withSuggestion = {
      ...release,
      relationships: [{
        relationshipId: 'rel-suggest', from: id('legacy/vanities'), to: id('bathrooms/plumbing'), type: 'cross_sell', strength: 'optional', scope: 'category',
        confidence: 'low', sourceRefs: [], claimClasses: [], contentHash: '0'.repeat(64),
      }],
    };
    const suggested = resolveOkfGate(withSuggestion, { tenantId: TENANT, environmentId: 'test', releaseId: 'r', message: 'vanities' }) as any;
    assert.deepEqual(suggested.suggestions[0].categoryPaths, [bathroomPlumbing]);
  });

  await suite.test('the basket governs a product by its path, not by a same-named category in another department', () => {
    const release = content();
    const availability = { excludeFlagPaths: [], statusPaths: [], unavailableStatuses: [] };
    const base = { tenantId: TENANT, environmentId: 'test', releaseId: 'r', availability };
    const product = (sku: string, categoryPath: string[]) => ({ projectId: TENANT, sku, categoryPath });
    const run = (sku: string, categoryPath: string[]) => resolveOkfBasketCommerce(release, { ...base, items: [{ sku }], products: [product(sku, categoryPath)] });
    assert.deepEqual(run('B1', [...bathroomPlumbing, 'Pipes']).commerce, { addToCart: 'allowed', checkout: 'allowed' }, 'governed by the bathroom concept (allowed)');
    const tool = run('T1', toolPlumbing);
    assert.equal(tool.commerce.checkout, 'requires_compatibility_resolution', 'governed by the tools concept, which is stricter');
    assert.ok(!tool.reasonCodes.includes('unmapped_catalog_category'));
    const stray = run('X1', ['Garden', 'Plumbing']);
    assert.deepEqual(stray.commerce, { addToCart: 'blocked', checkout: 'blocked' }, 'a "Plumbing" in an unrelated department is not governed by either');
    assert.ok(stray.reasonCodes.includes('unmapped_catalog_category'));
  });

  await suite.test('a draft with paths validates and publishes through the server-owned evaluation', () => {
    const draft = { ...content(), evaluation: undefined } as any;
    const validation = validateOkfDraftContent(
      { schemaVersion: '1.0.0', modelId: 'm', factRegistry: draft.factRegistry, concepts: draft.concepts, relationships: [], sources: [], evidenceChunks: [], verifications: [], acceptanceScenarios: [] } as any, TENANT);
    assert.equal(validation.valid, true, JSON.stringify(validation.issues.slice(0, 3)));
    const built = buildServerOwnedOkfContent(
      { schemaVersion: '1.0.0', modelId: 'm', factRegistry: draft.factRegistry, concepts: draft.concepts, relationships: [], sources: [], evidenceChunks: [], verifications: [], acceptanceScenarios: [] } as any,
      { tenantId: TENANT, environmentId: 'test', releaseId: 'r', evaluatedAt: '2026-10-13T00:00:00.000Z' });
    assert.equal(built.evaluation.passed, true);
    assert.deepEqual((built.concepts.find((entry) => entry.conceptId === id('tools/plumbing')) as any).searchScope.catalogCategoryPaths, [toolPlumbing]);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
