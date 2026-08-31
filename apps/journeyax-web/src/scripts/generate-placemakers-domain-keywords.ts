/**
 * Grounded domain-keyword/synonym generation for PlaceMakers (NZ hardware /
 * building-materials tenant).
 *
 * Problem this fixes: `metadata.keywords` / product names only carry the
 * LITERAL source vocabulary ("Quadrant Stay", "vitex", "Keydeck"). A customer
 * asking for "uPVC casement window triple glazing" gets nothing back even
 * though real window-hardware products exist, because nothing in the corpus
 * links "casement" to "hinged/side-hung window" or NZ trade shorthand
 * ("dwang", "GIB", "H3.2") to what it actually means.
 *
 * Approach: group the 41k products by their real `subClassCode` (the most
 * granular real category grouping in the data — ~1,3xx distinct values,
 * matched 1:1 with `subClassName`/`categoryPath`). For each group, pull a
 * handful of REAL representative product names+descriptions and ask an LLM to
 * surface real, grounded equivalent search terms for that category. This is
 * ONE LLM call per category, not per product (41k products -> ~1.3k calls).
 *
 * Separately, one more LLM call generates a cross-cutting NZ trade-jargon
 * glossary (dwang, nogging, GIB, H1/H3.2, weatherboard vs cladding, etc.),
 * each entry tagged with the category-text keywords it should be considered
 * relevant to — so it isn't blindly applied to every product.
 *
 * Output is persisted to two new, additive collections:
 *   - placemakers_domain_keywords  { subClassCode, subClassName, categoryPath, sampleSkus, domainKeywords, generatedAt }
 *   - placemakers_domain_glossary  { terms: [{ term, meaning, synonyms, appliesToCategoryKeywords }], generatedAt }
 *
 * Nothing on `products` or `documents` is touched by this script — that's
 * `apply-placemakers-domain-keywords.ts`. Resumable: categories already
 * generated are skipped unless --force.
 *
 * Usage:
 *   npx tsx src/scripts/generate-placemakers-domain-keywords.ts [--force] [--limit N] [--glossary-only] [--categories-only]
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { MongoClient } from 'mongodb';
import OpenAI from 'openai';

const PROJECT_ID = 'placemakers';
const MODEL = process.env.INGEST_MODEL || 'gpt-5-mini';
const IS_REASONING = /^(gpt-5|o[134])/.test(MODEL);
const FORCE = process.argv.includes('--force');
const GLOSSARY_ONLY = process.argv.includes('--glossary-only');
const CATEGORIES_ONLY = process.argv.includes('--categories-only');
const limitArg = process.argv.find((a) => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || process.argv[process.argv.indexOf(limitArg) + 1] || '0', 10) : 0;
const onlyCatArg = process.argv.find((a) => a.startsWith('--only-categories'));
const ONLY_CATEGORIES = onlyCatArg ? (onlyCatArg.split('=')[1] || process.argv[process.argv.indexOf(onlyCatArg) + 1] || '').split(',').filter(Boolean) : [];

const openai = new OpenAI();

async function complete(system: string, user: string, maxTokens: number): Promise<string> {
  const r = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: maxTokens,
    ...(IS_REASONING ? { reasoning_effort: 'minimal' as any } : { temperature: 0.3 }),
  });
  return (r.choices[0]?.message?.content || '').trim();
}

function extractJson(raw: string): any {
  let s = raw.trim();
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  try { return JSON.parse(s); } catch { /* fall through */ }
  // last-ditch: find the largest balanced [...] or {...}
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch { /* noop */ } }
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch { /* noop */ } }
  return null;
}

const CATEGORY_SYSTEM = `You are a New Zealand building-materials and hardware trade expert helping a
retail search system understand customer vocabulary.

You will be given a real product category (its hierarchy) and 3-5 REAL sample
products from that exact category (name + short description). Based ONLY on
what those real products show you, produce a JSON array of 6-15 short search
terms/phrases a NZ customer or tradesperson might type that should surface
products in THIS category, but that do NOT already appear verbatim in the
category name or product names — i.e. real synonyms, equivalent terms,
NZ trade shorthand, generic/functional descriptions, or common misspellings.

Rules:
- Ground every term in what the sample products actually are. Do not invent
  products or claims about them.
- Prefer terms a real customer would type into search, not marketing copy.
- Lowercase, no punctuation beyond spaces/hyphens.
- Return ONLY a JSON array of strings, nothing else. Example:
  ["hinged window", "side-hung window", "window hardware", "opener stay"]`;

const GLOSSARY_SYSTEM = `You are a New Zealand building-materials and hardware trade expert.

You will be given a sample of real product category names (and a few real
product descriptions) drawn broadly across a large NZ building-supplies
catalogue. Produce a JSON array of 20-40 general NZ building-trade
shorthand/jargon glossary entries — cross-cutting terms that are not specific
to one category but that a customer or tradesperson might use instead of the
"proper" catalogue term. Examples of the KIND of term (do not just copy these,
find real ones grounded in what NZ trade practice actually uses and what the
given categories suggest): dwang/nogging (horizontal framing member), GIB
(genericised brand name for plasterboard/gib board), H1/H3.2/H4 (timber
treatment hazard class codes), weatherboard vs cladding, batten, waterproofing
membrane vs tanking, etc.

For each entry return:
{
  "term": "the shorthand/jargon term, lowercase",
  "meaning": "one short plain-English sentence explaining what it refers to",
  "synonyms": ["other ways customers phrase the same real thing"],
  "appliesToCategoryKeywords": ["lowercase keyword fragments that should appear in a product's category/subclass text for this glossary entry to be relevant to it, e.g. 'timber','framing','treated' for a treatment-code entry"]
}

Return ONLY a JSON array of these objects, nothing else.`;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('journeyx');
  const P = db.collection('products');
  const K = db.collection('placemakers_domain_keywords');
  const G = db.collection('placemakers_domain_glossary');

  await K.createIndex({ subClassCode: 1 }, { unique: true }).catch(() => {});

  // ── Cross-cutting glossary (one call) ────────────────────────────────
  if (!CATEGORIES_ONLY) {
    const existingGlossary = await G.findOne({ projectId: PROJECT_ID });
    if (existingGlossary && !FORCE) {
      console.log(`glossary: already generated (${existingGlossary.terms?.length || 0} terms) — skip (--force to redo)`);
    } else {
      console.log('glossary: sampling categories + products across the catalogue…');
      const catSample = await P.aggregate([
        { $match: { projectId: PROJECT_ID } },
        { $group: { _id: '$subClassCode', subClassName: { $first: '$subClassName' }, categoryPath: { $first: '$categoryPath' } } },
        { $sample: { size: 120 } },
      ]).toArray();
      const prodSample = await P.aggregate([
        { $match: { projectId: PROJECT_ID, description: { $exists: true, $ne: '' } } },
        { $sample: { size: 40 } },
        { $project: { name: 1, description: 1, category: 1 } },
      ]).toArray();

      const catLines = catSample.map((c: any) => `- ${(c.categoryPath || []).join(' > ') || c.subClassName}`).join('\n');
      const prodLines = prodSample.map((p: any) => `- ${p.name}: ${String(p.description || '').slice(0, 200)}`).join('\n');
      const user = `Categories sampled from the catalogue:\n${catLines}\n\nSample real products:\n${prodLines}`;

      const raw = await complete(GLOSSARY_SYSTEM, user, 4000);
      const parsed = extractJson(raw);
      const terms = Array.isArray(parsed) ? parsed.filter((t: any) => t && t.term) : [];
      if (!terms.length) {
        console.error('glossary: LLM did not return a usable JSON array — raw output:', raw.slice(0, 400));
      } else {
        await G.updateOne(
          { projectId: PROJECT_ID },
          { $set: { projectId: PROJECT_ID, terms, generatedAt: new Date(), model: MODEL } },
          { upsert: true },
        );
        console.log(`glossary: ${terms.length} cross-cutting NZ trade terms generated + stored`);
      }
    }
  }

  if (GLOSSARY_ONLY) { await client.close(); return; }

  // ── Per-category (subClassCode) synonym generation ───────────────────
  console.log('categories: grouping products by subClassCode…');
  const groups = await P.aggregate([
    { $match: { projectId: PROJECT_ID, subClassCode: { $exists: true, $ne: null } } },
    { $group: {
      _id: '$subClassCode',
      subClassName: { $first: '$subClassName' },
      categoryPath: { $first: '$categoryPath' },
      category: { $first: '$category' },
      count: { $sum: 1 },
      samples: { $push: { parentSku: '$parentSku', name: '$name', description: '$description' } },
    } },
    { $sort: { count: -1 } },
  ]).toArray();
  console.log(`categories: ${groups.length} distinct subClassCode group(s), ${groups.reduce((n: number, g: any) => n + g.count, 0)} products covered`);

  const already = FORCE ? new Set<string>() : new Set((await K.distinct('subClassCode', { projectId: PROJECT_ID })));
  if (already.size) console.log(`categories: resuming — ${already.size} already generated, skipping`);

  let todo = groups.filter((g: any) => !already.has(g._id));
  if (ONLY_CATEGORIES.length) todo = todo.filter((g: any) => ONLY_CATEGORIES.includes(g._id));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`categories: ${todo.length} to generate`);

  const CONC = 6;
  let done = 0, ok = 0, failed = 0;
  for (let i = 0; i < todo.length; i += CONC) {
    const batch = todo.slice(i, i + CONC);
    await Promise.all(batch.map(async (g: any) => {
      try {
        const samples = (g.samples || []).slice(0, 5)
          .map((s: any) => `- ${s.name}${s.description ? `: ${String(s.description).slice(0, 250)}` : ''}`)
          .join('\n');
        const catText = (g.categoryPath || []).join(' > ') || g.category || g.subClassName;
        const user = `Category: ${catText}\nSub-category: ${g.subClassName}\n\nReal sample products (${g.count} total in this category):\n${samples}`;
        const raw = await complete(CATEGORY_SYSTEM, user, 700);
        const parsed = extractJson(raw);
        const keywords = Array.isArray(parsed)
          ? [...new Set(parsed.filter((x: any) => typeof x === 'string' && x.trim()).map((x: string) => x.trim().toLowerCase()))]
          : [];
        await K.updateOne(
          { projectId: PROJECT_ID, subClassCode: g._id },
          { $set: {
            projectId: PROJECT_ID, subClassCode: g._id, subClassName: g.subClassName,
            categoryPath: g.categoryPath, category: g.category, productCount: g.count,
            sampleSkus: (g.samples || []).slice(0, 5).map((s: any) => s.parentSku),
            domainKeywords: keywords, generatedAt: new Date(), model: MODEL,
          } },
          { upsert: true },
        );
        if (keywords.length) ok++; else failed++;
      } catch (e) {
        failed++;
        console.error(`  fail ${g._id} (${g.subClassName}): ${(e as Error).message.slice(0, 120)}`);
      }
    }));
    done += batch.length;
    if (done % 30 === 0 || done >= todo.length) console.log(`  ${done}/${todo.length} · ok=${ok} failed=${failed}`);
  }

  console.log(JSON.stringify({ totalGroups: groups.length, generated: done, ok, failed }, null, 2));
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
