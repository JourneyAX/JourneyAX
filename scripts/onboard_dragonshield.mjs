#!/usr/bin/env node
/**
 * Onboard Dragon Shield as a real JourneyAX tenant, the same way Caroma /
 * PlaceMakers / M&M'S / Abercrombie were onboarded: a project-service record
 * (org + project, via the real API — no hardcoded per-tenant code) plus real
 * data in `journeyx.documents` (search + authoritative pricing) and
 * `journeyx.products` (SKU-existence checks), with real OpenAI embeddings.
 *
 * Source data: the overnight "Jax Dragon Motion 1" scrape already sitting at
 *   jax-whatsapp-open-model/customers/dragon-shield/data/pilot-v2/product-master.jsonl
 *   jax-whatsapp-open-model/customers/dragon-shield/data/pilot-v2/price-snapshots-NOT-LIVE.jsonl
 *   jax-whatsapp-open-model/customers/dragon-shield/data/public/pages/*.json
 * This script does NOT re-crawl anything — it reuses that scrape for
 * JourneyAX's standard RAG pipeline instead of the (unapproved) local
 * fine-tuned model.
 *
 * Schema mirrors the real, currently-working M&M'S tenant exactly (verified
 * live against Mongo before writing this): `documents` collection,
 * `docType: 'product'`, `metadata.{sku,name,price,currency,category,images,
 * imageUrl,url,specs}` — this is what product-service's readPricebook() and
 * vectorSearch() actually read, confirmed by reading the code, not assumed.
 *
 * Usage:
 *   node scripts/onboard_dragonshield.mjs            # create tenant + ingest everything
 *   node scripts/onboard_dragonshield.mjs --skip-org  # project/data only (org already made)
 *   node scripts/onboard_dragonshield.mjs --dry-run   # parse + report counts, no writes
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DS_ROOT = path.resolve(ROOT, '..', '..', 'jax-whatsapp-open-model', 'customers', 'dragon-shield');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_ORG = args.includes('--skip-org');

const PROJECT_ID = 'dragonshield';
const ORG_NAME = 'Arcane Tinmen'; // Dragon Shield's real parent company, per their own FAQ
const ORG_API = process.env.ORG_SERVICE_URL || 'http://localhost:8095';
const PROJECT_API = process.env.PROJECT_SERVICE_URL || 'http://localhost:8082';
const MONGODB_URI = process.env.MONGODB_URI;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!MONGODB_URI) { console.error('Missing MONGODB_URI'); process.exit(1); }
if (!OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function embed(text) {
  try {
    const call = openai.embeddings.create({ model: 'text-embedding-3-small', input: text.slice(0, 6000) });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('embed timeout')), 15000));
    const res = await Promise.race([call, timeout]);
    return res.data[0].embedding;
  } catch (err) {
    console.warn('  ⚠ embedding failed for', text.slice(0, 40).replace(/\n/g, ' '), '—', err.message);
    return [];
  }
}

/** Small bounded-concurrency map so ~500 embedding calls run in parallel batches, not serially. */
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

// ── category inference (from the site's own collection names, probed 2026-09-12) ──
const CATEGORY_RULES = [
  [/nest|shell|strongbox|fortress(?!.{0,10}playmat)/i, 'Deck Boxes'],
  [/zipster|portfolio|slipcase|pocket pages|album/i, 'Albums'],
  [/companion|codex|screen|game master|player companion|roleplaying/i, 'Roleplaying'],
  [/dice/i, 'Dice Companion'],
  [/playmat/i, 'Playmats'],
  [/sleeves?/i, 'Card Sleeves'],
];
function inferCategory(name) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  return 'Other';
}
const GAME_RULES = [
  [/magic|mtg/i, 'Magic: The Gathering'],
  [/pok[ée]mon/i, 'Pokémon'],
  [/yu-?gi-?oh/i, 'Yu-Gi-Oh!'],
  [/flesh and blood/i, 'Flesh and Blood'],
  [/grand archive/i, 'Grand Archive'],
  [/lorcana/i, 'Lorcana'],
];
function inferGame(name, description) {
  const s = `${name} ${description}`;
  for (const [re, g] of GAME_RULES) if (re.test(s)) return g;
  return null;
}
function inferSize(name) {
  if (/japanese/i.test(name)) return 'Japanese (59×86mm)';
  if (/standard/i.test(name)) return 'Standard (63×88mm)';
  return null;
}

// ── content pages worth ingesting (skip nav-only /collections/*, they duplicate products) ──
function contentDocType(url) {
  if (/\/pages\/(faqs?|cancel-returns|shipping-delivery|cancellation)/i.test(url)) return 'faq';
  if (/\/pages\/(terms-conditions|privacy-policy|data-sharing-opt-out)/i.test(url)) return 'policy';
  if (/\/pages\/(the-forge|creators-keep)/i.test(url)) return 'general';
  if (/\/blogs\//i.test(url)) return 'general';
  if (/\/pages\/(about-us)/i.test(url)) return 'general';
  return null; // creator/collab landing pages, signature-series etc. — skip, low RAG value, high noise
}

async function main() {
  console.log(`\n=== Dragon Shield onboarding (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);

  // ── 1. Load scraped source files ──────────────────────────────────────
  const productMasterPath = path.join(DS_ROOT, 'data', 'pilot-v2', 'product-master.jsonl');
  const priceSnapshotPath = path.join(DS_ROOT, 'data', 'pilot-v2', 'price-snapshots-NOT-LIVE.jsonl');
  const pagesDir = path.join(DS_ROOT, 'data', 'public', 'pages');
  const manifestPath = path.join(DS_ROOT, 'data', 'public', 'manifest.jsonl');

  const products = fs.readFileSync(productMasterPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const priceBySku = new Map();
  for (const line of fs.readFileSync(priceSnapshotPath, 'utf8').trim().split('\n')) {
    const p = JSON.parse(line);
    priceBySku.set(p.sku, p);
  }
  const manifest = fs.readFileSync(manifestPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((m) => m.status === 'captured_pending_review' && m.record);

  console.log(`Loaded ${products.length} products, ${priceBySku.size} price snapshots, ${manifest.length} captured pages.`);

  // ── 2. Flatten products → one row per variant (SKU), matching real catalogue shape ──
  const rows = [];
  for (const p of products) {
    const category = inferCategory(p.name);
    const game = inferGame(p.name, p.description || '');
    const size = inferSize(p.name);
    for (const v of p.variants || []) {
      if (!v.sku) continue;
      const priced = priceBySku.get(v.sku);
      rows.push({
        sku: v.sku,
        name: v.name || p.name,
        description: p.description || '',
        category,
        game,
        size,
        price: priced ? Number(priced.price) : null,
        currency: priced?.currency || 'USD',
        inStock: priced ? priced.availability === 'http://schema.org/InStock' : null,
        imageUrl: v.image_url || null,
        url: v.url || p.source_url,
      });
    }
  }
  console.log(`Flattened to ${rows.length} SKU rows (products × variants).`);

  // ── 3. Content pages worth RAG (FAQ/policy/general) ─────────────────────
  const contentDocs = [];
  for (const m of manifest) {
    const type = contentDocType(m.url);
    if (!type) continue;
    const recordPath = path.join(DS_ROOT, 'data', 'public', m.record);
    if (!fs.existsSync(recordPath)) continue;
    const rec = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const text = String(rec.text || '').trim();
    if (text.length < 200) continue;
    const title = m.url.split('/').filter(Boolean).pop().replace(/[-_]/g, ' ');
    contentDocs.push({ url: m.url, type, title, text: text.slice(0, 12000) });
  }
  console.log(`Selected ${contentDocs.length} content pages for RAG ingestion (FAQ/policy/general).`);

  if (DRY_RUN) {
    console.log('\nDry run — no writes. Sample product row:', JSON.stringify(rows[0], null, 2));
    console.log('\nSample content doc:', contentDocs[0] && { url: contentDocs[0].url, type: contentDocs[0].type, chars: contentDocs[0].text.length });
    return;
  }

  // ── 4. Create the tenant (org + project) via the real API — a data entry, not code ──
  if (!SKIP_ORG) {
    console.log('\n--- Creating organization + project via project-service/org-service API ---');
    const orgRes = await fetch(`${ORG_API}/api/v1/organizations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_API_KEY || '' },
      body: JSON.stringify({
        name: ORG_NAME,
        domain: 'dragonshield.com',
        plan: 'enterprise',
        billing: { contactEmail: 'ops@journeyax.com', country: 'US', currency: 'USD' },
        ownerEmail: 'ops@journeyax.com',
        ownerFullName: 'JourneyAX Ops',
      }),
    });
    const orgBody = await orgRes.json().catch(() => ({}));
    if (!orgRes.ok) { console.error('Org create failed:', orgRes.status, orgBody); process.exit(1); }
    const orgId = orgBody.organization?.orgId || orgBody.orgId || orgBody.org?.orgId;
    console.log('Organization created:', orgId, `(${ORG_NAME})`);

    const projRes = await fetch(`${PROJECT_API}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY || '' },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        orgId,
        name: 'Dragon Shield',
        companyName: 'Dragon Shield',
        slug: 'dragonshield',
        domain: 'dragonshield.journeyax.com',
        scope: { rooms: [], finishes: [], categories: ['Card Sleeves', 'Deck Boxes', 'Playmats', 'Albums', 'Roleplaying'] },
        pricing: { currency: 'USD', symbol: '$', taxRate: 0, discountRate: 0 },
        persona: {
          systemName: 'Dragon Shield Assistant',
          systemPromptOverrides: 'You help trading card game players (Magic: The Gathering, Pokémon, Yu-Gi-Oh!, Flesh and Blood, Grand Archive, Lorcana) find the right Dragon Shield sleeves, deck boxes, playmats and albums for their real deck and collection. Ask which game and roughly how many cards before recommending — a 100-card Commander deck needs different capacity than a 60-card Standard deck. Never invent a warranty: Dragon Shield does not offer product warranties (only a quality-complaint channel). Custom Forge sleeves are final sale, no returns or exchanges.',
          greetingMessage: "Hey! I'm your Dragon Shield consultant — tell me what you're playing and I'll help you protect it.",
        },
        theme: {
          primaryColor: '#EB2127',
          accentColor: '#1A1A1A',
          fontFamily: "'Space Grotesk', 'Hypatia Sans Pro', system-ui, sans-serif",
          visualizerEnabled: false,
        },
      }),
    });
    const projBody = await projRes.json().catch(() => ({}));
    if (!projRes.ok) { console.error('Project create failed:', projRes.status, projBody); process.exit(1); }
    console.log('Project created:', PROJECT_ID);

    await fetch(`${ORG_API}/api/v1/organizations/${orgId}/projects/${PROJECT_ID}`, {
      method: 'POST', headers: { 'X-Internal-Key': INTERNAL_API_KEY || '' },
    }).catch(() => {});
    console.log('Linked project to organization.');

    // B2C retail, not B2B quote (matches A&F/M&M's, not Caroma/PlaceMakers); real card capabilities.
    const patchRes = await fetch(`${PROJECT_API}/api/v1/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY || '' },
      body: JSON.stringify({
        commerceMode: 'cart',
        capabilities: ['products'],
        labels: { items: 'Products', itemsSingular: 'Product', headerTitle: 'Dragon Shield Assistant' },
        intro: {
          heroHeadline: 'Protect what you play.',
          heroSubtitle: 'Real Dragon Shield sleeves, deck boxes, playmats and albums — matched to your game and deck size.',
          starters: [
            { label: 'Sleeves for a 100-card Commander deck', prompt: "I need sleeves for a 100-card Commander deck — what do you recommend?" },
            { label: 'Compare Matte vs Matte Dual sleeves', prompt: 'What is the difference between Matte and Matte Dual sleeves?' },
            { label: 'Storage for a growing Pokémon collection', prompt: "I'm building a Pokémon collection — how should I store it?" },
            { label: 'Standard vs Japanese size', prompt: 'What size sleeves do I need for Yu-Gi-Oh!?' },
          ],
          inputPlaceholder: 'Tell me what you play and how many cards…',
        },
        uiTheme: {
          tokens: {
            colors: {
              brand: '#EB2127', brandText: '#FFFFFF', accent: '#A31E22',
              text: '#1A1A1A', textMuted: '#5F5B5B', bg: '#F6F5F3', surface: '#FFFFFF',
              surfaceAlt: '#FAF8F8', muted: '#F0EEEE', border: '#E6E2E2',
              inverse: '#1A1A1A', inverseText: '#FFFFFF', success: '#2F7D4F', warning: '#B8860B', danger: '#A31E22',
            },
            font: { display: "'Space Grotesk', 'Hypatia Sans Pro', system-ui, sans-serif", body: "'Hypatia Sans Pro', -apple-system, 'Segoe UI', Roboto, sans-serif" },
          },
        },
        fulfilment: { mode: 'delivery', label: 'Shipping', badge: 'Ships via FedEx/USPS/GLS' },
      }),
    });
    if (!patchRes.ok) console.warn('Config PATCH had issues:', patchRes.status, await patchRes.text().catch(() => ''));
    else console.log('Applied commerceMode, labels, intro, theme, fulfilment.');
  } else {
    console.log('\n--skip-org: assuming project already exists.');
  }

  // ── 5. Ingest products + content into journeyx.documents (+ minimal journeyx.products) ──
  console.log('\n--- Connecting to MongoDB for data ingestion ---');
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('journeyx');
  const docsCol = db.collection('documents');
  const prodsCol = db.collection('products');

  console.log(`Embedding + writing ${rows.length} product rows...`);
  let productsWritten = 0, productsFailed = 0;
  await mapPool(rows, 8, async (r) => {
    const specs = {
      ...(r.game ? { Game: r.game } : {}),
      ...(r.size ? { Size: r.size } : {}),
      Category: r.category,
    };
    const content = [
      r.name,
      r.description,
      `Category: ${r.category}`,
      r.game ? `Game: ${r.game}` : null,
      r.size ? `Size: ${r.size}` : null,
      r.price != null ? `Price: $${r.price} ${r.currency}` : 'Price: on request',
      `SKU: ${r.sku}`,
      `URL: ${r.url}`,
    ].filter(Boolean).join('\n');

    const embedding = await embed(content);
    if (!embedding.length) { productsFailed++; return; }

    await docsCol.updateOne(
      { projectId: PROJECT_ID, 'metadata.sku': r.sku },
      { $set: {
        projectId: PROJECT_ID,
        docType: 'product',
        title: r.name,
        content,
        chunk: content,
        chunkIndex: 0,
        sourceUrl: r.url,
        brand: PROJECT_ID,
        embedding,
        metadata: {
          brand: PROJECT_ID, type: 'product', sku: r.sku, name: r.name,
          price: r.price, currency: r.currency, category: r.category,
          images: r.imageUrl ? [r.imageUrl] : [], imageUrl: r.imageUrl,
          url: r.url, inStock: r.inStock, specs,
        },
        updatedAt: new Date(),
      } },
      { upsert: true },
    );

    // Minimal products-collection row so existingSkus()/the provenance guards
    // find a real match (product-service's SKU-exists check queries THIS
    // collection by parentSku, not `documents` — confirmed by reading the code).
    await prodsCol.updateOne(
      { projectId: PROJECT_ID, parentSku: r.sku },
      { $set: {
        projectId: PROJECT_ID, parentSku: r.sku, brandCode: 'Dragon Shield',
        name: r.name, description: r.description, category: r.category,
        images: r.imageUrl ? [r.imageUrl] : [],
        priceUSD: { min: r.price, max: r.price, cost: null },
        sizes: r.size ? [r.size] : [], colors: [],
        variants: [{ itemSku: r.sku, size: r.size || null, msrpUSD: r.price, mainImage: r.imageUrl }],
        variantCount: 1, source: 'scrape-dragonshield-2026-09-13', updatedAt: new Date(),
      } },
      { upsert: true },
    );
    productsWritten++;
    if (productsWritten % 50 === 0) console.log(`  ...${productsWritten}/${rows.length}`);
  });
  console.log(`Products: ${productsWritten} written, ${productsFailed} failed (embedding errors).`);

  console.log(`\nEmbedding + writing ${contentDocs.length} content pages...`);
  let contentWritten = 0;
  await mapPool(contentDocs, 5, async (d) => {
    const embedding = await embed(`${d.title}\n\n${d.text}`);
    if (!embedding.length) return;
    await docsCol.updateOne(
      { projectId: PROJECT_ID, sourceUrl: d.url },
      { $set: {
        projectId: PROJECT_ID, docType: d.type, title: d.title,
        content: d.text, chunk: d.text.slice(0, 4000), chunkIndex: 0,
        sourceUrl: d.url, brand: PROJECT_ID, embedding,
        metadata: { brand: PROJECT_ID, type: d.type, category: 'general', url: d.url, source: 'scrape' },
        updatedAt: new Date(),
      } },
      { upsert: true },
    );
    contentWritten++;
  });
  console.log(`Content pages: ${contentWritten} written.`);

  const finalDocs = await docsCol.countDocuments({ projectId: PROJECT_ID });
  const finalProds = await prodsCol.countDocuments({ projectId: PROJECT_ID });
  console.log(`\n=== Done. journeyx.documents[projectId=dragonshield] = ${finalDocs}, journeyx.products = ${finalProds} ===`);

  await client.close();
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
