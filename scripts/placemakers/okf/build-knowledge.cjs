// Builds lean business-knowledge additions for the placemakers OKF from the Placemaker-data folder ONLY.
// Pure data transform, no database writes. Output: knowledge-additions.json (+ stats).
//   node build-knowledge.cjs <out.json>
const fs = require('fs');
const path = require('path');
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

const slug = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'page';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const LS = new RegExp(String.fromCharCode(91,92,117,50,48,50,56,92,117,50,48,50,57,93), 'g');
const clean = (s) => String(s || '').replace(LS, ' ').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---- selection rules (by URL shape, never by scenario) ----
const SKIP_TITLE = /no results|can.t be reached|no internet|connection was|signed up|page not found|oops|access denied|^\s*$/i;
const SKIP_URL = /\/placemakers-plus|\/promo-terms|\/online\/p\/\d+|\/projects\/inspiration|\/medias\/sys_master|store-locator|e-tools-whats-new|\/levene|\/search/i;
function classify(url) {
  if (/\/how-to-guides\//i.test(url)) return { type: 'installation', lens: 'project', risk: 'compatibility', claims: ['installation_step'] };
  if (/\/services|credit-returns|useful-contacts|service-promise|tradeportal|dedicated-trade|\/trade|dedicated-delivery|create-trade/i.test(url)) return { type: 'service', lens: 'service', risk: 'standard', claims: [] };
  return { type: 'project', lens: 'project', risk: 'standard', claims: ['suggestion'] };
}

function chunkPage(page, claims) {
  const out = []; let buf = ''; let bufHeading = '';
  const flush = () => { const t = clean(buf); if (t.length >= 60) out.push({ heading: bufHeading, text: t }); buf = ''; bufHeading = ''; };
  for (const s of page.sections || []) {
    const text = clean(s.text); if (text.length < 40) continue;
    if (/^(in this article|share|related|navigation)/i.test(s.heading || '')) continue;
    const piece = (s.heading ? s.heading + '\n' : '') + text;
    if (piece.length > 1400) { flush(); for (let i = 0; i < text.length; i += 1300) out.push({ heading: s.heading || '', text: text.slice(i, i + 1300) }); continue; }
    if ((buf + '\n' + piece).length > 1300) flush();
    if (!buf) bufHeading = s.heading || '';
    buf += (buf ? '\n' : '') + piece;
  }
  flush();
  return out;
}

async function main() {
  // 1. product master -> sku -> category name (for relating guides to what they feature)
  const skuCategory = new Map();
  await new Promise((resolve, reject) => {
    let rest = '';
    const rs = fs.createReadStream(DATA + '/master/placemakers_product_master.jsonl', { encoding: 'utf8', highWaterMark: 1 << 20 });
    const take = (line) => { if (!line) return; try { const o = JSON.parse(line); if (o.sku && Array.isArray(o.categoryPathNames) && Array.isArray(o.categoryPathNames[0])) skuCategory.set(String(o.sku), o.categoryPathNames[0].map(String)); } catch {} };
    rs.on('data', (d) => { rest += d; let i; while ((i = rest.indexOf('\n')) >= 0) { take(rest.slice(0, i)); rest = rest.slice(i + 1); } });
    rs.on('end', () => { take(rest); resolve(); });
    rs.on('error', reject);
  });

  // 2. existing category concepts of the active release (read-only) to attach guides to
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB_NAME || 'journeyx');
  const pack = await db.collection('business_pack_releases').find({ tenantId: TENANT, environmentId: 'production' }).sort({ publishedAt: -1 }).limit(1).project({ knowledgeModel: 1 }).toArray();
  const releaseId = (pack[0] && pack[0].knowledgeModel && pack[0].knowledgeModel.releaseId) || 'okf-placemakers-production-1.7.0';
  const existing = await db.collection('okf_concepts').find({ tenantId: TENANT, releaseId }, { projection: { conceptId: 1, name: 1, type: 1, searchScope: 1 } }).toArray();
  await client.close();
  const pathMap = new Map();
  for (const c of existing) { const ps = (c.searchScope && c.searchScope.catalogCategoryPaths) || []; for (const pa of ps) { const k = pa.map(norm).join('>'); if (!pathMap.has(k)) pathMap.set(k, c.conceptId); } }
  const conceptForPath = (pa) => { for (let n = pa.length; n >= 1; n--) { const hit = pathMap.get(pa.slice(0, n).map(norm).join('>')); if (hit) return hit; } return undefined; };
  const existingIds = new Set(existing.map((c) => c.conceptId));

  // 3. content pages
  const pages = fs.readFileSync(DATA + '/master/placemakers_content_master.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const seenText = new Set(); const seenUrl = new Set();
  const titleBest = new Map();
  for (const p of pages) { const t = norm(clean(p.displayTitle || p.title)); const len = clean(p.text).length; if (!titleBest.has(t) || len > titleBest.get(t).len) titleBest.set(t, { url: p.url, len }); }
  const concepts = [], sources = [], chunks = [], relationships = [], verifications = [];
  const stats = { pagesIn: pages.length, skipped: { title: 0, url: 0, short: 0, duplicate: 0 }, byType: {}, chunks: 0, relationships: 0, unmappedFeatured: 0 };
  const usedIds = new Set(existingIds);

  for (const p of pages) {
    const title = clean(p.displayTitle || p.title);
    if (SKIP_TITLE.test(title)) { stats.skipped.title++; continue; }
    if (SKIP_URL.test(p.url)) { stats.skipped.url++; continue; }
    const text = clean(p.text);
    if (text.length < 700) { stats.skipped.short++; continue; }
    const th = sha(text.slice(0, 2000)); if (seenText.has(th) || seenUrl.has(p.url) || titleBest.get(norm(title)).url !== p.url) { stats.skipped.duplicate++; continue; }
    seenText.add(th); seenUrl.add(p.url);
    const cls = classify(p.url);
    let id = `concept://${TENANT}/guides/${slug(title)}`; if (usedIds.has(id)) id += '-' + sha(p.url).slice(0, 6); usedIds.add(id);
    const sourceId = 'src-pm-' + sha(p.url).slice(0, 12);
    const day = (p.crawledAt || NOW).slice(0, 10);
    sources.push({ sourceId, title: `PlaceMakers page: ${title}`, kind: 'merchant_policy', policyId: slug(p.url.replace(/^https?:\/\/[^/]+/, '')) || 'page', version: day, effectiveFrom: p.crawledAt || NOW, uri: p.url });

    const heads = [...new Set((p.headings || []).filter((h) => h.level >= 2 && h.level <= 3).map((h) => clean(h.text)).filter((t) => t.length > 3 && t.length < 80))];
    const firstText = clean((p.sections || []).map((s) => s.text).find((t) => clean(t).length > 80) || text);
    const summary = clean(p.summary) || firstText.slice(0, 420);
    const description = (summary.slice(0, 480) + (heads.length ? ` Covers: ${heads.slice(0, 8).join('; ')}.` : '')).slice(0, 760);
    const phrases = [`${title.toLowerCase()} ${cls.type === 'service' ? 'service' : 'guide'}`].filter((t) => t.length > 3 && t.length < 90);
    const pathSeen = new Map(); for (const f of p.featuredProducts || []) { const pa = skuCategory.get(String(f.sku)); if (pa) pathSeen.set(pa.join('>'), pa); }
    const catPaths = [...pathSeen.values()].slice(0, 12); const cats = catPaths.map((pa) => pa.join(' > '));
    const concept = {
      conceptId: id, tenantId: TENANT, type: cls.type, name: `${title.slice(0, 100)} (PlaceMakers ${cls.type === 'service' ? 'service' : 'guide'})`, description,
      synonyms: [], customerPhrases: phrases, lens: cls.lens, riskClass: cls.risk, compatibilitySensitive: false,
      requiredFacts: [], discriminators: [],
      searchScope: { catalogCategoryIds: [], enrichmentFacets: [], excludeCategoryIds: [] },
      commercePolicy: { addToCart: 'allowed', checkout: 'allowed' }, safety: { blocksProducts: false, stepRefs: [] },
      evidenceRefs: [sourceId], lifecycle: { status: 'active_draft' }, version: 1,
    };
    concept.contentHash = K.computeKnowledgeEntityHash(concept);
    concepts.push(concept);
    stats.byType[cls.type] = (stats.byType[cls.type] || 0) + 1;

    chunkPage(p, cls.claims).forEach((c, i) => {
      const chunk = {
        chunkId: `chk-${sha(p.url).slice(0, 10)}-${i}`, sourceRef: sourceId, conceptIds: [id], claimClasses: cls.claims,
        title: `${title}${c.heading && c.heading !== title ? ' - ' + clean(c.heading).slice(0, 80) : ''}`, content: c.text,
        applicability: { scope: cats.length ? 'category' : 'general', refs: cats.slice(0, 12) }, ordinal: i, uri: p.url,
      };
      chunk.contentHash = K.computeKnowledgeEntityHash(chunk);
      chunks.push(chunk); stats.chunks++;
    });

    // guide -> categories it features. Only categories that exist as concepts.
    const targets = [...new Set(catPaths.map(conceptForPath).filter(Boolean))].slice(0, 8);
    stats.unmappedFeatured += catPaths.filter((pa) => !conceptForPath(pa)).length;
    for (const to of targets) {
      const relId = 'rel-' + sha(id + '>' + to).slice(0, 14);
      const claimClasses = cls.claims.filter((c) => c !== 'suggestion');
      const rel = {
        relationshipId: relId, from: id, to, type: cls.type === 'installation' ? 'document_for' : 'relevant_to', strength: 'recommended', scope: 'category',
        confidence: 'high', sourceRefs: [sourceId], claimClasses,
        customerLabel: cls.type === 'installation' ? `is a how-to guide covering` : `is a PlaceMakers guide featuring`,
      };
      rel.contentHash = K.computeKnowledgeEntityHash(rel);
      if (claimClasses.length) {
        const recordId = 'ver-' + sha(relId).slice(0, 14);
        verifications.push({
          recordId, targetType: 'relationship', targetId: relId, status: 'in_review', sourceRefs: [sourceId],
          contentHash: rel.contentHash,
          extensions: { proposedFor: 'owner bulk review in OKF Studio', basis: 'PlaceMakers-published guide text, verbatim; the owner has stated this content is confirmed for the demo', proposedOn: NOW.slice(0, 10) },
        });
        rel.verificationRef = recordId;
      }
      relationships.push(rel); stats.relationships++;
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: NOW, baseReleaseId: releaseId, stats, concepts, sources, evidenceChunks: chunks, relationships, verifications }));
  console.log(JSON.stringify({ baseReleaseId: releaseId, concepts: concepts.length, sources: sources.length, chunks: chunks.length, relationships: relationships.length, verifications: verifications.length, bytes: fs.statSync(OUT).size, ...stats }, null, 1));
}
main().catch((e) => { console.error('failed:', e.stack || e.message); process.exit(1); });
