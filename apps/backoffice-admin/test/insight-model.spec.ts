import assert from 'node:assert/strict';
import { coverageHeadline, diffSentence, formatMoney, lifecycleSteps, percent, shortChecksum, sortIssues, NEXT_STEP, MODE_COPY } from '../src/components/okf/insight-model';
import type { KnowledgeCoverage, KnowledgeLifecycle } from '../src/lib/api';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const diff = (over: Partial<NonNullable<KnowledgeLifecycle['changes']['draftVsStaged']>> = {}): NonNullable<KnowledgeLifecycle['changes']['draftVsStaged']> => ({
  identical: false,
  concepts: { added: [], removed: [], changed: [], total: 0 },
  relationships: { added: 0, removed: 0, changed: 0 }, facts: { added: [], removed: [], changed: [] }, sources: { added: 0, removed: 0 }, verifications: { added: 0, removed: 0, changed: 0 },
  ...over,
});
const lifecycle = (over: Partial<KnowledgeLifecycle> = {}): KnowledgeLifecycle => ({
  environmentId: 'production',
  draft: { revision: 4, valid: true, issues: 0, checksum: 'a'.repeat(64), updatedAt: null, updatedBy: null, concepts: 475 },
  releases: [{ releaseId: 'r2', version: '1.1.0', checksum: 'b'.repeat(64), status: 'ready', publishedAt: null, publishedBy: null }],
  staged: { releaseId: 'r2', version: '1.1.0', checksum: 'b'.repeat(64), required: true, failurePolicy: 'fail_closed' },
  active: { packVersion: '1.0.38', publishedAt: null, publishedBy: null, currency: 'NZD', hasCatalogMapping: true, knowledge: null },
  state: { draftHasChanges: false, stagedIsLatestRelease: true, activeIsStaged: false, knowledgeRequiredByPack: null },
  changes: { draftVsStaged: diff({ identical: true }), stagedVsActive: diff({ concepts: { added: [{ conceptId: 'c', name: 'Vanities' }], removed: [], changed: [], total: 1 } }) },
  nextStep: 'publish_pack',
  ...over,
});

console.log('🧪 backoffice: insight shaping');

check('the four places knowledge can be are laid out with where each stands', () => {
  const steps = lifecycleSteps(lifecycle());
  assert.deepEqual(steps.map((step) => [step.id, step.state]), [['draft', 'done'], ['release', 'done'], ['staged', 'done'], ['active', 'current']]);
  assert.match(steps[3].summary, /Pack 1\.0\.38 · no knowledge attached/, 'a live pack without knowledge is stated, not hidden');
  assert.match(steps[2].detail!, /Required/);
});

check('an invalid draft blocks; unpublished changes and a stale staged release ask for action', () => {
  assert.equal(lifecycleSteps(lifecycle({ draft: { ...lifecycle().draft!, valid: false, issues: 3 } }))[0].state, 'blocked');
  assert.equal(lifecycleSteps(lifecycle({ state: { ...lifecycle().state, draftHasChanges: true } }))[0].state, 'current');
  const behind = lifecycleSteps(lifecycle({ state: { ...lifecycle().state, stagedIsLatestRelease: false } }));
  assert.equal(behind[1].state, 'current');
  assert.equal(behind[2].state, 'current');
  assert.deepEqual(lifecycleSteps(lifecycle({ draft: null, releases: [], staged: null, active: null })).map((step) => step.state), ['todo', 'todo', 'todo', 'todo']);
});

check('every next step the service can name has a label and an explanation', () => {
  for (const step of ['write_draft', 'publish_release', 'stage_release', 'publish_pack', 'none'] as const) {
    assert.ok(NEXT_STEP[step].label && NEXT_STEP[step].detail, step);
  }
  assert.equal(NEXT_STEP.none.tone, 'ok');
});

check('differences are described by name, not by count alone, and capped', () => {
  assert.equal(diffSentence(null, 'a', 'b'), '');
  assert.match(diffSentence(diff({ identical: true }), 'the staged release', 'The draft'), /identical/);
  const sentence = diffSentence(diff({
    concepts: { changed: [{ conceptId: '1', name: 'Vanities' }], added: [1, 2, 3, 4].map((n) => ({ conceptId: String(n), name: `New ${n}` })), removed: [], total: 5 },
    relationships: { added: 1, removed: 0, changed: 1 },
  }), 'what is live', 'The staged release');
  assert.match(sentence, /changed Vanities/);
  assert.match(sentence, /added New 1, New 2, New 3 and 1 more/);
  assert.match(sentence, /2 relationships differ/);
});

check('money is shown in its declared currency and never in an assumed one', () => {
  assert.match(formatMoney(12950, 'NZD'), /129\.50/);
  assert.match(formatMoney(12950, 'NZD'), /NZ\$|NZD/);
  assert.equal(formatMoney(null, 'NZD'), 'No price');
  assert.match(formatMoney(500), /currency not declared/);
  assert.doesNotMatch(formatMoney(500), /\$/);
});

check('issues sort errors first, then by how many products they touch', () => {
  const issue = (severity: 'error' | 'warning' | 'info', affected: number) => ({ severity, code: severity + affected, field: 'f', message: 'm', affected, share: 0, examples: [] });
  assert.deepEqual(sortIssues([issue('info', 9), issue('warning', 1), issue('error', 2), issue('warning', 5)]).map((entry) => entry.code), ['error2', 'warning5', 'warning1', 'info9']);
});

check('small helpers: percentages, checksums, headline', () => {
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(1, 0), 0);
  assert.equal(shortChecksum('sha256:' + 'f'.repeat(64)), 'ffffffffff…');
  assert.equal(shortChecksum(null), '—');
  const coverage = { catalogue: { products: 42000, covered: 41619, uncovered: 381, uncoveredCategories: [] } } as unknown as KnowledgeCoverage;
  assert.match(coverageHeadline(coverage).text, /99%/);
  assert.equal(coverageHeadline({} as KnowledgeCoverage).covered, null);
});

check('every response mode the gate can produce is explained in plain words', () => {
  for (const mode of ['direct_results', 'overview_then_ask', 'clarify_then_search', 'safety_then_diagnose', 'project_journey', 'evidence_answer', 'operational_journey', 'service_intake', 'legacy_search', 'no_match', 'knowledge_unavailable']) {
    assert.ok(MODE_COPY[mode], mode);
  }
});

console.log(`✅ backoffice insight shaping: ${passed} passed, 0 failed`);
