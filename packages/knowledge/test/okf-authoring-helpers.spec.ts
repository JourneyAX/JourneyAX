import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { bindDraftEntityHashes, computeKnowledgeEntityHash, findStaleVerifications } from '../src';
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

  await suite.test('non-object content passes through untouched', () => {
    assert.equal(bindDraftEntityHashes(null as any), null);
    assert.deepEqual(bindDraftEntityHashes({ concepts: 'nope' } as any), { concepts: 'nope' });
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
