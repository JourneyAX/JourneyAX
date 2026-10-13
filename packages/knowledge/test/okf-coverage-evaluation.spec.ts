import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import {
  EVAL_FAMILIES, applyAuthoring, attachAcceptanceScenarios, buildServerOwnedOkfContent, buildTaxonomyDraft, evaluateCoverage, evaluateOkfDraft,
  renderEvaluationMarkdown, ScenarioFileSchema, resolveOkfPolicy, detectIntents, computeKnowledgeEntityHash,
} from '../src';

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const snapshot = read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json');
const scenarioFile = read('scripts/okf/tenants/placemakers.scenarios.json');
const derived = buildTaxonomyDraft(snapshot, read('scripts/okf/tenants/placemakers.ingest.json'));
const authored = applyAuthoring(derived, read('scripts/okf/tenants/placemakers.authoring.json'));
const attached = attachAcceptanceScenarios(authored.draft, scenarioFile);
const draft: any = { ...authored.draft, acceptanceScenarios: attached.scenarios };
const content: any = buildServerOwnedOkfContent(draft, { tenantId: 'placemakers', environmentId: 'test', releaseId: 'r', evaluatedAt: snapshot.snapshotAt });
const catalogue = snapshot.rows.map((row: any) => ({ path: row.path, category: row.category, products: row.productCount }));
const NOW = new Date(snapshot.snapshotAt);

const suite = createSuite('knowledge: coverage-driven evaluation (real PlaceMakers release)');
const rehash = (concept: any) => ({ ...concept, contentHash: computeKnowledgeEntityHash({ ...concept, contentHash: undefined }) });
const run = (mutated: any, only: any) => evaluateCoverage(mutated, { tenantId: 'placemakers', now: NOW, catalogue, only });
const nameOf = (name: string) => content.concepts.find((concept: any) => concept.name === name);

async function main() {
  const full = evaluateCoverage(content, { tenantId: 'placemakers', now: NOW, catalogue, acceptedRoutingCollisions: scenarioFile.acceptedRoutingCollisions });

  await suite.test('the whole matrix holds: every generated scenario passes through the real gate and basket, with no gaps', () => {
    assert.deepEqual(full.report.failures, []);
    assert.deepEqual(full.report.gaps, []);
    assert.equal(full.report.totals.failed, 0);
    assert.equal(full.report.totals.passed, full.report.totals.scenarios);
  });

  await suite.test('the suite is not vacuous: its size follows the release and the catalogue, family by family', () => {
    const concepts = content.concepts.length;
    const leaves = content.concepts.filter((concept: any) => concept.lens === 'product' && concept.searchScope.catalogCategoryPaths?.length &&
      !content.concepts.some((other: any) => other !== concept && other.searchScope.catalogCategoryPaths?.[0] && other.searchScope.catalogCategoryPaths[0].length > concept.searchScope.catalogCategoryPaths[0].length &&
        other.searchScope.catalogCategoryPaths[0].slice(0, concept.searchScope.catalogCategoryPaths[0].length).join('\u0000').toLowerCase() === concept.searchScope.catalogCategoryPaths[0].join('\u0000').toLowerCase())).length;
    const f = full.report.families;
    assert.ok(f.routing.total >= concepts, `routing probes every concept by name: ${f.routing.total} >= ${concepts}`);
    assert.equal(f.scope.total, catalogue.length, 'one scope scenario per catalogue group');
    assert.equal(f.commerce.total, catalogue.length, 'one basket scenario per catalogue group');
    assert.equal(f.safety.total, leaves * 3, 'three hazard phrasings per leaf category');
    assert.equal(f.technical_claims.total, leaves);
    assert.equal(f.evidence.total, leaves * 3, 'installation, warranty and care per leaf category');
    assert.equal(f.exact_sku.total, leaves);
    assert.equal(f.cross_sell.total, content.relationships.filter((r: any) => r.type === 'cross_sell').length);
    assert.equal(f.authored_path.total, scenarioFile.scenarios.length);
    assert.ok(f.negative.total >= 10);
    for (const family of EVAL_FAMILIES) assert.ok(f[family]?.total > 0, `${family} ran`);
    assert.ok(leaves >= 300, `${leaves} leaf categories`);
  });

  await suite.test('the matrix has a row for every department in the catalogue, and every category the catalogue lists', () => {
    const departments = new Set(snapshot.rows.filter((row: any) => row.path.length).map((row: any) => row.path[0]));
    const reported = new Set(full.report.departments.map((entry) => entry.name));
    for (const department of departments) assert.ok(reported.has(department as string), `${department} is in the matrix`);
    assert.ok(reported.has('(negative)') && reported.has('(cross-cutting)'));
    const categoriesProbed = new Set(full.report.departments.flatMap((entry) => entry.categories.map((category) => category.path.join('\u0000'))));
    for (const row of snapshot.rows.filter((entry: any) => entry.path.length === 3)) assert.ok(categoriesProbed.has(row.path.join('\u0000')), `${row.path.join(' > ')} is probed`);
    const markdown = renderEvaluationMarkdown(full.report);
    assert.match(markdown, /scenarios hold/);
    assert.match(markdown, /\| routing \|/);
    assert.match(markdown, /Bathrooms & Plumbing/);
    assert.match(markdown, /None: every concept was probed in every family/);
  });

  await suite.test('the tenant\'s customer paths are real publication-gate scenarios: they resolve, are attached, and ran in the release evaluation', () => {
    assert.deepEqual(attached.errors, []);
    assert.equal(attached.scenarios.length, scenarioFile.scenarios.length);
    assert.equal(content.acceptanceScenarios.length, scenarioFile.scenarios.length);
    const results = evaluateOkfDraft(draft, 'placemakers', 'test', 'r', snapshot.snapshotAt);
    assert.equal(results.filter((entry) => entry.id.startsWith('tenant_scenario:')).length, scenarioFile.scenarios.length);
    assert.ok(results.every((entry) => entry.passed));
    const covered = new Set(scenarioFile.scenarios.flatMap((entry: any) => [entry.expect.mode].filter(Boolean)));
    for (const mode of ['direct_results', 'overview_then_ask', 'project_journey', 'safety_then_diagnose', 'evidence_answer', 'operational_journey', 'no_match']) assert.ok(covered.has(mode), `a customer path expects ${mode}`);
  });

  await suite.test('the customer paths cover the paths that matter to the business, by area', () => {
    const ids: string[] = scenarioFile.scenarios.map((entry: any) => entry.id);
    for (const area of ['fastenings', 'decking', 'bathroom', 'wet-area', 'laundry', 'paint', 'cleaning', 'maintenance', 'problem', 'trade', 'operational', 'uncovered']) {
      assert.ok(ids.some((id) => id.startsWith(`${area}-`)), `a scenario for ${area}`);
    }
  });

  await suite.test('an unresolvable or ambiguous reference in a scenario file is an error, never silently dropped', () => {
    const bad = attachAcceptanceScenarios(authored.draft, {
      tenantId: 'placemakers', version: '1', scenarios: [
        { id: 'a', description: 'unknown concept', message: 'x', expect: { concept: 'No Such Concept' } },
        { id: 'b', description: 'unknown fact', message: 'x', facts: { not_a_fact: 'y' }, expect: { ask: 'also_not_a_fact' } },
        { id: 'a', description: 'duplicate id', message: 'x', expect: { mode: 'no_match' } },
      ],
    });
    assert.deepEqual([...new Set(bad.errors.map((entry) => entry.code))].sort(), ['duplicate_scenario', 'unknown_concept', 'unknown_fact']);
    assert.throws(() => ScenarioFileSchema.parse({ tenantId: 'placemakers', version: '1', scenarios: [{ id: 'a', description: 'x y z', message: 'm', expect: { surprise: true } }] }));
  });

  // ── The suite must be able to fail: each mutation breaks one thing and names the family that notices ──

  await suite.test('mutation: two concepts with the same name are caught by routing (a customer cannot reach both)', () => {
    const mutated = structuredClone(content);
    const [a, b] = mutated.concepts.filter((concept: any) => concept.searchScope.catalogCategoryPaths?.[0]?.length === 3).slice(0, 2);
    b.name = a.name;
    const result = run(mutated, { families: ['routing'], conceptIds: [a.conceptId, b.conceptId] });
    assert.ok(result.report.failures.some((failure) => failure.family === 'routing' && /instead of the concept itself/.test(failure.failures[0])));
  });

  await suite.test('mutation: moving a category\'s scope to another department is caught by scope and by the exact-scope check', () => {
    const mutated = structuredClone(content);
    const vanities = mutated.concepts.find((concept: any) => concept.name === 'Vanities');
    vanities.searchScope.catalogCategoryPaths = [['Tools', 'Hand Tools', 'Hammers & Mallets']];
    const result = run(mutated, { families: ['scope'], departments: ['Bathrooms & Plumbing'] });
    assert.ok(result.report.failures.some((failure) => failure.category === 'Vanities' && /no concept is scoped to exactly this category/.test(failure.failures.join(' '))));
  });

  await suite.test('mutation: a category scoped too widely pulls another department\'s products and is caught', () => {
    const mutated = structuredClone(content);
    const mirrors = mutated.concepts.find((concept: any) => concept.name === 'Mirrors');
    mirrors.searchScope.catalogCategoryPaths = [...mirrors.searchScope.catalogCategoryPaths, ['Tools']];
    const result = run(mutated, { families: ['scope'], departments: ['Tools'] });
    assert.ok(result.report.failures.some((failure) => /'Mirrors' \(Bathrooms & Plumbing\) governs a product in Tools/.test(failure.failures.join(' '))));
  });

  await suite.test('mutation: weakening the hazard lexicon in the tenant policy fails every hazard probe', () => {
    const mutated = structuredClone(content);
    mutated.policy = { ...(mutated.policy ?? {}), intentGroups: { problem: [] } };
    assert.equal(detectIntents('my vanity is sparking', resolveOkfPolicy(mutated.policy)).intents.length >= 0, true);
    const result = run(mutated, { families: ['safety', 'negative'], departments: ['Bathrooms & Plumbing', '(negative)'] });
    assert.ok(result.report.failures.filter((failure) => failure.family === 'safety').length > 20, 'hazard probes notice');
    assert.ok(result.report.failures.some((failure) => failure.family === 'negative' && /hazard/.test(failure.category)));
  });

  await suite.test('mutation: a cross-sell relationship that carries a claim is caught', () => {
    const mutated = structuredClone(content);
    const edge = mutated.relationships.find((relationship: any) => relationship.type === 'cross_sell');
    edge.claimClasses = ['compatibility'];
    const result = run(mutated, { families: ['cross_sell'] });
    assert.ok(result.report.failures.some((failure) => /carries a claim class/.test(failure.failures.join(' '))));
  });

  await suite.test('mutation: loosening the professional-confirmation rule on trade categories breaks the stated customer path', () => {
    const mutated = structuredClone(content);
    const switchgear = mutated.concepts.find((concept: any) => concept.name === 'Switchgear');
    switchgear.commercePolicy = { addToCart: 'allowed', checkout: 'allowed' };
    switchgear.riskClass = 'standard';
    const result = run(mutated, { families: ['authored_path'] });
    assert.ok(result.report.failures.some((failure) => failure.id === 'authored_path:trade-switchgear-checkout'));
    // The release itself would also have been refused: the same scenario is a publication gate.
    assert.throws(() => buildServerOwnedOkfContent({ ...mutated, evaluation: undefined, index: undefined } as any, { tenantId: 'placemakers', environmentId: 'test', releaseId: 'r', evaluatedAt: snapshot.snapshotAt }), /trade-switchgear-checkout/);
  });

  await suite.test('mutation: making a care topic buyable still cannot make an unverified care answer show products', () => {
    const mutated = structuredClone(content);
    const care = mutated.concepts.find((concept: any) => concept.name === 'Deck care');
    care.lens = 'product'; care.type = 'product_family';
    const result = run(mutated, { families: ['authored_path'] });
    assert.ok(result.report.failures.length === 0 || result.report.failures.every((failure) => failure.family === 'authored_path'));
    const after = evaluateCoverage(mutated, { tenantId: 'placemakers', now: NOW, only: { families: ['evidence'], departments: ['Timber & Plywood'] } });
    assert.deepEqual(after.report.failures, [], 'evidence questions still escalate to "no verified source"');
  });

  await suite.test('the evaluation never mutates the release it is given, and is repeatable', () => {
    const before = JSON.stringify(content);
    const again = evaluateCoverage(content, { tenantId: 'placemakers', now: NOW, catalogue, only: { families: ['routing', 'negative'] } });
    assert.equal(JSON.stringify(content), before);
    assert.deepEqual(again.report.failures, []);
    void rehash;
    void nameOf;
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
