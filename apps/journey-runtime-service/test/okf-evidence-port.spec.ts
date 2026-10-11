import assert from 'node:assert/strict';
import { publishOkfRelease } from '@journeyax/knowledge';
import { MongoOkfKnowledgeRetrievalPort } from '../src/infrastructure/mongo-okf-knowledge.port';
import { KnowledgeSearchHandler } from '../src/capabilities/handlers/knowledge-search.handler';
import { buildOkfContent, conceptId } from '../../../packages/knowledge/test/fixtures';

function matches(doc: any, query: any): boolean {
  return Object.entries(query || {}).every(([key, expected]: [string, any]) => {
    if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.includes(doc[key]);
    return doc[key] === expected;
  });
}

class MemoryCursor {
  private max = Number.MAX_SAFE_INTEGER;
  constructor(private readonly docs: any[]) {}
  sort(spec: Record<string, number>) {
    const [key, direction] = Object.entries(spec)[0];
    this.docs.sort((a, b) => ((a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * direction));
    return this;
  }
  limit(value: number) { this.max = value; return this; }
  async toArray() { return this.docs.slice(0, this.max).map((doc) => ({ ...doc })); }
}

class MemoryCollection {
  docs: any[] = [];
  async findOne(query: any) { return this.docs.find((doc) => matches(doc, query)) || null; }
  async insertOne(doc: any) { this.docs.push({ ...doc }); return { acknowledged: true }; }
  async insertMany(docs: any[]) { this.docs.push(...docs.map((doc) => ({ ...doc }))); return { acknowledged: true }; }
  find(query: any) { return new MemoryCursor(this.docs.filter((doc) => matches(doc, query))); }
}

class MemoryDb {
  private readonly collections = new Map<string, MemoryCollection>();
  collection(name: string): MemoryCollection {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name)!;
  }
}

async function main() {
  console.log('🧠 Running canonical OKF evidence-port suite...');
  let passed = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    await fn();
    passed++;
    console.log(`  ✅ PASS: ${name}`);
  };

  const db = new MemoryDb();
  const content = buildOkfContent();
  const release = await publishOkfRelease(db as any, {
    releaseId: 'okf-placemakers-1.0.0',
    tenantId: 'placemakers',
    environmentId: 'production',
    version: '1.0.0',
    content,
    publishedBy: 'test',
  });
  const port = new MongoOkfKnowledgeRetrievalPort(async () => db as any);
  const request = {
    query: 'care instructions',
    limit: 5,
    knowledgeScope: {
      releaseId: release.releaseId,
      version: release.version,
      checksum: release.checksum,
      conceptIds: [conceptId('care/matte-black-tapware')],
      sourceRefs: ['src-trade-guide'],
      requestedClaimClass: 'care_safety',
    },
  };

  await test('exact tenant/environment/release/source scope returns published evidence', async () => {
    db.collection('okf_evidence_chunks').docs.unshift(...Array.from({ length: 25 }, (_, index) => ({
      tenantId: 'placemakers', environmentId: 'production', releaseId: release.releaseId,
      chunkId: `unscoped-${index}`, sourceRef: 'src-trade-guide', content: 'must never be read',
    })));
    const result = await port.search(
      { tenantId: 'placemakers', environmentId: 'production', correlationId: 'corr-1' },
      request
    );
    assert.equal(result.found, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].sourceId, 'src-trade-guide');
    assert.equal(result.results[0].releaseId, release.releaseId);
    db.collection('okf_evidence_chunks').docs.splice(0, 25);
  });

  await test('tampered normalized index text fails the release checksum before retrieval', async () => {
    db.collection('okf_evidence_chunks').docs[0].content = 'tampered runtime text';
    await assert.rejects(() => port.search(
      { tenantId: 'placemakers', environmentId: 'production', correlationId: 'corr-2' },
      request
    ), (error: any) => error.code === 'collection_checksum_mismatch');
    db.collection('okf_evidence_chunks').docs[0].content = content.evidenceChunks[0].content;
  });

  await test('cross-tenant and wrong-checksum access fail before index results are returned', async () => {
    await assert.rejects(() => port.search(
      { tenantId: 'other-tenant', environmentId: 'production', correlationId: 'corr-3' },
      request
    ));
    await assert.rejects(() => port.search(
      { tenantId: 'placemakers', environmentId: 'production', correlationId: 'corr-4' },
      { ...request, knowledgeScope: { ...request.knowledgeScope, checksum: 'f'.repeat(64) } }
    ));
  });

  await test('claim-class and concept allow-lists fail closed when the chunk is out of scope', async () => {
    const wrongClaim = await port.search(
      { tenantId: 'placemakers', environmentId: 'production', correlationId: 'corr-5' },
      { ...request, knowledgeScope: { ...request.knowledgeScope, requestedClaimClass: 'warranty' } }
    );
    assert.equal(wrongClaim.found, false);
    const wrongConcept = await port.search(
      { tenantId: 'placemakers', environmentId: 'production', correlationId: 'corr-6' },
      { ...request, knowledgeScope: { ...request.knowledgeScope, conceptIds: [conceptId('fastenings/screws')] } }
    );
    assert.equal(wrongConcept.found, false);
  });

  await test('retrieval failure never exposes raw connection details to the customer result', async () => {
    const handler = new KnowledgeSearchHandler(undefined, async () => {
      throw new Error('mongodb://user:password@private-host/internal');
    });
    const result = await handler.execute({ query: 'care', knowledgeScope: request.knowledgeScope }, {
      tenantId: 'placemakers', environmentId: 'production', correlationId: 'corr-error',
    } as any);
    assert.equal(result.found, false);
    assert.doesNotMatch(result.message, /password|private-host|mongodb:\/\//);
  });

  assert.equal(passed, 5);
  console.log(`✅ Canonical OKF evidence-port suite: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
