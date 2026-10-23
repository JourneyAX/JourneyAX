// Replaces lone UTF-16 surrogates (they come from broken PDF text) with U+FFFD, which is what a database stores anyway, then re-binds
// every content hash. Without this, a draft passes in memory and fails the integrity check after a round trip through the database.
//   node sanitize-draft.cjs <in.json> <out.json>
const fs = require('fs');
const REPO = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/Caroma-Poc/journeyAX';
const K = require(REPO + '/node_modules/@journeyax/knowledge');
const BAD = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
let fixed = 0;
const clean = (v) => { if (typeof v === 'string') { const o = v.replace(BAD, '�'); if (o !== v) fixed++; return o; } if (Array.isArray(v)) return v.map(clean); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])); return v; };
const d = clean(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
let rebound = 0;
for (const key of ['concepts', 'relationships', 'evidenceChunks']) d[key] = d[key].map((e) => { const h = K.computeKnowledgeEntityHash(e); if (e.contentHash !== h) rebound++; return { ...e, contentHash: h }; });
const relHash = new Map(d.relationships.map((r) => [r.relationshipId, r.contentHash]));
d.verifications = d.verifications.map((v) => (v.targetType === 'relationship' && relHash.has(v.targetId) ? { ...v, contentHash: relHash.get(v.targetId) } : v));
fs.writeFileSync(process.argv[3], JSON.stringify(d));
console.log(JSON.stringify({ stringsFixed: fixed, hashesRebound: rebound, concepts: d.concepts.length, chunks: d.evidenceChunks.length }));
