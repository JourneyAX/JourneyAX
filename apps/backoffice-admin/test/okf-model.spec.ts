import assert from 'node:assert/strict';
import {
  assignVerifier, formatList, groupStaleness, parseList, patchConcept, relationshipBadge, splitRevocations,
} from '../src/components/okf/okf-model';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const hash = (c: string) => c.repeat(64);
const content = (): any => ({
  concepts: [{
    conceptId: 'concept://t/a', name: 'A', description: 'd', synonyms: [], customerPhrases: [], riskClass: 'standard', compatibilitySensitive: false,
    commercePolicy: { addToCart: 'allowed', checkout: 'allowed' }, safety: { blocksProducts: false, stepRefs: [] },
    lifecycle: { status: 'active_draft' }, requiredFacts: [], searchScope: { catalogCategoryIds: [], enrichmentFacets: [], excludeCategoryIds: [] },
    contentHash: hash('a'), evidenceRefs: ['src-1'],
  }, { conceptId: 'concept://t/b', name: 'B', contentHash: hash('b') }],
  relationships: [{ relationshipId: 'rel-1', contentHash: hash('c'), sourceRefs: ['src-2'] }, { relationshipId: 'rel-2', contentHash: hash('d') }],
  verifications: [{ recordId: 'v1', targetType: 'relationship', targetId: 'rel-1', status: 'verified', verifiedBy: 'human:bob', verifierRole: 'trade_expert', contentHash: hash('c') }],
});

console.log('🧪 backoffice: OKF Studio model');

check('list fields round-trip without duplicates or blanks', () => {
  assert.deepEqual(parseList('a, b\n b ,, c'), ['a', 'b', 'c']);
  assert.equal(formatList(['a', 'b']), 'a, b');
  assert.equal(formatList(undefined), '');
});

check('relationship badges reflect verification state against the current hash', () => {
  const draft = content();
  assert.equal(relationshipBadge(draft, draft.relationships[0]).label, 'Verified');
  assert.equal(relationshipBadge(draft, draft.relationships[1]).tone, 'bad');
  draft.relationships[0].contentHash = hash('e');
  assert.equal(relationshipBadge(draft, draft.relationships[0]).label, 'Edited — re-verify');
  draft.verifications[0].status = 'in_review';
  assert.equal(relationshipBadge(draft, draft.relationships[0]).label, 'In review');
  draft.verifications[0] = { ...draft.verifications[0], status: 'verified', contentHash: hash('e'), staleAfter: '2020-01-01T00:00:00.000Z' };
  assert.equal(relationshipBadge(draft, draft.relationships[0]).label, 'Verification expired');
});

check('staleness groups are ordered by urgency and empty groups are dropped', () => {
  const groups = groupStaleness([
    { targetType: 'concept', targetId: 'x', reason: 'unverified' },
    { targetType: 'relationship', targetId: 'y', reason: 'edited_since_verification' },
  ]);
  assert.deepEqual(groups.map((group) => group.reason), ['edited_since_verification', 'unverified']);
});

check('patchConcept edits only the chosen concept and never touches the hash', () => {
  const draft = content();
  const next = patchConcept(draft, 'concept://t/a', { name: 'A2', checkout: 'blocked', blocksProducts: true, catalogCategoryIds: ['x'], synonyms: ['s'] });
  assert.equal(next.concepts[0].name, 'A2');
  assert.equal(next.concepts[0].commercePolicy.checkout, 'blocked');
  assert.equal(next.concepts[0].commercePolicy.addToCart, 'allowed');
  assert.equal(next.concepts[0].safety.blocksProducts, true);
  assert.deepEqual(next.concepts[0].searchScope.catalogCategoryIds, ['x']);
  assert.equal(next.concepts[0].contentHash, hash('a'));
  assert.equal(next.concepts[1], draft.concepts[1]);
  assert.equal(draft.concepts[0].name, 'A', 'input is not mutated');
  assert.throws(() => patchConcept(draft, 'concept://t/missing', { name: 'x' }), /not in the draft/);
});

check('assignVerifier writes a record bound to the current hash and replaces an existing one', () => {
  const draft = content();
  const created = assignVerifier(draft, { targetType: 'concept', targetId: 'concept://t/a', verifiedBy: 'human:carol', verifierRole: 'product_manager', now: new Date('2026-10-11T00:00:00Z') });
  const record = created.verifications.find((item: any) => item.targetId === 'concept://t/a');
  assert.equal(record.contentHash, hash('a'));
  assert.equal(record.status, 'verified');
  assert.equal(record.verifiedAt, '2026-10-11T00:00:00.000Z');
  assert.deepEqual(record.sourceRefs, ['src-1']);
  const replaced = assignVerifier(draft, { targetType: 'relationship', targetId: 'rel-1', verifiedBy: 'human:carol', verifierRole: 'trade_expert' });
  assert.equal(replaced.verifications.length, 1);
  assert.equal(replaced.verifications[0].verifiedBy, 'human:carol');
  assert.throws(() => assignVerifier(draft, { targetType: 'concept', targetId: 'concept://t/a', verifiedBy: ' ', verifierRole: 'x' }), /verifier and a verifier role/);
  assert.throws(() => assignVerifier(draft, { targetType: 'relationship', targetId: 'nope', verifiedBy: 'a', verifierRole: 'b' }), /not in the draft/);
});

check('revocations split into active and history', () => {
  const { active, history } = splitRevocations([{ status: 'active' }, { status: 'lifted' }, { status: 'expired' }]);
  assert.equal(active.length, 1);
  assert.equal(history.length, 2);
});

console.log(`✅ backoffice OKF Studio model: ${passed} passed, 0 failed`);
