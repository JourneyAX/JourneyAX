// Installation / care / warranty PDF knowledge from the Placemaker-data crawl ONLY. No database writes.
//   node build-pdf-knowledge.cjs <out.json>
const fs = require('fs');
const crypto = require('crypto');
const K = require('@journeyax/knowledge');
const REPO = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/Caroma-Poc/journeyAX';
const { MongoClient } = require(REPO + '/node_modules/mongodb');
const DATA = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/jax-whatsapp-open-model/Placemaker-data';
const OUT = process.argv[2];
const TENANT = 'placemakers';
const OWNER = 'mahaveer.it@gmail.com';
const NOW = new Date().toISOString();
const STALE = new Date(Date.now() + 365 * 86400000).toISOString();
const env = {};
for (const line of fs.readFileSync(REPO + '/.env', 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const slug = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'doc';
const LS = new RegExp(String.fromCharCode(91, 92, 117, 50, 48, 50, 56, 92, 117, 50, 48, 50, 57, 93), 'g');
const clean = (s) => String(s || '').replace(LS, ' ').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function eachLine(file, cb) { return new Promise((res, rej) => { let rest = ''; const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }); const take = (l) => { if (l) cb(l); }; rs.on('data', (d) => { rest += d; let i; while ((i = rest.indexOf('\n')) >= 0) { take(rest.slice(0, i)); rest = rest.slice(i + 1); } }); rs.on('end', () => { take(rest); res(); }); rs.on('error', rej); }); }
const KINDS = [
  { kind: 'installation', re: /install|fixing|assembly|fitting|how.?to/i, claims: ['installation_step'], conceptType: 'installation', label: 'Installation guide' },
  { kind: 'care', re: /\bcare\b|maintenance|cleaning/i, claims: ['care_safety'], conceptType: 'care', label: 'Care and maintenance guide' },
  { kind: 'warranty', re: /warrant|guarantee/i, claims: ['warranty'], conceptType: 'document_family', label: 'Warranty document' },
];
function chunkText(text) {
  const paras = clean(text).split(/\n{2,}|\n(?=[A-Z0-9][^\n]{0,60}\n)/); const out = []; let buf = '';
  for (const p of paras) { if ((buf + '\n' + p).length > 1300) { if (buf.length >= 120) out.push(buf); buf = ''; } if (p.length > 1300) { for (let i = 0; i < p.length; i += 1250) out.push(p.slice(i, i + 1250)); continue; } buf += (buf ? '\n' : '') + p; }
  if (buf.length >= 120) out.push(buf); return out;
}
(async () => {
  const docToSkus = new Map(); const skuPath = new Map(); const skuName = new Map();
  await eachLine(DATA + '/master/placemakers_product_master.jsonl', (l) => { try { const o = JSON.parse(l); const sku = String(o.sku); const pa = Array.isArray(o.categoryPathNames) && Array.isArray(o.categoryPathNames[0]) ? o.categoryPathNames[0].map(String) : null; if (pa) skuPath.set(sku, pa); skuName.set(sku, o.title || o.name || ''); for (const d of o.documents || []) { if (d && d.url && /\.pdf/i.test(d.url)) { const k = d.url.split('?')[0]; if (!docToSkus.has(k)) docToSkus.set(k, []); docToSkus.get(k).push(sku); } } } catch {} });

  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const existing = await client.db(env.MONGODB_DB_NAME || 'journeyx').collection('okf_concepts').find({ tenantId: TENANT, releaseId: 'okf-placemakers-production-1.7.0' }, { projection: { conceptId: 1, searchScope: 1 } }).toArray();
  await client.close();
  const pathMap = new Map();
  for (const c of existing) for (const pa of (c.searchScope && c.searchScope.catalogCategoryPaths) || []) { const k = pa.map(norm).join('>'); if (!pathMap.has(k)) pathMap.set(k, c.conceptId); }
  const conceptForPath = (pa) => { for (let n = pa.length; n >= 1; n--) { const hit = pathMap.get(pa.slice(0, n).map(norm).join('>')); if (hit) return hit; } return undefined; };

  const seen = new Set(); const usedIds = new Set(existing.map((c) => c.conceptId));
  const concepts = [], sources = [], chunks = [], relationships = [], verifications = [];
  const stats = { byKind: {}, docsConsidered: 0, skippedNoLink: 0, skippedDup: 0, skippedShort: 0 };
  const pdfs = [];
  await eachLine(DATA + '/crawl/placemakers/assets/pdf_text.jsonl', (l) => { try { pdfs.push(JSON.parse(l)); } catch {} });
  for (const o of pdfs) {
    const fileName = decodeURIComponent((o.url || '').split('?')[0].split('/').pop() || '').replace(/\.pdf$/i, '');
    const probe = (o.title || '') + ' ' + fileName;
    const k = KINDS.find((x) => x.re.test(probe)); if (!k) continue; stats.docsConsidered++;
    const text = clean(o.text); if (text.length < 400) { stats.skippedShort++; continue; }
    const h = sha(k.kind + text.slice(0, 3000)); if (seen.has(h)) { stats.skippedDup++; continue; } seen.add(h);
    const skus = [...new Set(docToSkus.get((o.url || '').split('?')[0]) || [])]; if (!skus.length) { stats.skippedNoLink++; continue; }
    const paths = new Map(); for (const s of skus) { const pa = skuPath.get(s); if (pa) paths.set(pa.join('>'), pa); }
    const catPaths = [...paths.values()].slice(0, 8);
    const baseName = fileName.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const generic = baseName.length < 12 || /^(installation|install|guide|instructions?)( guide| instructions?)?$/i.test(baseName);
    const product = clean(skuName.get(skus[0]) || '').slice(0, 70);
    const name = (generic && product ? `${k.label}: ${product}` : `${k.label}: ${baseName}`).slice(0, 120);
    let id = `concept://${TENANT}/documents/${slug(name)}`; if (usedIds.has(id)) id += '-' + h.slice(0, 6); usedIds.add(id);
    const sourceId = 'src-doc-' + h.slice(0, 14);
    sources.push({ sourceId, title: name, kind: 'manufacturer_document', documentId: h.slice(0, 24), uri: o.url, scope: skus.length === 1 ? 'sku' : 'category', ...(o.pages ? { pages: Array.from({ length: Math.min(+o.pages || 1, 200) }, (_, i) => i + 1) } : {}) });
    const first = text.slice(0, 380).replace(/\n+/g, ' ');
    const concept = {
      conceptId: id, tenantId: TENANT, type: k.conceptType, name, description: `${k.label} supplied for ${skus.length} product${skus.length === 1 ? '' : 's'} (for example ${product || 'see source'}). Opens: ${first}`.slice(0, 700),
      synonyms: [], customerPhrases: [baseName.toLowerCase().slice(0, 80)].filter((x) => x.length > 3), lens: 'product', riskClass: 'compatibility', compatibilitySensitive: false,
      requiredFacts: [], discriminators: [], searchScope: { catalogCategoryIds: [], enrichmentFacets: [], excludeCategoryIds: [] },
      commercePolicy: { addToCart: 'allowed', checkout: 'allowed' }, safety: { blocksProducts: false, stepRefs: [] }, evidenceRefs: [sourceId], lifecycle: { status: 'active_draft' }, version: 1,
    };
    concept.contentHash = K.computeKnowledgeEntityHash(concept); concepts.push(concept);
    stats.byKind[k.kind] = (stats.byKind[k.kind] || 0) + 1;
    chunkText(text).slice(0, 12).forEach((c, i) => {
      const chunk = { chunkId: `chk-${h.slice(0, 10)}-${i}`, sourceRef: sourceId, conceptIds: [id], claimClasses: k.claims, title: `${name}${i ? ' (part ' + (i + 1) + ')' : ''}`.slice(0, 160), content: c, applicability: { scope: skus.length === 1 ? 'sku' : 'category', refs: skus.slice(0, 20) }, ordinal: i, uri: o.url };
      chunk.contentHash = K.computeKnowledgeEntityHash(chunk); chunks.push(chunk);
    });
    const targets = [...new Set(catPaths.map(conceptForPath).filter(Boolean))].slice(0, 4);
    for (const to of targets) {
      const relId = 'rel-' + sha(id + '>' + to).slice(0, 14);
      const rel = { relationshipId: relId, from: id, to, type: 'document_for', strength: 'recommended', scope: skus.length === 1 ? 'sku' : 'category', confidence: 'high', sourceRefs: [sourceId], claimClasses: k.claims, customerLabel: `is a ${k.label.toLowerCase()} for` };
      rel.contentHash = K.computeKnowledgeEntityHash(rel);
      const recordId = 'ver-' + sha(relId).slice(0, 14);
      verifications.push({ recordId, targetType: 'relationship', targetId: relId, status: 'in_review', sourceRefs: [sourceId], contentHash: rel.contentHash, extensions: { proposedFor: 'owner bulk review in OKF Studio', basis: 'PlaceMakers-published supplier document text, verbatim; the owner has stated this content is confirmed for the demo', proposedOn: NOW.slice(0, 10) } });
      rel.verificationRef = recordId; relationships.push(rel);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: NOW, stats, concepts, sources, evidenceChunks: chunks, relationships, verifications }));
  console.log(JSON.stringify({ concepts: concepts.length, sources: sources.length, chunks: chunks.length, relationships: relationships.length, verifications: verifications.length, bytes: fs.statSync(OUT).size, ...stats }, null, 1));
})().catch((e) => { console.error('failed:', e.stack || e.message); process.exit(1); });
