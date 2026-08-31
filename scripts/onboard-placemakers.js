/**
 * One-off onboarding script for the PlaceMakers (NZ) tenant.
 *
 * Mirrors the platform's existing ingestion shape (see product.service.ts
 * ingestKnowledgeDocuments + the abercrombie `documents` doc shape):
 *   - DB `journeyax` / collection `tenant_configs`  → the ProjectConfig
 *   - DB `journeyx`  / collection `documents`        → product + content knowledge,
 *     each doc carrying projectId + brand + metadata.brand = 'placemakers',
 *     one embedding (text-embedding-3-small, 1536-dim) per doc, upserted on
 *     {projectId, sourceUrl} so reruns are idempotent / resumable.
 *
 * Usage:
 *   node scripts/onboard-placemakers.js project      # upsert tenant_configs doc
 *   node scripts/onboard-placemakers.js products      # ingest catalog JSONL
 *   node scripts/onboard-placemakers.js content        # ingest CMS content JSONL
 *   node scripts/onboard-placemakers.js verify          # sanity-check counts + a couple of searches
 */
require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const { MongoClient } = require('mongodb');
const OpenAILib = require('openai');
const OpenAI = OpenAILib.default || OpenAILib;

const PROJECT_ID = 'placemakers';
const CATALOG_PATH = process.env.PM_CATALOG_PATH || '/Users/mahaveer/Downloads/ConsumerProductCatalog_20260620.jsonl';
const CONTENT_PATH = process.env.PM_CONTENT_PATH || '/Users/mahaveer/Downloads/pmContentIndex-br-cronJob_20260821.jsonl';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;
const CONCURRENCY = 5;

const openai = new OpenAI();

async function getDbs() {
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
    maxPoolSize: 3,
  });
  await client.connect();
  return { client, jax: client.db('journeyax'), jyx: client.db('journeyx') };
}

// ── Stage: project config ──────────────────────────────────────────────
async function upsertProject() {
  const { client, jax } = await getDbs();
  const now = new Date().toISOString();
  const existing = await jax.collection('tenant_configs').findOne({ projectId: PROJECT_ID });
  const version = existing ? (existing.version || 1) + 1 : 1;

  const cfg = {
    tenantId: PROJECT_ID,
    projectId: PROJECT_ID,
    name: 'PlaceMakers',
    companyName: 'PlaceMakers (Fletcher Building)',
    projectName: 'PlaceMakers NZ',
    slug: 'placemakers-nz',
    domain: 'placemakers.journeyax.com',
    status: 'active',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    version,
    channels: { web: true, mobile: false, email: false, whatsapp: false, voice: false, kiosk: false, partner: false, csr: false },
    pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 },
    scope: {
      rooms: [],
      finishes: [],
      categories: ['Timber & Plywood', 'Decking', 'Fencing', 'Cladding', 'Fixings & Fasteners', 'Hardware', 'Building Materials'],
      complianceTags: ['H1', 'Building Code'],
      excludedSkus: [],
    },
    theme: {
      // PlaceMakers real-world brand: red/black/white (not JourneyAX default black/yellow —
      // per CLAUDE.md, off-brand-for-JourneyAX colours are fine on a per-tenant storefront).
      primaryColor: '#E31E24',
      accentColor: '#000000',
      fontFamily: "'Arial', 'Helvetica Neue', sans-serif",
      logoUrl: 'https://www.placemakers.co.nz/etc/designs/placemakers/images/logo.svg',
      visualizerEnabled: false,
    },
    contextDimensions: [
      { key: 'project', label: 'Project type', values: ['decking', 'fencing', 'cladding', 'renovation', 'new-build', 'repair'], scoping: true, filtersRetrieval: true },
      { key: 'category', label: 'Category', values: ['Timber & Plywood', 'Decking', 'Fencing', 'Fixings & Fasteners', 'Hardware'], scoping: true, filtersRetrieval: true },
      { key: 'audience', label: 'Audience', values: ['DIY', 'Trade'], scoping: false, filtersRetrieval: false },
    ],
    ai: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.3,
      embeddingModel: EMBEDDING_MODEL,
      ingestModel: 'gpt-4o-mini',
      extractModel: 'gpt-4o-mini',
    },
    capabilities: ['products', 'installGuide', 'warranty'],
    integrations: { platforms: { knowledge: 'standalone', commerce: 'standalone' } },
    knowledgeSource: {
      domain: 'placemakers.co.nz',
      sources: [
        { id: 'nz-product-catalog', type: 'csv-feed', role: 'product', currency: 'NZD', enabled: true, label: 'PlaceMakers NZ consumer product catalog (JSON Patch feed, 20260620)' },
        { id: 'nz-content-index', type: 'kb-articles', role: 'articles', enabled: true, label: 'PlaceMakers CMS content index (build/DIY/trade articles, 20260821)' },
      ],
    },
    persona: {
      systemName: 'PlaceMakers Assistant',
      systemPromptOverrides:
        "You are the PlaceMakers Assistant for placemakers.co.nz (NZ DIY / building materials). Ground every answer exclusively in the PlaceMakers catalogue and content provided to you — never invent products, SKUs, prices, stock, or safety/compliance guidance that is not present in the retrieved data. This catalogue does NOT contain a structured bill-of-materials or verified substitute/cross-sell table for most SKUs — do NOT invent a materials list or a 'complete the project' bundle beyond what is explicitly linked in the data. If asked to plan a whole project (e.g. 'what do I need to build a deck'), retrieve and surface real relevant products/content and be explicit that this is guided discovery, not a verified bill-of-materials.",
      greetingMessage: "Kia ora, I'm the PlaceMakers Assistant. Tell me what you're building or looking for and I'll help you find the right products and guidance.",
      escalationEmail: 'help@placemakers.co.nz',
      journeyGuidance:
        "You are the PlaceMakers Assistant, a knowledgeable NZ building-materials associate. Understand what the customer is building or fixing, ask at most a couple of clarifying questions (project type, rough size/quantity, DIY vs trade), then searchKnowledge across the real product catalogue and content articles to ground your answer. Never fabricate a bill-of-materials, a bundle, or a substitute product — only surface items and links that are actually present in the retrieved data. For anything touching building code / compliance (e.g. H1), prefer the ingested content articles and clearly note this is general guidance, not a compliance sign-off.",
    },
    commerceMode: 'quote',
    labels: { items: 'Products', itemsSingular: 'Product', headerTitle: 'PlaceMakers Assistant' },
  };

  await jax.collection('tenant_configs').updateOne(
    { projectId: PROJECT_ID },
    { $set: cfg },
    { upsert: true }
  );
  console.log(`[project] upserted tenant_configs for '${PROJECT_ID}' (version ${version})`);
  await client.close();
}

// ── helpers ──────────────────────────────────────────────────────────
function leafCategory(categoryPaths) {
  try {
    const path = (categoryPaths || []).find((p) => Array.isArray(p) && p.length > 1) || (categoryPaths || [])[1];
    if (!path) return undefined;
    return path.map((n) => n.name).filter((n) => n !== 'root').join(' > ');
  } catch { return undefined; }
}

function stockBranchCount(branchAvailability) {
  if (!Array.isArray(branchAvailability)) return 0;
  // codes look like "600YY" / "161YN" — trailing two letters are flags; treat
  // any branch entry present as "carried"; a first-flag 'Y' as "in stock now".
  return branchAvailability.filter((c) => /Y$/i.test(String(c).slice(-2, -1)) || /Y/.test(String(c).slice(-2))).length;
}

async function embedBatch(texts) {
  const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return resp.data.map((d) => d.embedding);
}

async function runPool(items, worker, concurrency) {
  let idx = 0;
  let active = [];
  const results = [];
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e.message };
      }
    }
  }
  for (let c = 0; c < concurrency; c++) active.push(next());
  await Promise.all(active);
  return results;
}

// ── Stage: products ─────────────────────────────────────────────────
async function ingestProducts() {
  const { client, jyx } = await getDbs();
  const col = jyx.collection('documents');

  const rl = readline.createInterface({ input: fs.createReadStream(CATALOG_PATH), crlfDelay: Infinity });
  const rows = [];
  let lineNo = 0, parseErrors = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { parseErrors++; continue; }
    const id = rec?.path?.replace('/products/', '');
    const v = rec?.value?.attributes;
    if (!id || !v || !v.title) { parseErrors++; continue; }
    rows.push({ id, v });
  }
  console.log(`[products] parsed ${rows.length} rows from ${lineNo} lines (${parseErrors} skipped)`);

  // Resume support: find sourceUrls that already have an embedding.
  const existingIds = new Set(
    (await col.find({ projectId: PROJECT_ID, 'metadata.type': 'product' }, { projection: { 'metadata.sku': 1 } }).toArray())
      .map((d) => d.metadata?.sku)
  );
  const todo = rows.filter((r) => !existingIds.has(r.id));
  console.log(`[products] ${existingIds.size} already ingested, ${todo.length} remaining`);

  let done = 0, written = 0, embedFailed = 0;
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));

  await runPool(batches, async (batch) => {
    const texts = batch.map(({ id, v }) => {
      const cat = leafCategory(v.category_paths);
      return [
        v.title,
        v.description || '',
        v.brand ? `Brand: ${v.brand}` : '',
        v.subBrand ? `Sub-brand: ${v.subBrand}` : '',
        cat ? `Category: ${cat}` : '',
        v.unitOfMeasure ? `Unit: ${v.unitOfMeasure}` : '',
        typeof v.price === 'number' ? `Price: $${v.price} NZD` : '',
        v.discontinued ? 'Status: DISCONTINUED (no longer sold)' : '',
        v.availability === false ? 'Currently unavailable' : '',
        Array.isArray(v.keywords) && v.keywords.length ? `Keywords: ${v.keywords.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    });

    let embeddings;
    try {
      embeddings = await embedBatch(texts);
    } catch (e) {
      console.warn(`[products] embed batch failed: ${e.message}`);
      embedFailed += batch.length;
      done += batch.length;
      return;
    }

    const now = new Date();
    const ops = batch.map(({ id, v }, i) => {
      const cat = leafCategory(v.category_paths);
      const sourceUrl = `product://placemakers/${id}`;
      return {
        updateOne: {
          filter: { projectId: PROJECT_ID, sourceUrl },
          update: {
            $set: {
              projectId: PROJECT_ID,
              brand: PROJECT_ID,
              sourceUrl,
              chunkIndex: 0,
              chunk: texts[i],
              content: texts[i],
              title: v.title,
              crawledAt: now,
              updatedAt: now,
              embedding: embeddings[i],
              metadata: {
                type: 'product',
                brand: PROJECT_ID,
                url: v.url,
                sku: id,
                price: typeof v.price === 'number' ? v.price : undefined,
                discountPrice: typeof v.discountPrice === 'number' ? v.discountPrice : undefined,
                hasDiscount: !!v.hasDiscount,
                currency: 'NZD',
                category: cat,
                images: v.thumb_image ? [v.thumb_image] : [],
                supplierBrand: v.brand,
                subBrand: v.subBrand,
                unitOfMeasure: v.unitOfMeasure,
                keywords: v.keywords || [],
                promotionTags: v.promotionTags || [],
                discontinued: !!v.discontinued,
                availability: v.availability !== false,
                branchesCarrying: stockBranchCount(v.branchAvailability),
                nationallySupplied: !!v.nationallySupplied,
              },
            },
          },
          upsert: true,
        },
      };
    });

    try {
      const res = await col.bulkWrite(ops, { ordered: false });
      written += (res.upsertedCount || 0) + (res.modifiedCount || 0);
    } catch (e) {
      console.warn(`[products] bulkWrite failed: ${e.message}`);
    }
    done += batch.length;
    if (done % 1000 < BATCH_SIZE) console.log(`[products] progress ${done}/${todo.length}`);
  }, CONCURRENCY);

  console.log(`[products] done. written=${written} embedFailed=${embedFailed}`);
  await client.close();
}

// ── Stage: content ───────────────────────────────────────────────────
async function ingestContent() {
  const { client, jyx } = await getDbs();
  const col = jyx.collection('documents');

  const rl = readline.createInterface({ input: fs.createReadStream(CONTENT_PATH), crlfDelay: Infinity });
  const rows = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const v = rec?.value?.attributes;
    if (!v || !v.title) continue;
    rows.push(v);
  }
  console.log(`[content] parsed ${rows.length} content items`);

  const texts = rows.map((v) => [
    v.title,
    v.description || '',
    Array.isArray(v.job) ? `Audience: ${v.job.join(', ')}` : '',
    Array.isArray(v.contentCategory) ? `Category: ${v.contentCategory.join(' > ')}` : '',
  ].filter(Boolean).join('\n'));

  const embeddings = await embedBatch(texts); // 183 items, single call is fine

  const now = new Date();
  const ops = rows.map((v, i) => {
    const sourceUrl = `content://placemakers${v.url || '/' + v.code}`;
    return {
      updateOne: {
        filter: { projectId: PROJECT_ID, sourceUrl },
        update: {
          $set: {
            projectId: PROJECT_ID,
            brand: PROJECT_ID,
            sourceUrl,
            chunkIndex: 0,
            chunk: texts[i],
            content: texts[i],
            title: v.title,
            crawledAt: now,
            updatedAt: now,
            embedding: embeddings[i],
            metadata: {
              // NOTE: the Atlas Search index's metadata.type filter path only recognises
              // values that already existed platform-wide at index-build time (a static
              // facet, not dynamic) — 'articles' (this feed's natural label) silently
              // matched ZERO docs under a $vectorSearch filter even though the docs and
              // their embeddings were written correctly (see the "Atlas vector filter
              // paths" trap). 'general' is the proven-indexed catch-all Caroma already
              // uses for this exact kind of CMS/support content — use that instead.
              type: 'general',
              brand: PROJECT_ID,
              url: `https://www.placemakers.co.nz${v.url || ''}`,
              category: Array.isArray(v.contentCategory) ? v.contentCategory.join(' > ') : undefined,
              audience: v.job || [],
              images: v.previewImage ? [v.previewImage] : [],
            },
          },
        },
        upsert: true,
      },
    };
  });
  const res = await col.bulkWrite(ops, { ordered: false });
  console.log(`[content] written ${(res.upsertedCount || 0) + (res.modifiedCount || 0)} docs`);
  await client.close();
}

// ── Stage: verify ────────────────────────────────────────────────────
async function verify() {
  const { client, jyx } = await getDbs();
  const col = jyx.collection('documents');

  const byType = await col.aggregate([{ $match: { projectId: PROJECT_ID } }, { $group: { _id: '$metadata.type', count: { $sum: 1 } } }]).toArray();
  console.log('[verify] placemakers doc counts by type:', JSON.stringify(byType));

  const brands = await col.aggregate([{ $group: { _id: '$metadata.brand', count: { $sum: 1 } } }]).toArray();
  console.log('[verify] ALL tenant doc counts (post-run):', JSON.stringify(brands));

  async function searchTest(label, query, filterType) {
    const emb = (await embedBatch([query]))[0];
    const filter = { 'metadata.brand': PROJECT_ID };
    if (filterType) filter['metadata.type'] = filterType;
    const pipeline = [
      { $vectorSearch: { index: 'vector_index', path: 'embedding', queryVector: emb, numCandidates: 50, limit: 5, filter } },
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
      { $project: { embedding: 0 } },
    ];
    const results = await col.aggregate(pipeline).toArray();
    console.log(`\n[verify] query="${query}" (${label}) → ${results.length} hits`);
    for (const r of results) {
      console.log(`  score=${r.score?.toFixed(3)} title="${r.title}" sku=${r.metadata?.sku || ''} price=${r.metadata?.price ?? ''} url=${r.metadata?.url}`);
    }
  }

  for (const [label, query, type] of [
    ['product', '90mm treated pine decking board', undefined],
    ['product', 'stainless steel deck screws', undefined],
    ['content', 'building consent H1 compliance requirements', 'general'],
    ['content-faq', 'credit returns and refunds process', 'faq'],
  ]) {
    try {
      await searchTest(label, query, type);
    } catch (e) {
      console.error(`[verify] search "${query}" FAILED: ${e.message}`);
    }
  }

  await client.close();
}

async function main() {
  const stage = process.argv[2];
  if (stage === 'project') return upsertProject();
  if (stage === 'products') return ingestProducts();
  if (stage === 'content') return ingestContent();
  if (stage === 'verify') return verify();
  console.error('Usage: node onboard-placemakers.js [project|products|content|verify]');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
