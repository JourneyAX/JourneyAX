/**
 * Step 3 — narrative generation (the UNDERSTANDING layer).
 *
 * Turns each canonical product into prose an expert would actually say, then
 * embeds it. Facts stay in `journeyx.products` (exact lookup); only the prose is
 * vectorised — so the agent can *explain* a product without ever inventing a
 * price or SKU.
 *
 * Model choice: this is bulk, mechanical writing from structured fields — a mini
 * model is the right tool. Reasoning models add cost, not quality, here.
 *
 *   npx tsx src/scripts/generate-narratives.ts --project augusta [--limit N] [--model gpt-5-mini] [--force]
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import { embedTexts } from '../services/knowledge/embedder';

function arg(n: string) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }
const PROJECT_ID = arg('project') || 'augusta';
const LIMIT = arg('limit') ? parseInt(arg('limit')!, 10) : undefined;
const MODEL = arg('model') || 'gpt-5-mini';
const FORCE = process.argv.includes('--force');
const CONCURRENCY = 6;

const openai = new OpenAI();

/** Compact, factual brief — the model may only rephrase what's here. */
function brief(p: any): string {
  const L: string[] = [];
  L.push(`Name: ${p.name}`);
  L.push(`Style/SKU: ${p.parentSku}`);
  if (p.category) L.push(`Category: ${p.category}`);
  if (p.web?.garmentType) L.push(`Garment type: ${p.web.garmentType}`);
  if (p.web?.gender) L.push(`Fit/gender: ${p.web.gender}`);
  if (p.description) L.push(`Description: ${String(p.description).slice(0, 700)}`);
  if (p.features) L.push(`Features: ${String(p.features).slice(0, 500)}`);
  if (p.web?.fabricContent) L.push(`Fabric: ${p.web.fabricContent}`);
  if (p.web?.fabricFeatures) L.push(`Fabric features: ${String(p.web.fabricFeatures).slice(0, 300)}`);
  if (p.web?.decorationMethods?.length) L.push(`Decoration methods: ${p.web.decorationMethods.join(', ')}`);
  if (p.web?.is3D) L.push(`Has 3D configurator: yes`);
  if (p.isSublimation) L.push(`Custom sublimation product: yes`);
  if (p.web?.collection) L.push(`Collection: ${p.web.collection}`);
  if (p.colors?.length) L.push(`Colours (${p.colors.length}): ${p.colors.slice(0, 18).map((c: any) => c.name).join(', ')}`);
  if (p.sizes?.length) L.push(`Sizes: ${p.sizes.slice(0, 20).join(', ')}`);
  if (p.priceUSD) L.push(`Price USD: ${p.priceUSD.min}${p.priceUSD.max !== p.priceUSD.min ? `–${p.priceUSD.max}` : ''}`);
  if (p.priceCAD) L.push(`Price CAD: ${p.priceCAD.min}${p.priceCAD.max !== p.priceCAD.min ? `–${p.priceCAD.max}` : ''}`);
  if (p.totalStock) L.push(`In stock: ${p.totalStock} units`);
  if (p.variantCount) L.push(`Variants: ${p.variantCount}`);
  if (p.countryOfOrigin) L.push(`Origin: ${p.countryOfOrigin}`);
  return L.join('\n');
}

const SYSTEM = `You write product knowledge for a teamwear sales expert's reference library.
Given structured facts about ONE garment, write 90–150 words of natural, specific prose that a knowledgeable
outfitter would say when recommending it.

Rules:
- Use ONLY the facts given. Never invent prices, SKUs, fabrics, sizes or claims.
- Lead with what it is and who it suits (sport, level, team role).
- Weave in fabric/performance, decoration options, colour range and sizing where given.
- Mention custom sublimation or 3D design only if stated.
- Plain confident prose. No marketing hype, no bullet lists, no headings, no emoji.
- Do not restate the raw field labels.`;

/** GPT-5/o-series count REASONING tokens against max_completion_tokens — with a
 *  small budget they think the whole allowance away and return an empty string.
 *  This job is mechanical prose, so we disable reasoning entirely: same output,
 *  ~5x cheaper, and no empty responses. */
const isReasoning = /^(gpt-5|o[134])/.test(MODEL);
async function narrate(p: any): Promise<string> {
  const res = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: brief(p) }],
    max_completion_tokens: 600,
    ...(isReasoning ? { reasoning_effort: 'minimal' as any } : { temperature: 0.4 }),
  });
  return (res.choices[0]?.message?.content || '').trim();
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('journeyx');
  const P = db.collection('products');
  const D = db.collection('documents');

  const filter: any = { projectId: PROJECT_ID };
  if (!FORCE) filter.narrativeAt = { $exists: false };
  const products = await P.find(filter).limit(LIMIT ?? 0).toArray();
  console.log(`▶ generating narratives for ${products.length} products (model=${MODEL}, concurrency=${CONCURRENCY})`);

  let done = 0, failed = 0;
  const t0 = Date.now();

  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const batch = products.slice(i, i + CONCURRENCY);
    const texts = await Promise.all(batch.map(async (p: any) => {
      try { return await narrate(p); } catch (e) { failed++; console.error(`\n  ✗ ${p.parentSku}: ${(e as Error).message.slice(0, 80)}`); return ''; }
    }));

    const ok = batch.map((p, j) => ({ p, text: texts[j] })).filter((x) => x.text.length > 40);
    if (ok.length) {
      const embeddings = await embedTexts(ok.map((x) => x.text));
      const now = new Date();
      const ops = ok.map((x, j) => {
        const p: any = x.p;
        const url = p.web?.productUrl || `https://www.momentecbrands.com/${p.parentSku}`;
        return {
          updateOne: {
            filter: { projectId: PROJECT_ID, sourceUrl: url, chunkIndex: 0 },
            update: { $set: {
              projectId: PROJECT_ID, brand: PROJECT_ID, sourceUrl: url,
              title: p.name, content: x.text, chunk: x.text, chunkIndex: 0,
              metadata: {
                type: 'product', brand: PROJECT_ID, url,
                sku: p.parentSku,
                ...(p.priceUSD ? { price: p.priceUSD.min, currency: 'USD' } : {}),
                ...(p.category ? { category: p.category } : {}),
                ...(p.images?.length ? { images: p.images.slice(0, 12) } : {}),
                ...(p.colors?.length ? { colors: p.colors.slice(0, 24) } : {}),
                ...(p.sizes?.length ? { sizes: p.sizes } : {}),
                ...(p.web?.decorationMethods ? { decorationMethods: p.web.decorationMethods } : {}),
                ...(p.web?.is3D ? { is3D: true } : {}),
                ...(p.isSublimation ? { isSublimation: true } : {}),
                variantCount: p.variantCount,
              },
              embedding: embeddings[j], crawledAt: now, updatedAt: now,
            } },
            upsert: true,
          },
        };
      });
      await D.bulkWrite(ops as any[]);
      await P.bulkWrite(ok.map((x: any) => ({
        updateOne: { filter: { projectId: PROJECT_ID, parentSku: x.p.parentSku }, update: { $set: { narrative: x.text, narrativeAt: new Date() } } },
      })) as any[]);
      done += ok.length;
    }
    const rate = done / ((Date.now() - t0) / 1000);
    process.stdout.write(`\r   ${done}/${products.length} narratives (${rate.toFixed(1)}/s, ${failed} failed)   `);
  }

  console.log(`\n\n■ ${done} narratives generated + embedded in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min (${failed} failed)`);
  const sample = await P.findOne({ projectId: PROJECT_ID, narrative: { $exists: true } });
  if (sample) console.log(`\n   sample — ${(sample as any).parentSku} "${(sample as any).name}":\n   ${(sample as any).narrative.slice(0, 400)}`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
