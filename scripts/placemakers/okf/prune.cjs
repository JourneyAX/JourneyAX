// Removes new concepts that make the coverage evaluation fail, until none do. Knowledge only: never touches existing concepts.
const fs = require('fs'); const K = require('@journeyax/knowledge');
const REPO = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/Caroma-Poc/journeyAX';
const [, , IN, OUT, ...adds] = process.argv;
const draft = JSON.parse(fs.readFileSync(IN, 'utf8'));
const newIds = new Set(); const newSources = new Set();
for (const f of adds) { const a = JSON.parse(fs.readFileSync(f, 'utf8')); a.concepts.forEach((c) => newIds.add(c.conceptId)); a.sources.forEach((s) => newSources.add(s.sourceId)); }
const snapFile = fs.readdirSync(REPO + '/docs/inventory').filter((n) => /^placemakers-taxonomy-snapshot-.*\.json$/.test(n)).sort().pop();
const snap = JSON.parse(fs.readFileSync(REPO + '/docs/inventory/' + snapFile, 'utf8'));
const scen = JSON.parse(fs.readFileSync(REPO + '/scripts/okf/tenants/placemakers.scenarios.json', 'utf8'));
const dropped = [];
for (let round = 1; round <= 8; round++) {
  const res = K.evaluateCoverage(draft, { tenantId: 'placemakers', now: new Date(), catalogue: snap.rows.map((r) => ({ path: r.path, category: r.category, products: r.productCount })), acceptedRoutingCollisions: scen.acceptedRoutingCollisions });
  const failures = res.report.failures || [];
  const bad = new Set();
  for (const f of failures) { const m = JSON.stringify(f); for (const id of newIds) if (m.includes(id) && draft.concepts.some((c) => c.conceptId === id)) bad.add(id); }
  console.log(`round ${round}: scenarios ${res.report.totals.scenarios}, failed ${res.report.totals.failed}, new concepts implicated ${bad.size}`);
  if (!bad.size) { if (res.report.totals.failed) console.log('REMAINING failures not involving new concepts:', res.report.totals.failed); break; }
  for (const id of bad) dropped.push(id);
  draft.concepts = draft.concepts.filter((c) => !bad.has(c.conceptId));
  const gone = (id) => bad.has(id);
  draft.relationships = draft.relationships.filter((r) => !gone(r.from) && !gone(r.to));
  draft.evidenceChunks = draft.evidenceChunks.filter((c) => !c.conceptIds.some(gone));
  const liveSources = new Set(draft.concepts.flatMap((c) => c.evidenceRefs));
  draft.sources = draft.sources.filter((s) => !newSources.has(s.sourceId) || liveSources.has(s.sourceId));
  const relIds = new Set(draft.relationships.map((r) => r.relationshipId));
  draft.verifications = draft.verifications.filter((v) => v.targetType !== 'relationship' || relIds.has(v.targetId));
}
fs.writeFileSync(OUT, JSON.stringify(draft));
console.log(JSON.stringify({ dropped: dropped.length, concepts: draft.concepts.length, relationships: draft.relationships.length, sources: draft.sources.length, chunks: draft.evidenceChunks.length, verifications: draft.verifications.length, bytes: fs.statSync(OUT).size }));
console.log('dropped sample:', dropped.slice(0, 8).join(' | '));
