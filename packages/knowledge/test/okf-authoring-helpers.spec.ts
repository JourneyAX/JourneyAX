import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { bindDraftEntityHashes, computeKnowledgeEntityHash, findStaleVerifications, findVerificationWork } from '../src';
import { buildOkfContent } from './fixtures';

const suite = createSuite('knowledge: draft authoring helpers');
const base: any = buildOkfContent();
const VERIFIED = base.verifications.find((item: any) => item.targetType === 'relationship' && item.status === 'verified').targetId as string;

async function main() {
  await suite.test('hashes are recomputed from content and ignore whatever the client sent', () => {
    const draft: any = structuredClone(buildOkfContent());
    draft.concepts[0].name = 'Renamed by an editor';
    draft.concepts[0].contentHash = 'f'.repeat(64);
    const bound: any = bindDraftEntityHashes(draft);
    assert.equal(bound.concepts[0].contentHash, computeKnowledgeEntityHash(bound.concepts[0]));
    assert.notEqual(bound.concepts[0].contentHash, 'f'.repeat(64));
    assert.equal(draft.concepts[0].contentHash, 'f'.repeat(64), 'input is not mutated');
  });

  await suite.test('editing an entity leaves its verification pointing at the old hash, so it surfaces as stale', () => {
    const draft: any = structuredClone(buildOkfContent());
    assert.equal(findStaleVerifications(draft).filter((entry) => entry.reason === 'edited_since_verification').length, 0);
    const relationship = draft.relationships.find((item: any) => item.relationshipId === VERIFIED);
    relationship.customerLabel = `${relationship.customerLabel || 'label'} (edited)`;
    const stale = findStaleVerifications(bindDraftEntityHashes(draft));
    assert.deepEqual(stale.filter((entry) => entry.targetId === VERIFIED).map((entry) => entry.reason), ['edited_since_verification']);
  });

  await suite.test('verification expiry and missing records are reported', () => {
    const draft: any = structuredClone(buildOkfContent());
    const record = draft.verifications.find((item: any) => item.targetId === VERIFIED);
    record.staleAfter = '2020-01-01T00:00:00.000Z';
    const reasons = findStaleVerifications(draft, new Date('2026-10-11')).filter((entry) => entry.targetId === VERIFIED).map((entry) => entry.reason);
    assert.deepEqual(reasons, ['expired']);
    draft.verifications = draft.verifications.filter((item: any) => item.targetId !== VERIFIED);
    assert.deepEqual(findStaleVerifications(draft).filter((entry) => entry.targetId === VERIFIED).map((entry) => entry.reason), ['unverified']);
  });

  await suite.test('only what could change what the assistant may say is work for a person: structure and suggestions are not', () => {
    const concept = (id: string, over: object = {}) => ({ conceptId: `concept://t/${id}`, lens: 'product', riskClass: 'standard', compatibilitySensitive: false, evidenceRefs: [], contentHash: id.padEnd(64, '0'), ...over });
    const relationship = (id: string, type: string, claimClasses: string[] = []) => ({ relationshipId: id, type, claimClasses, contentHash: id.padEnd(64, '0') });
    const content: any = {
      sources: [{ sourceId: 'doc-1', kind: 'crawl' }, { sourceId: 'note-1', kind: 'merchant_policy' }],
      concepts: [
        concept('plain'), concept('with-doc', { evidenceRefs: ['doc-1'] }), concept('with-other-source', { evidenceRefs: ['note-1'] }),
        concept('leak', { lens: 'problem', riskClass: 'safety_critical' }), concept('deck-care', { lens: 'care' }),
        concept('screws', { riskClass: 'compatibility', compatibilitySensitive: true }), concept('sensitive', { compatibilitySensitive: true }),
      ],
      relationships: [
        relationship('tree', 'child_of'), relationship('idea', 'cross_sell'), relationship('care-tip', 'care_for', ['care_safety']),
        relationship('fits', 'compatible_with', ['compatibility']), relationship('warranty-link', 'document_for', ['warranty']), relationship('steps', 'installed_with', ['installation_step', 'safety_instruction']),
      ],
      verifications: [],
    };
    const work = findVerificationWork(content);
    const byTarget = new Map(work.map((entry) => [entry.targetId.replace('concept://t/', ''), entry.about]));
    assert.deepEqual([...byTarget.keys()].sort(), ['care-tip', 'deck-care', 'fits', 'leak', 'screws', 'sensitive', 'steps', 'warranty-link', 'with-doc']);
    assert.equal(byTarget.get('leak'), 'safety');
    assert.equal(byTarget.get('deck-care'), 'care');
    assert.equal(byTarget.get('screws'), 'compatibility');
    assert.equal(byTarget.get('with-doc'), 'documents');
    assert.equal(byTarget.get('care-tip'), 'care');
    assert.equal(byTarget.get('fits'), 'compatibility');
    assert.equal(byTarget.get('warranty-link'), 'documents');
    assert.equal(byTarget.get('steps'), 'safety', 'the most serious topic of its claims');
    assert.equal(findStaleVerifications(content).length, 13, 'the full list still counts everything');

    // Something already verified that was edited or has expired is work, whatever it is.
    const verified: any = structuredClone(content);
    verified.verifications = [
      { recordId: 'v1', targetType: 'relationship', targetId: 'tree', status: 'verified', contentHash: 'changed'.padEnd(64, '0') },
      { recordId: 'v2', targetType: 'concept', targetId: 'concept://t/plain', status: 'verified', contentHash: 'plain'.padEnd(64, '0'), staleAfter: '2020-01-01T00:00:00.000Z' },
      { recordId: 'v3', targetType: 'concept', targetId: 'concept://t/leak', status: 'verified', contentHash: 'leak'.padEnd(64, '0') },
    ];
    const after = findVerificationWork(verified, new Date('2026-10-11'));
    assert.deepEqual(after.filter((entry) => ['tree', 'concept://t/plain'].includes(entry.targetId)).map((entry) => entry.reason).sort(), ['edited_since_verification', 'expired']);
    assert.ok(!after.some((entry) => entry.targetId === 'concept://t/leak'), 'verified and current: no work');
    assert.deepEqual(findVerificationWork({}), []);
  });

  await suite.test('non-object content passes through untouched', () => {
    assert.equal(bindDraftEntityHashes(null as any), null);
    assert.deepEqual(bindDraftEntityHashes({ concepts: 'nope' } as any), { concepts: 'nope' });
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
