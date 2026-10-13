import assert from 'node:assert/strict';
import {
  areaResolver, assignVerifier, assignVerifiers, formatList, groupStaleness, groupVerificationWork, parseList, patchConcept, relationshipBadge,
  relationshipMakesClaim, relationshipWords, splitRevocations,
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
  relationships: [{ relationshipId: 'rel-1', claimClasses: ['compatibility'], contentHash: hash('c'), sourceRefs: ['src-2'] }, { relationshipId: 'rel-2', claimClasses: ['compatibility'], contentHash: hash('d') }],
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

check('a link that makes no claim says so instead of "Unverified"; one that does still needs a person', () => {
  const draft = content();
  const tree = { relationshipId: 'tree', type: 'child_of', claimClasses: [], contentHash: hash('e') };
  assert.equal(relationshipMakesClaim(tree), false);
  assert.equal(relationshipMakesClaim(draft.relationships[1]), true);
  assert.deepEqual([relationshipBadge(draft, tree).label, relationshipBadge(draft, tree).tone], ['No claim', 'neutral']);
  assert.equal(relationshipBadge(draft, draft.relationships[1]).label, 'Unverified');
  assert.equal(relationshipWords('child_of'), 'sits inside');
  assert.equal(relationshipWords('some_future_type'), 'some future type', 'an unknown type reads in its own words');
});

// A small shop: two departments, a problem, a care guide, a suggestion and a tree link.
const shop = (): any => {
  const concept = (id: string, name: string, over: object = {}) => ({ conceptId: `concept://t/${id}`, name, lens: 'product', riskClass: 'standard', contentHash: hash('a'), ...over });
  return {
    concepts: [
      concept('fastenings', 'Fastenings'), concept('fastenings/screws', 'Screws', { riskClass: 'compatibility' }), concept('fastenings/nails', 'Nails'),
      concept('bathrooms', 'Bathrooms'), concept('bathrooms/vanities', 'Vanities'),
      concept('problems/leak', 'Bathroom leak', { lens: 'problem', riskClass: 'safety_critical' }), concept('care/deck', 'Deck care', { lens: 'care' }),
    ],
    relationships: [
      { relationshipId: 'r1', type: 'child_of', from: 'concept://t/fastenings/screws', to: 'concept://t/fastenings', claimClasses: [] },
      { relationshipId: 'r2', type: 'child_of', from: 'concept://t/fastenings/nails', to: 'concept://t/fastenings', claimClasses: [] },
      { relationshipId: 'r3', type: 'child_of', from: 'concept://t/bathrooms/vanities', to: 'concept://t/bathrooms', claimClasses: [] },
      { relationshipId: 'r4', type: 'care_for', from: 'concept://t/care/deck', to: 'concept://t/fastenings/nails', claimClasses: ['care_safety'] },
    ],
    verifications: [],
  };
};
const entry = (targetId: string, about: string, reason = 'unverified', targetType = 'concept'): any => ({ targetType, targetId, reason, about });

check('the work list is grouped safety first, each kind split by the part of the shop it belongs to', () => {
  const draft = shop();
  const area = areaResolver(draft);
  assert.equal(area({ targetType: 'concept', targetId: 'concept://t/fastenings/screws' }), 'Fastenings', 'a topic sits under its department');
  assert.equal(area({ targetType: 'concept', targetId: 'concept://t/fastenings' }), 'Fastenings', 'a department is its own');
  assert.equal(area({ targetType: 'concept', targetId: 'concept://t/problems/leak' }), 'Problems');
  assert.equal(area({ targetType: 'concept', targetId: 'concept://t/care/deck' }), 'Care guides');
  assert.equal(area({ targetType: 'relationship', targetId: 'r4' }), 'Care guides', 'a link belongs where it starts');
  assert.equal(area({ targetType: 'concept', targetId: 'concept://t/nope' }), 'Other');

  const { changed, groups } = groupVerificationWork([
    entry('concept://t/fastenings/nails', 'documents'), entry('concept://t/bathrooms/vanities', 'documents'), entry('concept://t/fastenings/screws', 'compatibility'),
    entry('concept://t/problems/leak', 'safety'), entry('concept://t/care/deck', 'care'), entry('r4', 'care', 'unverified', 'relationship'),
    entry('concept://t/fastenings', 'documents', 'edited_since_verification'),
  ], draft);
  assert.deepEqual(groups.map((group) => [group.topic, group.count]), [['safety', 1], ['care', 2], ['compatibility', 1], ['documents', 2]]);
  assert.deepEqual(groups.map((group) => group.optional), [false, false, false, true], 'document reviews can wait');
  assert.deepEqual(groups[3].areas.map((a) => [a.area, a.items.length]), [['Bathrooms', 1], ['Fastenings', 1]].sort((a, b) => (a[0] < b[0] ? -1 : 1)), 'ties are alphabetical');
  assert.deepEqual(changed.map((item) => item.label), ['Fastenings'], 'something confirmed and then edited comes first');
  assert.equal(groups[1].areas.find((a) => a.area === 'Care guides')!.items.find((item) => item.entry.targetId === 'r4')!.label, 'Deck care is cared for with Nails', 'a link reads as a sentence');
  assert.deepEqual(groupVerificationWork([], draft), { changed: [], groups: [] });
});

check('a whole department can be handed to one person in one save', () => {
  const draft = shop();
  const targets = [{ targetType: 'concept' as const, targetId: 'concept://t/fastenings/screws' }, { targetType: 'concept' as const, targetId: 'concept://t/fastenings/nails' }, { targetType: 'relationship' as const, targetId: 'r4' }];
  const next = assignVerifiers(draft, targets, { verifiedBy: 'human:dana', verifierRole: 'trade_expert', now: new Date('2026-10-11T00:00:00Z') });
  assert.equal(next.verifications.length, 3);
  assert.ok(next.verifications.every((record: any) => record.verifiedBy === 'human:dana' && record.verifierRole === 'trade_expert' && record.status === 'verified'));
  assert.equal(draft.verifications.length, 0, 'input is not mutated');
  assert.throws(() => assignVerifiers(draft, [...targets, { targetType: 'concept', targetId: 'concept://t/missing' }], { verifiedBy: 'human:dana', verifierRole: 'x' }), /not in the draft/);
});

check('revocations split into active and history', () => {
  const { active, history } = splitRevocations([{ status: 'active' }, { status: 'lifted' }, { status: 'expired' }]);
  assert.equal(active.length, 1);
  assert.equal(history.length, 2);
});

console.log(`✅ backoffice OKF Studio model: ${passed} passed, 0 failed`);
