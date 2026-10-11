import assert from 'node:assert/strict';
import {
  archiveOkfBundle,
  assertOkfReferenceReady,
  computeKnowledgeEntityHash,
  exportOkfBundle,
  GcsOkfArtifactStore,
  importOkfBundle,
  MemoryOkfArtifactStore,
  okfArtifactChecksum,
  processOkfExport,
  readOkfZip,
  validateOkfReleaseContent,
} from '../src';
import { buildStoredOkfRelease } from './fixtures';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const yaml = require('js-yaml') as { load(source: string): any; dump(value: unknown): string };
const release = buildStoredOkfRelease();

function frontmatter(source: string): any {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  assert.ok(match, 'non-reserved Markdown needs frontmatter');
  return yaml.load(match[1]);
}

function centralOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(bytes.length - 6, true);
}

function fakeDb() {
  const collections = new Map<string, any[]>();
  collections.set('okf_releases', [structuredClone(release)]);
  return {
    collection(name: string) {
      if (!collections.has(name)) collections.set(name, []);
      const docs = collections.get(name)!;
      return {
        docs,
        async findOne(query: Record<string, unknown>) {
          return docs.find((doc) => Object.entries(query).every(([key, value]) => doc[key] === value)) || null;
        },
        find() { return { sort() { return { async toArray() { return []; } }; } }; },
        async updateOne(query: Record<string, unknown>, update: any) {
          const doc = docs.find((row) => Object.entries(query).every(([key, value]) =>
            key === 'artifact.status' ? row.artifact?.status !== (value as any).$ne : row[key] === value));
          if (!doc) return { matchedCount: 0 };
          Object.assign(doc, update.$set);
          return { matchedCount: 1 };
        },
      };
    },
  };
}

async function main() {
  const files = exportOkfBundle(release);
  const paths = Object.keys(files).sort();
  assert.equal(paths.filter((path) => path.endsWith('.md') && !/\/(?:index|log)\.md$/.test(`/${path}`)).length, release.content.concepts.length);
  assert.equal(frontmatter(decoder.decode(files['index.md'])).okf_version, '0.2');
  assert.match(decoder.decode(files['log.md']), /^# Directory Update Log\n\n## 2026-10-01\n/);
  for (const path of paths.filter((path) => path.endsWith('.md') && !['index.md', 'log.md'].includes(path.split('/').at(-1)!))) {
    const parsed = frontmatter(decoder.decode(files[path]));
    assert.equal(typeof parsed.type, 'string');
    assert.ok(parsed.type.length > 0);
    assert.ok(Array.isArray(parsed['x-journeyax-relationships']));
  }
  assert.deepEqual(exportOkfBundle(release), files, 'export is deterministic');
  const archive = archiveOkfBundle(files);
  assert.deepEqual(archiveOkfBundle(files), archive, 'ZIP is deterministic');
  const originalLocaleCompare = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = function (other: string) {
      return -originalLocaleCompare.call(this, other);
    };
    assert.equal(okfArtifactChecksum(archiveOkfBundle(exportOkfBundle(release))), okfArtifactChecksum(archive), 'export bytes must not depend on node locale ordering');
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
  assert.deepEqual(readOkfZip(archive), files);

  const imported = importOkfBundle(archive, 'placemakers');
  assert.equal(imported.declaredVersion, '0.2');
  assert.deepEqual(exportOkfBundle(imported), files, 'own export → import → export preserves exact bytes');
  assert.equal(imported.draft.concepts.length, release.content.concepts.length);
  assert.equal(imported.draft.relationships.length, release.content.relationships.length);
  assert.equal(imported.draft.sources.length, release.content.sources.length);
  assert.equal(imported.draft.evidenceChunks.length, release.content.evidenceChunks.length);
  assert.equal(imported.draft.factRegistry.length, release.content.factRegistry.length);
  assert.deepEqual(
    imported.draft.concepts.map((concept) => [concept.conceptId, concept.type, concept.name, concept.description]).sort(),
    release.content.concepts.map((concept: any) => [concept.conceptId, concept.type, concept.name, concept.description]).sort(),
  );
  assert.deepEqual(
    imported.draft.relationships.map((relation) => [relation.from, relation.to, relation.type, relation.strength, relation.scope]).sort(),
    release.content.relationships.map((relation: any) => [relation.from, relation.to, relation.type, relation.strength, relation.scope]).sort(),
  );
  assert.deepEqual(imported.draft.verifications, [], 'import never carries approval');
  assert.equal(imported.draft.evaluation.passed, false);
  assert.ok(imported.draft.concepts.every((concept) => concept.commercePolicy.checkout === 'blocked' && !concept.verificationRef));

  const foreign = {
    'Weird Name.md': encoder.encode('---\ntype: Attested Computation\ntitle: Foreign\nnew_field: {alpha: 42}\n---\n# Foreign\n\nSee [child](sub/child.md).\n'),
    'sub/child.md': encoder.encode('---\ntype: Mystic Item\ntitle: Child\n---\n# Child\n\n[broken](gone.md)\n'),
  };
  const importedForeign = importOkfBundle(archiveOkfBundle(foreign), 'placemakers');
  assert.deepEqual(Object.fromEntries(Object.entries(exportOkfBundle(importedForeign))), foreign);
  const foreignConcept = importedForeign.draft.concepts.find((concept) => concept.interchange?.path === 'Weird Name.md')!;
  assert.equal(foreignConcept.type, 'unknown');
  assert.equal(foreignConcept.interchange?.originalType, 'Attested Computation');
  assert.deepEqual(foreignConcept.interchange?.frontmatterExtras.new_field, { alpha: 42 });
  const altered = structuredClone(foreignConcept);
  altered.interchange!.frontmatterExtras.new_field = { alpha: 43 };
  assert.notEqual(
    computeKnowledgeEntityHash(altered),
    foreignConcept.contentHash,
    'interchange extras must participate in the entity hash',
  );
  assert.equal(importedForeign.draft.relationships.length, 1);
  assert.equal(importedForeign.draft.relationships[0].type, 'relevant_to');
  assert.equal(importedForeign.diagnostics.some((line) => line.includes('Broken link')), true);

  const untrustedControl = structuredClone(release.content.concepts[0]);
  untrustedControl.riskClass = 'standard';
  untrustedControl.lens = 'product';
  untrustedControl.journeyRef = { journeyId: 'attacker-journey' };
  untrustedControl.searchScope = { catalogCategoryIds: ['attacker-category'], enrichmentFacets: [], excludeCategoryIds: [] };
  const hostile = importOkfBundle({
    'hostile.md': encoder.encode(`---\n${yaml.dump({ type: 'Product Guide', title: 'Hostile', 'x-journeyax-concept': untrustedControl })}---\n# Hostile\n`),
  }, 'placemakers');
  assert.equal(hostile.draft.concepts[0].riskClass, 'safety_critical');
  assert.equal(hostile.draft.concepts[0].journeyRef, undefined);
  assert.deepEqual(hostile.draft.concepts[0].searchScope.catalogCategoryIds, []);
  assert.equal(hostile.draft.concepts[0].interchange?.controlFields?.journeyRef?.journeyId, 'attacker-journey');
  assert.ok(hostile.diagnostics.some((line) => line.includes('requires review')));
  assert.ok(validateOkfReleaseContent(hostile.draft, 'placemakers').issues.some((issue) => issue.code === 'import_review_required'));

  const withReadme = importOkfBundle({
    'README.md': encoder.encode('# About this bundle\n'),
    'valid.md': encoder.encode('---\ntype: Product Guide\ntitle: Valid\n---\n# Valid\n'),
  }, 'placemakers');
  assert.equal(withReadme.draft.concepts.length, 1);
  assert.ok(withReadme.diagnostics.some((line) => line.includes('README.md')));

  const foreignStandardSource = `---\ntype: Product Guide\ntitle: Foreign standard fields\ndescription: Imported source text\nresource: https://example.test/manual.pdf\ntags: [wet-area, verified-catalog]\nsources:\n  - id: supplier-guide\n    title: Supplier guide\n    resource: https://example.test/source.pdf\ngenerated:\n  by: gemini/1.0\n  at: '2026-09-01T00:00:00Z'\nstatus: draft\nstale_after: '2027-01-01T00:00:00Z'\n---\n# Original body\n`;
  const foreignStandard = importOkfBundle({ 'foreign.md': encoder.encode(foreignStandardSource) }, 'placemakers');
  const persistedExport = exportOkfBundle({ ...release, content: foreignStandard.draft });
  const originalStandard = frontmatter(foreignStandardSource);
  const roundTrippedStandard = frontmatter(decoder.decode(persistedExport['foreign.md']));
  for (const key of ['tags', 'resource', 'sources', 'generated', 'status', 'stale_after']) {
    assert.deepEqual(roundTrippedStandard[key], originalStandard[key], `foreign ${key} must survive a persisted export`);
  }
  assert.equal(foreignStandard.draft.concepts[0].interchange?.bodyMarkdown, '# Original body\n');
  const studioRelease = { ...release, publishedBy: 'studio' };
  const studioExport = exportOkfBundle(studioRelease);
  const studioConceptPath = Object.keys(studioExport).find((entry) => entry.endsWith('.md') && !/(?:^|\/)(?:index|log)\.md$/.test(entry))!;
  assert.equal(frontmatter(decoder.decode(studioExport[studioConceptPath])).generated.by, 'process:studio');

  // Condensed frontmatter from the canonical upstream GA4 events_ sample bundle.
  // https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/bundles/ga4/tables/events_.md
  const upstreamSample = encoder.encode(`---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/ga4_obfuscated_sample_ecommerce/tables/events_*
title: GA4 Events Export
description: Google Analytics 4 event-level daily sharded export tables containing user interaction logs.
tags:
- analytics
- e-commerce
- ga4
generated:
  by: reference_agent/gemini-3.5-flash
  at: '2026-07-10T21:15:20+00:00'
sources:
- title: 'Google Analytics Help: BigQuery Export Schema'
  id: ga4-export-docs
  resource: https://support.google.com/analytics/answer/7029846
---
# Schema

See [metrics](../references/metrics/purchasers.md).
`);
  const upstream = importOkfBundle({ 'tables/events_.md': upstreamSample }, 'placemakers');
  assert.equal(upstream.draft.concepts[0].type, 'unknown');
  assert.equal(upstream.draft.concepts[0].interchange?.originalType, 'BigQuery Table');
  assert.equal(upstream.diagnostics.some((item) => item.includes('Broken link')), true);
  assert.deepEqual(exportOkfBundle(upstream)['tables/events_.md'], upstreamSample);

  const base = archiveOkfBundle({ 'a/bb.md': encoder.encode('---\ntype: test\n---\nbody\n') });
  const traversal = new Uint8Array(base);
  traversal.set(encoder.encode('../x.md'), centralOffset(traversal) + 46);
  assert.throws(() => readOkfZip(traversal), /Unsafe OKF path/);
  const symlink = new Uint8Array(base);
  new DataView(symlink.buffer).setUint32(centralOffset(symlink) + 38, 0xa0000000, true);
  assert.throws(() => readOkfZip(symlink), /symlink/);
  const oversized = new Uint8Array(base);
  new DataView(oversized.buffer).setUint32(centralOffset(oversized) + 24, 9 * 1024 * 1024, true);
  assert.throws(() => readOkfZip(oversized), /limits/);
  const ratio = new Uint8Array(base);
  new DataView(ratio.buffer).setUint32(centralOffset(ratio) + 20, 1, true);
  new DataView(ratio.buffer).setUint32(centralOffset(ratio) + 24, 200, true);
  assert.throws(() => readOkfZip(ratio), /limits/);
  const nested = new Uint8Array(base);
  nested.set(encoder.encode('a/b.zip'), centralOffset(nested) + 46);
  nested.set(encoder.encode('a/b.zip'), 30);
  assert.throws(() => readOkfZip(nested), /Nested archive/);

  const db = fakeDb();
  const ref = { tenantId: 'placemakers', environmentId: 'production', releaseId: release.releaseId, version: release.version, checksum: release.checksum };
  const scope = { tenantId: ref.tenantId, environmentId: ref.environmentId };
  assert.equal((await assertOkfReferenceReady(db as any, ref, scope)).releaseId, release.releaseId);
  db.collection('okf_artifact_policies').docs.push({ tenantId: 'placemakers', environmentId: 'production', artifactRequired: true });
  await assert.rejects(() => assertOkfReferenceReady(db as any, ref, scope), /artifact/i);
  const store = new MemoryOkfArtifactStore();
  const first = await processOkfExport(db as any, store, ref);
  assert.equal(first.checksum, okfArtifactChecksum(archive));
  assert.deepEqual(await processOkfExport(db as any, store, ref), first, 'retry is idempotent');
  assert.equal((await (assertOkfReferenceReady as any)(db, ref, scope, undefined, store)).artifact?.status, 'ready');
  await assert.rejects(
    () => (assertOkfReferenceReady as any)(db, ref, scope, undefined, { verify: async () => false }),
    /artifact/i,
    'activation must verify the actual immutable object, not only database metadata',
  );
  db.collection('okf_releases').docs[0].artifact.verifiedChecksum = 'f'.repeat(64);
  await assert.rejects(() => assertOkfReferenceReady(db as any, ref, scope), /artifact/i);

  const originalFetch = globalThis.fetch;
  let uploadUrl = '';
  try {
    globalThis.fetch = (async (url: any) => {
      uploadUrl = String(url);
      return new Response('{}', { status: 200 });
    }) as any;
    const gcs = new GcsOkfArtifactStore('isolated-test', async () => 'fake-token');
    await gcs.put('placemakers/test/release/checksum/bundle.zip', archive, first.checksum);
    assert.match(uploadUrl, /ifGenerationMatch=0/);
  } finally { globalThis.fetch = originalFetch; }
  console.log('✅ OKF interchange suite passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
