// Read-only: loads the active placemakers OKF release, merges the generated additions, validates, reports size.
const fs = require('fs');
const K = require('@journeyax/knowledge');
const REPO = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/Caroma-Poc/journeyAX';
const { MongoClient } = require(REPO + '/node_modules/mongodb');
const [, , OUT, ...adds] = process.argv;
const env = {};
for (const line of fs.readFileSync(REPO + '/.env', 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
(async () => {
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB_NAME || 'journeyx');
  const stored = await db.collection('okf_releases').findOne({ tenantId: 'placemakers', environmentId: 'production', releaseId: 'okf-placemakers-production-1.7.0' });
  const { release } = await K.loadPinnedOkfRelease(db, { tenantId: 'placemakers', environmentId: 'production', releaseId: stored.releaseId, version: stored.version, checksum: stored.checksum });
  await client.close();
  const base = release.content;
  const draft = JSON.parse(JSON.stringify(base)); delete draft.index; delete draft.evaluation;
  console.log('base 1.7.0:', { concepts: base.concepts.length, rels: base.relationships.length, sources: base.sources.length, chunks: base.evidenceChunks.length, verifs: base.verifications.length, scenarios: (base.acceptanceScenarios || []).length, hasPolicy: !!base.policy, bytes: JSON.stringify(draft).length });
  for (const f of adds) {
    const a = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const key of ['concepts', 'sources', 'evidenceChunks', 'relationships', 'verifications']) draft[key] = [...draft[key], ...a[key]];
  }
  const bytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
  const v = K.validateOkfDraftContent(draft, 'placemakers');
  console.log('merged:', { concepts: draft.concepts.length, rels: draft.relationships.length, sources: draft.sources.length, chunks: draft.evidenceChunks.length, verifs: draft.verifications.length, bytes, limitBytes: 12582912, underLimit: bytes < 12582912 });
  console.log('valid:', v.valid, 'issues:', (v.issues || []).length);
  const byCode = {}; (v.issues || []).forEach((i) => { byCode[i.code] = (byCode[i.code] || 0) + 1; }); console.log(JSON.stringify(byCode));
  (v.issues || []).slice(0, 8).forEach((i) => console.log(' -', i.code, i.path, String(i.message).slice(0, 160)));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(draft));
})().catch((e) => { console.error('failed:', e.stack || e.message); process.exit(1); });
