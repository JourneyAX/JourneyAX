import assert from 'node:assert/strict';
import {
  appendOkfRevocationEvent,
  buildServerOwnedOkfContent,
  computeKnowledgeEntityHash,
  computeKnowledgeChecksum,
  evaluateOkfDraft,
  loadActiveOkfRevocations,
  loadPinnedOkfRelease,
  OkfIntegrityError,
  publishOkfRelease,
  validateOkfJourneyReferences,
  validateOkfReleaseContent,
  verifyOkfReleaseEnvelope,
} from '../src';
import { buildOkfContent, buildStoredOkfRelease, conceptId } from './fixtures';

function matches(doc: any, query: any): boolean {
  return Object.entries(query || {}).every(([key, expected]: [string, any]) => {
    if (key === '$or') return expected.some((clause: any) => matches(doc, clause));
    if (expected && typeof expected === 'object' && '$exists' in expected) return (doc[key] !== undefined) === expected.$exists;
    return doc[key] === expected;
  });
}

class MemoryCursor {
  constructor(private docs: any[]) {}
  sort(spec: Record<string, number>) {
    const [key, direction] = Object.entries(spec)[0];
    this.docs.sort((a, b) => ((a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * direction));
    return this;
  }
  async toArray() { return this.docs.map((doc) => ({ ...doc })); }
}

class MemoryCollection {
  docs: any[] = [];
  async findOne(query: any) { return this.docs.find((doc) => matches(doc, query)) || null; }
  async insertOne(doc: any) { this.docs.push({ ...doc }); return { acknowledged: true }; }
  async insertMany(docs: any[]) { this.docs.push(...docs.map((doc) => ({ ...doc }))); return { acknowledged: true }; }
  find(query: any) { return new MemoryCursor(this.docs.filter((doc) => matches(doc, query))); }
}

class MemoryDb {
  private collections = new Map<string, MemoryCollection>();
  collection(name: string) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name)!;
  }
}

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${passed}. ${name}`);
  } catch (error) {
    console.error(`  ✗ ${passed + 1}. ${name}`);
    throw error;
  }
}

async function rejectsCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (error: any) => error instanceof OkfIntegrityError && error.code === code);
}

async function main() {
console.log('🧪 Running OKF release and revocation suite...');

await test('valid release content passes graph, evidence, fact, and verification checks', () => {
  const result = validateOkfReleaseContent(buildOkfContent(), 'placemakers');
  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
});

await test('explicit concept journey references must resolve to a Business Pack journey and entry stage', () => {
  const content = buildOkfContent() as any;
  content.concepts[0].journeyRef = { journeyId: 'journey_catalog', entryStageId: 'stage_catalog' };
  content.concepts[0].contentHash = computeKnowledgeEntityHash(content.concepts[0]);
  assert.equal(validateOkfReleaseContent(content, 'placemakers').valid, true);
  assert.equal(validateOkfJourneyReferences(content, []).some((issue) => issue.code === 'unresolved_journey_ref'), true);
  assert.equal(
    validateOkfJourneyReferences(content, [{ journeyId: 'journey_catalog', stages: {} }])
      .some((issue) => issue.code === 'unresolved_entry_stage_ref'),
    true
  );
  assert.deepEqual(
    validateOkfJourneyReferences(content, [{ journeyId: 'journey_catalog', stages: { stage_catalog: {} } }]),
    []
  );
});

await test('tampered release content with retained checksum fails closed', () => {
  const stored = buildStoredOkfRelease();
  stored.content.concepts[0].description = 'tampered';
  assert.throws(() => verifyOkfReleaseEnvelope(stored), (error: any) => error.code === 'checksum_mismatch');
});

await test('reference identity and checksum are all enforced', () => {
  const stored = buildStoredOkfRelease();
  assert.throws(() => verifyOkfReleaseEnvelope(stored, { tenantId: 'other' }), (error: any) => error.code === 'tenant_mismatch');
  assert.throws(() => verifyOkfReleaseEnvelope(stored, { environmentId: 'test' }), (error: any) => error.code === 'environment_mismatch');
  assert.throws(() => verifyOkfReleaseEnvelope(stored, { releaseId: 'other' }), (error: any) => error.code === 'release_mismatch');
  assert.throws(() => verifyOkfReleaseEnvelope(stored, { version: '2.0.0' }), (error: any) => error.code === 'version_mismatch');
  assert.throws(() => verifyOkfReleaseEnvelope(stored, { checksum: 'f'.repeat(64) }), (error: any) => error.code === 'reference_checksum_mismatch');
});

await test('an immutable historical release loads by integrity even if current publish rules are stricter', async () => {
  const db = new MemoryDb();
  const content = buildOkfContent() as any;
  content.evaluation = { ...content.evaluation, passed: false, failedScenarioCount: 1 };
  const stored = buildStoredOkfRelease() as any;
  stored.content = content;
  stored.checksum = computeKnowledgeChecksum(content);
  db.collection('okf_releases').docs.push(stored);
  const ref = {
    tenantId: stored.tenantId, environmentId: stored.environmentId,
    releaseId: stored.releaseId, version: stored.version, checksum: stored.checksum,
  };
  assert.equal((await loadPinnedOkfRelease(db as any, ref)).release.checksum, stored.checksum);
  await rejectsCode(() => publishOkfRelease(db as any, {
    releaseId: 'new-release', tenantId: stored.tenantId, environmentId: stored.environmentId,
    version: '2.0.0', content, publishedBy: 'test',
  }), 'semantic_invalid');
});

await test('publication writes immutable envelope and release-scoped normalized records', async () => {
  const db = new MemoryDb();
  const content = buildOkfContent();
  const release = await publishOkfRelease(db as any, {
    releaseId: 'okf-placemakers-1.0.0', tenantId: 'placemakers', environmentId: 'production', version: '1.0.0', content, publishedBy: 'test',
  });
  assert.equal(release.checksum, computeKnowledgeChecksum(content));
  assert.equal(db.collection('okf_releases').docs.length, 1);
  assert.equal(db.collection('okf_concepts').docs.length, content.concepts.length);
  assert.equal(db.collection('okf_fact_definitions').docs.length, content.factRegistry.length);
  assert.equal(db.collection('okf_relationships').docs.length, content.relationships.length);
  assert.equal(db.collection('okf_sources').docs.length, content.sources.length);
  assert.equal(db.collection('okf_evidence_chunks').docs.length, content.evidenceChunks.length);
  assert.equal(db.collection('okf_verification_records').docs.length, content.verifications.length);
  assert.equal(release.artifact?.status, 'pending');
  assert.equal(db.collection('outbox_events').docs.length, 1);
  assert.equal(db.collection('outbox_events').docs[0].eventType, 'okf.release.export_requested');
});

await test('publication rejects a server evaluation report that does not match its release metadata', async () => {
  const db = new MemoryDb();
  await rejectsCode(() => publishOkfRelease(db as any, {
    releaseId: 'okf-report-mismatch', tenantId: 'placemakers', environmentId: 'test',
    version: '1.0.0', content: buildOkfContent(), publishedBy: 'test',
    evaluationScenarios: [{ id: 'safety', passed: true }],
  }), 'evaluation_mismatch');
  assert.equal(db.collection('okf_releases').docs.length, 0);
});

await test('large evidence stays outside the release metadata document and hydrates with integrity checks', async () => {
  const db = new MemoryDb();
  const content = buildOkfContent() as any;
  const original = content.evidenceChunks[0];
  content.evidenceChunks = Array.from({ length: 21 }, (_, index) => {
    const chunk = {
      ...original,
      chunkId: `large-evidence-${index}`,
      ordinal: index,
      content: `Evidence ${index}: ${'x'.repeat(1_000_000)}`,
    };
    chunk.contentHash = computeKnowledgeEntityHash(chunk);
    return chunk;
  });
  for (const concept of content.concepts) {
    concept.evidenceRefs = [];
    concept.contentHash = computeKnowledgeEntityHash(concept);
  }
  const release = await publishOkfRelease(db as any, {
    releaseId: 'okf-placemakers-large', tenantId: 'placemakers', environmentId: 'test',
    version: '2.0.0', content, publishedBy: 'test',
  });
  const stored = db.collection('okf_releases').docs[0];
  assert.ok(Buffer.byteLength(JSON.stringify(content)) > 20_000_000);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) < 1_000_000);
  assert.equal(stored.content, undefined);
  const ref = { tenantId: 'placemakers', environmentId: 'test', releaseId: release.releaseId, version: release.version, checksum: release.checksum };
  const loaded = await loadPinnedOkfRelease(db as any, ref);
  assert.equal(loaded.release.content.evidenceChunks.length, 21);
  assert.equal(loaded.release.checksum, release.checksum);
  db.collection('okf_evidence_chunks').docs[0].content = 'tampered';
  await rejectsCode(() => loadPinnedOkfRelease(db as any, ref), 'collection_checksum_mismatch');
});

await test('production publication requires a transactional database session', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const { index: _index, evaluation: _evaluation, ...draft } = buildOkfContent();
    const scope = { tenantId: 'placemakers', environmentId: 'production', releaseId: 'okf-placemakers-no-session', evaluatedAt: '2026-10-01T00:00:00.000Z' };
    const content = buildServerOwnedOkfContent(draft, scope);
    await rejectsCode(() => publishOkfRelease(new MemoryDb() as any, {
      releaseId: 'okf-placemakers-no-session', tenantId: 'placemakers',
      environmentId: 'production', version: '1.0.0', content,
      evaluationScenarios: evaluateOkfDraft(draft, scope.tenantId, scope.environmentId, scope.releaseId, scope.evaluatedAt),
      publishedBy: 'test',
    }), 'transaction_unavailable');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

await test('production publication rejects client-only evaluation without server scenarios', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await rejectsCode(() => publishOkfRelease(new MemoryDb() as any, {
      releaseId: 'okf-client-evaluation', tenantId: 'placemakers', environmentId: 'production',
      version: '1.0.0', content: buildOkfContent(), publishedBy: 'test',
    }), 'evaluation_missing');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

await test('publication hashes and stores the same parsed representation when defaults are omitted', async () => {
  const db = new MemoryDb();
  const raw = buildOkfContent() as any;
  const defaultedConcept = raw.concepts.find((concept: any) => concept.synonyms.length === 0);
  delete defaultedConcept.synonyms;
  const release = await publishOkfRelease(db as any, {
    releaseId: 'okf-placemakers-defaults', tenantId: 'placemakers', environmentId: 'production', version: '1.0.1', content: raw, publishedBy: 'test',
  });
  assert.deepEqual(release.content.concepts.find((concept) => concept.conceptId === defaultedConcept.conceptId)?.synonyms, []);
  assert.equal(release.checksum, computeKnowledgeChecksum(release.content));
  assert.doesNotThrow(() => verifyOkfReleaseEnvelope(release));
});

await test('identical publication is idempotent and modified immutable release is rejected', async () => {
  const db = new MemoryDb();
  const content = buildOkfContent();
  const input = { releaseId: 'okf-placemakers-1.0.0', tenantId: 'placemakers', environmentId: 'production' as const, version: '1.0.0', content, publishedBy: 'test' };
  await publishOkfRelease(db as any, input);
  await publishOkfRelease(db as any, input);
  assert.equal(db.collection('okf_releases').docs.length, 1);
  const changed = buildOkfContent() as any;
  changed.extensions = { revision: 2 };
  await rejectsCode(() => publishOkfRelease(db as any, { ...input, content: changed }), 'reference_checksum_mismatch');
});

await test('pinned loader ignores unrelated releases and returns exact ready release', async () => {
  const db = new MemoryDb();
  const content = buildOkfContent();
  const release = await publishOkfRelease(db as any, { releaseId: 'okf-placemakers-1.0.0', tenantId: 'placemakers', environmentId: 'production', version: '1.0.0', content, publishedBy: 'test' });
  db.collection('okf_releases').docs.push({ ...release, releaseId: 'okf-placemakers-2.0.0', version: '2.0.0' });
  const loaded = await loadPinnedOkfRelease(db as any, { tenantId: 'placemakers', environmentId: 'production', releaseId: release.releaseId, version: release.version, checksum: release.checksum });
  assert.equal(loaded.release.releaseId, 'okf-placemakers-1.0.0');
});

await test('pinned loader rejects cross-tenant, wrong checksum, and non-ready releases', async () => {
  const db = new MemoryDb();
  const content = buildOkfContent();
  const release = await publishOkfRelease(db as any, { releaseId: 'okf-placemakers-1.0.0', tenantId: 'placemakers', environmentId: 'production', version: '1.0.0', content, publishedBy: 'test' });
  await rejectsCode(() => loadPinnedOkfRelease(db as any, { tenantId: 'other', environmentId: 'production', releaseId: release.releaseId, version: release.version, checksum: release.checksum }), 'not_found');
  await rejectsCode(() => loadPinnedOkfRelease(db as any, { tenantId: 'placemakers', environmentId: 'production', releaseId: release.releaseId, version: release.version, checksum: 'f'.repeat(64) }), 'reference_checksum_mismatch');
  db.collection('okf_releases').docs[0].status = 'retired';
  await rejectsCode(() => loadPinnedOkfRelease(db as any, { tenantId: 'placemakers', environmentId: 'production', releaseId: release.releaseId, version: release.version, checksum: release.checksum }), 'not_ready');
});

await test('revocation event stream is append-only and active created event is returned', async () => {
  const db = new MemoryDb();
  const created = await appendOkfRevocationEvent(db as any, {
    revocationId: 'rev-1', eventType: 'created', tenantId: 'placemakers', environmentId: 'production', releaseId: 'okf-placemakers-1.0.0', conceptIds: [conceptId('problems/bathroom-leak')], cascade: 'descendants', effect: { suppressClaims: true, suppressRetrieval: true }, reason: 'safety correction', createdBy: 'safety-owner', expiresAt: new Date('2026-10-20T00:00:00.000Z'),
  });
  assert.equal(created.eventType, 'created');
  const active = await loadActiveOkfRevocations(db as any, 'placemakers', 'production', 'okf-placemakers-1.0.0', new Date('2026-10-10T00:00:00.000Z'));
  assert.equal(active.length, 1);
  assert.equal(db.collection('okf_revocation_events').docs.length, 1);
});

await test('lifting a revocation preserves history and removes it from active head', async () => {
  const db = new MemoryDb();
  const common = { revocationId: 'rev-1', tenantId: 'placemakers', environmentId: 'production' as const, releaseId: 'okf-placemakers-1.0.0', conceptIds: [conceptId('problems/bathroom-leak')], cascade: 'descendants' as const, effect: { suppressClaims: true, suppressRetrieval: true }, reason: 'safety correction', createdBy: 'safety-owner', expiresAt: new Date('2026-10-20T00:00:00.000Z') };
  await appendOkfRevocationEvent(db as any, { ...common, eventType: 'created', createdAt: new Date('2026-10-09T00:00:00.000Z') });
  await appendOkfRevocationEvent(db as any, { ...common, eventType: 'lifted', eventId: 'lift-1', createdAt: new Date('2026-10-10T00:00:00.000Z'), correctedReleaseId: 'okf-placemakers-1.0.1' });
  assert.equal(db.collection('okf_revocation_events').docs.length, 2);
  const active = await loadActiveOkfRevocations(db as any, 'placemakers', 'production', undefined, new Date('2026-10-11T00:00:00.000Z'));
  assert.equal(active.length, 0);
});

await test('invalid revocation expiry and invalid transition fail closed', async () => {
  const db = new MemoryDb();
  const base = { revocationId: 'rev-x', tenantId: 'placemakers', environmentId: 'production' as const, conceptIds: [conceptId('problems/bathroom-leak')], cascade: 'none' as const, effect: { suppressClaims: true, suppressRetrieval: true }, reason: 'test', createdBy: 'owner' };
  await rejectsCode(() => appendOkfRevocationEvent(db as any, { ...base, eventType: 'created', createdAt: new Date('2026-10-10T00:00:00.000Z'), expiresAt: new Date('2026-10-09T00:00:00.000Z') }), 'invalid_expiry');
  await rejectsCode(() => appendOkfRevocationEvent(db as any, { ...base, eventType: 'lifted', createdAt: new Date('2026-10-10T00:00:00.000Z'), expiresAt: new Date('2026-10-20T00:00:00.000Z') }), 'invalid_transition');
});

await test('unresolved relationships, hierarchy cycles, and cross-tenant concepts fail semantic validation', () => {
  const content = buildOkfContent() as any;
  content.relationships[0].to = 'concept://other/foreign';
  content.relationships[0].contentHash = computeKnowledgeChecksum(content.relationships[0]);
  const result = validateOkfReleaseContent(content, 'placemakers');
  assert.equal(result.valid, false);
  assert.equal(result.issues.some((issue) => ['unresolved_relationship', 'cross_tenant_relationship'].includes(issue.code)), true);
});

await test('verified records fail closed without target-declared sources or a resolvable target', () => {
  const missingSources = buildOkfContent() as any;
  missingSources.relationships.find((entry: any) => entry.relationshipId === 'rel-leak-safety').sourceRefs = [];
  missingSources.relationships.find((entry: any) => entry.relationshipId === 'rel-leak-safety').contentHash =
    computeKnowledgeEntityHash(missingSources.relationships.find((entry: any) => entry.relationshipId === 'rel-leak-safety'));
  missingSources.verifications.find((entry: any) => entry.recordId === 'verify-leak-safety').contentHash =
    missingSources.relationships.find((entry: any) => entry.relationshipId === 'rel-leak-safety').contentHash;
  const sourceResult = validateOkfReleaseContent(missingSources, 'placemakers');
  assert.equal(sourceResult.issues.some((issue) => issue.code === 'verification_missing_sources'), true);

  const orphan = buildOkfContent() as any;
  orphan.verifications.push({ ...orphan.verifications[0], recordId: 'orphan-verification', targetId: 'missing-target' });
  const orphanResult = validateOkfReleaseContent(orphan, 'placemakers');
  assert.equal(orphanResult.issues.some((issue) => issue.code === 'unresolved_verification_target'), true);
});

await test('evidence chunks must bind to a release source, concepts, and their exact content hash', () => {
  const missingSource = buildOkfContent() as any;
  missingSource.evidenceChunks[0].sourceRef = 'missing-source';
  missingSource.evidenceChunks[0].contentHash = computeKnowledgeEntityHash(missingSource.evidenceChunks[0]);
  assert.equal(validateOkfReleaseContent(missingSource, 'placemakers').issues.some((issue) => issue.code === 'unresolved_source'), true);

  const tampered = buildOkfContent() as any;
  tampered.evidenceChunks[0].content = 'tampered without updating hash';
  assert.equal(validateOkfReleaseContent(tampered, 'placemakers').issues.some((issue) => issue.code === 'content_hash_mismatch'), true);
});

assert.equal(passed, 20);
console.log(`✅ OKF release suite: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
