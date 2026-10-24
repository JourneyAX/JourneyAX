#!/usr/bin/env node
/**
 * Conversation Quality Evaluation Runner (PlaceMakers 100 Prompts)
 *
 * Runs test prompts in-process through the canonical JourneyAX runtime,
 * captures structured timing, cards, and assistant replies, and evaluates:
 * 1. Answer not empty
 * 2. No internal IDs leaked to customer text
 * 3. Forbidden claims absent (claim guard)
 * 4. Expected SKU or product attributes present for product lookups
 * 5. Ground truth requirements met for advice, project, safety, and vocabulary
 *
 * Classifies prompts by type:
 *   product_lookup, advice, project, vocabulary, education, safety, garbled
 *
 * Usage:
 *   npx tsx scripts/eval/run-conversation-eval.ts [--prompts <path>] [--output <path>] [--report <path>] [--mock] [--real] [--limit <n>]
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { buildPlaceMakersStack, TENANT, ENVIRONMENT } from '../../apps/journey-runtime-service/test/helpers/placemakers-stack';
import { validateOkfGeneratedClaims } from '../../apps/journey-runtime-service/src/kernel/okf-claim-validator';
import { ModelGateway } from '../../apps/journey-runtime-service/src/kernel/model.gateway';
import { extractProductAttributes } from '../../packages/ingestion/src/populators/product.populators';
import { resolveAttributeEquivalence } from '../../apps/journey-runtime-service/src/capabilities/handlers/catalog-search.handler';

if (typeof (process as any).loadEnvFile === 'function' && fs.existsSync('.env')) {
  try {
    (process as any).loadEnvFile('.env');
  } catch {}
}

export type PromptType =
  | 'product_lookup'
  | 'advice'
  | 'project'
  | 'vocabulary'
  | 'education'
  | 'safety'
  | 'garbled';

export interface EvalTestCase {
  id: number;
  category: string;
  prompt: string | string[];
  purpose: string;
  groundTruthReference: string;
  groundTruthUrls?: string;
  expectedType?: PromptType;
  expectedTypeReason?: string;
}

export interface ToolInvocationRecord {
  name: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  arguments?: any;
  resultCount?: number;
  /** The start of what the tool returned (only when the run sets AGENT_TRACE_RESULTS=1). */
  resultPreview?: string;
}

export interface EvalTurnResult {
  id: number;
  category: string;
  promptType: PromptType;
  prompt: string | string[];
  purpose: string;
  groundTruthReference: string;
  assistantMessage: string;
  cards: string[];
  /** What each card on the last turn holds (for example a question card's questions and options), for reading a run by eye. */
  cardStates?: any[];
  toolCalls: number;
  toolsCalled: string[];
  toolInvocations: ToolInvocationRecord[];
  timing: {
    timeToFirstEventMs: number | null;
    timeToFirstTextMs: number | null;
    interpretMs: number;
    responseMs: number;
    phraseMs: number;
    retrievalMs: number;
    totalMs: number;
    modelCalls: number;
    tokens: { prompt: number; completion: number; total: number };
  };
  checks: {
    answerNotEmpty: boolean;
    noInternalIds: boolean;
    forbiddenClaimsAbsent: boolean;
    expectedSkuPresent: boolean;
    groundTruthMet: boolean;
  };
  passed: boolean;
  failureReasons: string[];
}

export interface CategoryStats {
  category: string;
  total: number;
  passed: number;
  passRate: number;
}

export interface PromptTypeStats {
  type: PromptType;
  total: number;
  passed: number;
  passRate: number;
}

const KNOWN_BRANDS = [
  'makita', 'dewalt', 'milwaukee', 'hikoki', 'senco', 'bremick', 'ecko',
  'gib', 'pink batts', 'james hardie', 'resene', 'marley', 'dux', 'simpson',
  'tolsen', 'stanley', 'irwin', 'firth', 'sika', 'holdfast', 'selleys',
  'wattyl', 'colour lab', 'bostik', 'gorilla', 'paslode', 'fuller',
  'blu-mol', 'iplex', 'novadrain', 'st michel', 'keyland', 'primewood'
];

/**
 * Classifies a prompt into one of 7 standard evaluation types and determines
 * if a specific SKU match is expected.
 */
export function classifyPrompt(tc: EvalTestCase): {
  type: PromptType;
  expectsSpecificSku: boolean;
} {
  // If the test case specifies an expectedType explicitly, honor it directly
  if (tc.expectedType) {
    const expectsSpecificSku = tc.expectedType === 'product_lookup';
    return { type: tc.expectedType, expectsSpecificSku };
  }

  const promptStr = Array.isArray(tc.prompt) ? tc.prompt.join(' ') : tc.prompt;
  const pLower = promptStr.toLowerCase();
  const purposeLower = tc.purpose.toLowerCase();
  const refLower = tc.groundTruthReference.toLowerCase();

  // 1. Garbled / gibberish
  if (pLower.includes('asdkfj') || purposeLower.includes('gibberish')) {
    return { type: 'garbled', expectsSpecificSku: false };
  }

  // 2. Safety / hazard / code compliance / legal restrictions
  if (
    purposeLower.includes('safety') ||
    purposeLower.includes('structural advice boundary') ||
    purposeLower.includes('hazard') ||
    pLower.includes('safe to use') ||
    pLower.includes('electrical wiring') ||
    pLower.includes('power outlets') ||
    pLower.includes('load bearing') ||
    pLower.includes('load-bearing')
  ) {
    return { type: 'safety', expectsSpecificSku: false };
  }

  // 3. Vocabulary / local trade slang / terminology
  if (
    purposeLower.includes('colloquial') ||
    purposeLower.includes('jargon') ||
    purposeLower.includes('synonym') ||
    pLower.includes("what's a dwang") ||
    pLower.includes("what's that called here") ||
    pLower.includes('find me a jib')
  ) {
    return { type: 'vocabulary', expectsSpecificSku: false };
  }

  // 4. Education / comparative concepts
  if (
    purposeLower.includes('comparative') ||
    purposeLower.includes('educational') ||
    purposeLower.includes('not a direct product search') ||
    pLower.startsWith("what's the difference") ||
    pLower.startsWith("what is the difference")
  ) {
    return { type: 'education', expectsSpecificSku: false };
  }

  // 5. Project / broad planning
  if (
    tc.category === 'Vague DIY Project Prompts' ||
    purposeLower.includes('vague project') ||
    purposeLower.includes('project starter') ||
    pLower.startsWith('i want to build') ||
    pLower.startsWith('help me build') ||
    pLower.startsWith("i'm renovating") ||
    pLower.startsWith('help me plan') ||
    pLower.startsWith('i want to insulate my house')
  ) {
    return { type: 'project', expectsSpecificSku: false };
  }

  // 6. Advice / technical recommendations
  if (
    purposeLower.includes('advisory') ||
    purposeLower.includes('recommendation') ||
    purposeLower.includes('tool-for-task') ||
    purposeLower.includes('tool-for-material') ||
    purposeLower.includes('technical advisory') ||
    refLower.includes('content page') ||
    refLower.includes('no single sku') ||
    refLower.includes('advisory query') ||
    pLower.startsWith('what size timber') ||
    pLower.startsWith('what finish is best') ||
    pLower.startsWith('what primer should i use') ||
    pLower.startsWith('what drill should i use') ||
    pLower.startsWith('what trimmer should i use') ||
    pLower.startsWith('what saw do i need') ||
    pLower.startsWith('what drill bit should i use') ||
    pLower.startsWith('what tool should i use') ||
    pLower.startsWith('what plumbing tools do i need') ||
    pLower.startsWith('what fittings do i need') ||
    pLower.startsWith('what do i need for') ||
    pLower.startsWith("what's the best")
  ) {
    return { type: 'advice', expectsSpecificSku: false };
  }

  // 7. Product Lookup (direct product, SKU, dimension, brand search)
  const hasNoSingleSku =
    refLower.includes('no single sku') ||
    refLower.includes('no feed match is "the" right answer') ||
    refLower.includes('not in feed') ||
    refLower.includes('not verified in this feed');
  const expectsSpecificSku = !hasNoSingleSku;

  return { type: 'product_lookup', expectsSpecificSku };
}

function parseArgs(): {
  promptsPath: string;
  outputPath: string;
  reportPath: string;
  useRealModel: boolean;
  useAgentMode: boolean;
  limit: number | null;
} {
  const args = process.argv.slice(2);
  let promptsPath = path.resolve('docs/evals/placemakers-100.json');
  const today = new Date().toISOString().slice(0, 10);
  let outputPath = path.resolve(`docs/evals/eval-results-${Date.now()}.json`);
  let reportPath = path.resolve(`docs/evals/baseline-${today}.md`);
  let useRealModel = false;
  let useAgentMode = true;
  let limit: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompts' && args[i + 1]) {
      promptsPath = path.resolve(args[++i]);
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = path.resolve(args[++i]);
    } else if (args[i] === '--report' && args[i + 1]) {
      reportPath = path.resolve(args[++i]);
    } else if (args[i] === '--real') {
      useRealModel = true;
    } else if (args[i] === '--mock') {
      useRealModel = false;
    } else if (args[i] === '--agent') {
      useAgentMode = true;
    } else if (args[i] === '--rule-based') {
      useAgentMode = false;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    }
  }

  return { promptsPath, outputPath, reportPath, useRealModel, useAgentMode, limit };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

/** Extracts expected SKUs from ground-truth reference and URLs. */
export function extractExpectedSkus(reference: string, urls?: string): string[] {
  const skus = new Set<string>();
  const refMatches = reference.match(/\bSKU\s+(\d+)\b/gi) || [];
  for (const m of refMatches) {
    const num = m.replace(/[^\d]/g, '');
    if (num) skus.add(num);
  }
  if (urls) {
    const urlMatches = urls.match(/\/p\/(\d+)\b/g) || [];
    for (const m of urlMatches) {
      const num = m.replace(/[^\d]/g, '');
      if (num) skus.add(num);
    }
  }
  return [...skus];
}

/** Check if answer has internal ids or platform internals leaked. */
export function checkNoInternalIds(text: string): boolean {
  if (!text) return true;
  const leaksInternalPattern = /(concept:\/\/|[a-f0-9]{24}|stage_[a-z0-9_]+|tool\.[a-z0-9_]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/i;
  return !leaksInternalPattern.test(text);
}

/**
 * Loads PlaceMakers products CSV into the in-memory db with robust parsing,
 * MSRP price mapping, Main_Image_URL mapping, discontinued product exclusion,
 * and index-time attribute extraction.
 */
export async function loadPlacemakersCsvProducts(db: any): Promise<number> {
  const csvPath = path.resolve('apps/journeyax-web/public/data/placemakers-products.csv');
  if (!fs.existsSync(csvPath)) return 0;

  // Load catalog mapping attribute definitions if available
  const mappingPath = path.resolve('docs/migrations/placemakers-catalog-mapping.json');
  let attributeDefinitions: any = undefined;
  if (fs.existsSync(mappingPath)) {
    try {
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
      attributeDefinitions = mapping.catalogMapping?.attributeDefinitions;
    } catch {}
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const records: any[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  // The live products carry their full category path; the CSV only has the leaf. When the crawl master is available, use it so
  // category-path filters behave here as they do on the real catalogue.
  const hierarchy = new Map<string, string[]>();
  const masterPath = process.env.PLACEMAKERS_MASTER_JSONL;
  if (masterPath && fs.existsSync(masterPath)) {
    let rest = '';
    const take = (line: string) => { if (!line) return; try { const o = JSON.parse(line); if (o.sku && Array.isArray(o.categoryPathNames) && Array.isArray(o.categoryPathNames[0])) hierarchy.set(String(o.sku), o.categoryPathNames[0].map(String)); } catch {} };
    const fd = fs.openSync(masterPath, 'r'); const buf = Buffer.alloc(1 << 20); let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { rest += buf.toString('utf8', 0, n); let i: number; while ((i = rest.indexOf('\n')) >= 0) { take(rest.slice(0, i)); rest = rest.slice(i + 1); } }
    take(rest); fs.closeSync(fd);
  }

  const products: any[] = [];

  for (const r of records) {
    // Exclude discontinued products
    if (r.Status && r.Status.trim().toLowerCase() === 'discontinued') {
      continue;
    }

    const sku = (r.Item_SKU || r.Parent_SKU || '').trim();
    const name = (r.Item_Name || '').trim();
    if (!sku || !name) continue;

    const brand = (r.Brand || '').trim();
    const category = (r.Category || 'General').trim();
    const description = (r.Item_Description || name).trim();
    // Map price from MSRP (falling back to OriginalPrice or default)
    const rawPrice = (r.MSRP || r.OriginalPrice || '0').replace(/[^0-9.]/g, '');
    const price = parseFloat(rawPrice) || 15.0;
    // Map image from Main_Image_URL
    const imageUrl = (r.Main_Image_URL || '').trim() || undefined;

    // Index-time extraction using attribute definitions
    const attributes = extractProductAttributes(
      {
        name,
        title: name,
        description,
        features: r.Features,
        category,
        specs: {},
      },
      attributeDefinitions
    );

    const doc: any = {
      projectId: TENANT,
      sku,
      name,
      title: name,
      brand,
      category,
      categoryPath: hierarchy.get(sku) || [category],
      description: brand ? `${brand} ${description}` : description,
      features: (r.Features || '').trim() || undefined,
      priceUSD: { min: price },
      currency: 'NZD',
      imageUrl,
      variants: [
        {
          itemSku: sku,
          msrpUSD: price,
          mainImage: imageUrl,
          status: r.Status || 'Active',
        },
      ],
    };

    if (Object.keys(attributes).length > 0) {
      doc.attributes = attributes;
    }

    // Do NOT mark every product inStock: true (omit or set from stock fields)
    if (r.Stock_Status || r.In_Stock) {
      doc.inStock = String(r.Stock_Status || r.In_Stock).toLowerCase() === 'in_stock';
    }

    products.push(doc);
  }

  if (products.length > 0) {
    await db.collection('products').insertMany(products);
  }
  return products.length;
}

export interface RequestedAttributes {
  sizeVariants: string[];
  treatmentVariants: string[];
  rValueVariants: string[];
  brand?: string;
  keyword?: string;
}

/** Extracts requested attributes from a prompt and its ground-truth reference. */
export function extractRequestedAttributes(
  prompt: string,
  reference?: string,
  attributeDefinitions?: Record<string, any>
): RequestedAttributes {
  const pLower = prompt.toLowerCase();
  const sizeVariants: string[] = [];
  const treatmentVariants: string[] = [];
  const rValueVariants: string[] = [];

  // Size patterns: e.g. 100x50, 100 x 50mm, 4x2, 32mm, 6g x 25mm
  const sizePatterns = [
    /\b(\d{2,4}\s*[xX*×]\s*\d{2,4}(?:\s*[xX*×]\s*\d{2,4})?(?:\s*mm)?)\b/,
    /\b([2-9]|10|12)\s*[xX*×]\s*([1-9]|10|12)\b/,
    /\b(\d+(?:\.\d+)?\s*mm)\b/,
    /\b(\d+g(?:\s*x\s*\d+mm)?)\b/i,
  ];

  for (const pat of sizePatterns) {
    const m = prompt.match(pat);
    if (m) {
      const raw = m[1] || m[0];
      const equiv = resolveAttributeEquivalence('size', raw, attributeDefinitions?.size);
      for (const v of equiv) sizeVariants.push(v);
      break;
    }
  }

  // Treatment patterns: e.g. H3.2, H1.2, H4, H5, CCA, Boron
  const treatMatch = prompt.match(/\b(H\s*[1-6](?:\.[1-2])?|CCA|Boron|LOSP|Untreated|UT)\b/i);
  if (treatMatch) {
    const raw = treatMatch[1];
    const equiv = resolveAttributeEquivalence('treatment', raw, attributeDefinitions?.treatment);
    for (const v of equiv) treatmentVariants.push(v);
  }

  // R-value patterns: e.g. R2.2, R2.6, R1.9
  const rMatch = prompt.match(/\b(R\s*[1-7](?:\.[0-9])?)\b/i);
  if (rMatch) {
    const raw = rMatch[1];
    const equiv = resolveAttributeEquivalence('rValue', raw, attributeDefinitions?.rValue);
    for (const v of equiv) rValueVariants.push(v);
  }

  // Brand pattern
  let brand: string | undefined;
  for (const b of KNOWN_BRANDS) {
    const rx = new RegExp(`\\b${b}\\b`, 'i');
    if (rx.test(pLower)) {
      brand = b;
      break;
    }
  }

  // Category / keyword noun
  const categoryKeywords = [
    'timber', 'decking', 'insulation', 'screws', 'screw', 'nails', 'nail',
    'bracket', 'brackets', 'plywood', 'primer', 'paint', 'pipe', 'pipes',
    'fitting', 'fittings', 'paver', 'pavers', 'clothesline', 'saw', 'drill',
    'plunger', 'tap', 'mixer', 'shower', 'toilet', 'vanity', 'batts',
    'fertiliser', 'weedkiller', 'adhesive', 'cladding', 'roofing', 'shed',
    'cabinet', 'fence', 'paling', 'rails', 'post', 'posts', 'joist', 'joists'
  ];
  let keyword: string | undefined;
  for (const kw of categoryKeywords) {
    const rx = new RegExp(`\\b${kw}\\b`, 'i');
    if (rx.test(pLower)) {
      keyword = kw;
      break;
    }
  }

  return { sizeVariants, treatmentVariants, rValueVariants, brand, keyword };
}

/**
 * Scores a product lookup prompt by checking:
 * 1. Exact SKU match in shown products or assistant message, OR
 * 2. Requested product attributes (size, grade/treatment, brand, category) found
 *    in titles, specs, and attributes of products shown.
 */
export async function checkProductLookupMatch(params: {
  tc: EvalTestCase;
  expectedSkus: string[];
  assistantMessage: string;
  uiInstructions: any[];
  toolProductSkus: string[];
  toolsCalled?: any[];
  db: any;
  attributeDefinitions?: Record<string, any>;
}): Promise<{ matched: boolean; reason?: string; matchedSku?: string }> {
  const { tc, expectedSkus, assistantMessage, uiInstructions, toolProductSkus, toolsCalled, db, attributeDefinitions } = params;

  // 1. Collect all shown SKUs from trace, UI instructions, and message text
  const allShownSkus = new Set<string>();
  for (const sku of toolProductSkus || []) {
    if (sku) allShownSkus.add(String(sku).trim());
  }
  for (const ui of uiInstructions || []) {
    const card = ui.envelope?.arguments?.card || ui.card;
    if (card?.sku) allShownSkus.add(String(card.sku).trim());
    if (Array.isArray(card?.products)) {
      for (const p of card.products) {
        if (p?.sku) allShownSkus.add(String(p.sku).trim());
      }
    }
  }
  const msgSkus = assistantMessage.match(/\b\d{6,7}\b/g) || [];
  for (const s of msgSkus) allShownSkus.add(s);

  // Check if any expected SKU is present
  if (expectedSkus.length > 0) {
    const uiStr = JSON.stringify(uiInstructions || []);
    for (const exp of expectedSkus) {
      if (allShownSkus.has(exp) || assistantMessage.includes(exp) || uiStr.includes(exp)) {
        return { matched: true, matchedSku: exp };
      }
    }
  }

  // 2. Not-in-feed or no single SKU check
  const refLower = (tc.groundTruthReference || '').toLowerCase();
  const isNotInFeed =
    refLower.includes('not in feed') ||
    refLower.includes('not verified in this feed') ||
    refLower.includes('no single sku');
  if (isNotInFeed) {
    const clarifies =
      /not\s+(?:stocked|available|found|in\s+our\s+catalogue|in\s+stock)|do\s+not\s+(?:stock|carry|have)|alternatives?|recommend/i.test(assistantMessage) ||
      allShownSkus.size > 0;
    if (clarifies) {
      return { matched: true, reason: 'Correctly handled unstocked or alternative query' };
    }
  }

  // 3. Attribute-based matching on shown products
  const promptStr = Array.isArray(tc.prompt) ? tc.prompt.join(' ') : tc.prompt;
  const requested = extractRequestedAttributes(promptStr, tc.groundTruthReference, attributeDefinitions);

  let shownProducts: any[] = [];
  if (db && allShownSkus.size > 0) {
    try {
      shownProducts = await db.collection('products').find({
        sku: { $in: Array.from(allShownSkus) }
      }).toArray();
    } catch {}
  }

  // Fallback: If no products found in DB for shown SKUs, check if assistantMessage conveys the attributes
  if (shownProducts.length === 0) {
    let allMentioned = true;
    if (requested.sizeVariants.length > 0) {
      const msgHasSize = requested.sizeVariants.some(v => assistantMessage.toLowerCase().includes(v.toLowerCase()));
      if (!msgHasSize) allMentioned = false;
    }
    if (requested.treatmentVariants.length > 0) {
      const msgHasTreat = requested.treatmentVariants.some(v => assistantMessage.toLowerCase().includes(v.toLowerCase()));
      if (!msgHasTreat) allMentioned = false;
    }
    if (requested.brand) {
      if (!assistantMessage.toLowerCase().includes(requested.brand.toLowerCase())) allMentioned = false;
    }
    if (allMentioned && (requested.sizeVariants.length > 0 || requested.treatmentVariants.length > 0 || requested.brand)) {
      return { matched: true, reason: 'Attributes mentioned in assistant response' };
    }
    return { matched: false, reason: 'No matching products shown and attributes not mentioned' };
  }

  // Inspect each product against requested attributes
  for (const product of shownProducts) {
    const pTitle = (product.title || product.name || '').toLowerCase();
    const pDesc = (product.description || '').toLowerCase();
    const pCat = (product.category || '').toLowerCase();
    const pAttrs = product.attributes || {};
    const pText = `${pTitle} ${pDesc} ${pCat}`;

    // Size check
    if (requested.sizeVariants.length > 0) {
      const pSize = (pAttrs.size || '').toLowerCase();
      const matchesSize = requested.sizeVariants.some(v => {
        const vNorm = v.toLowerCase().replace(/\s+/g, '');
        return pSize.replace(/\s+/g, '') === vNorm || pText.includes(v.toLowerCase());
      });
      if (!matchesSize) continue;
    }

    // Treatment check
    if (requested.treatmentVariants.length > 0) {
      const pTreat = (pAttrs.treatment || '').toLowerCase();
      const matchesTreat = requested.treatmentVariants.some(v => {
        const vNorm = v.toLowerCase().replace(/\s+/g, '');
        return pTreat.replace(/\s+/g, '') === vNorm || pText.includes(v.toLowerCase());
      });
      if (!matchesTreat) continue;
    }

    // R-value check
    if (requested.rValueVariants.length > 0) {
      const pR = (pAttrs.rValue || '').toLowerCase();
      const matchesR = requested.rValueVariants.some(v => {
        const vNorm = v.toLowerCase().replace(/\s+/g, '');
        return pR.replace(/\s+/g, '') === vNorm || pText.includes(v.toLowerCase());
      });
      if (!matchesR) continue;
    }

    // Brand check
    if (requested.brand) {
      const pBrand = (product.brand || '').toLowerCase();
      const matchesBrand = pBrand.includes(requested.brand) || pText.includes(requested.brand);
      if (!matchesBrand) continue;
    }

    // Category / Keyword check
    if (requested.keyword) {
      const matchesKeyword = pCat.includes(requested.keyword) || pText.includes(requested.keyword);
      if (!matchesKeyword) continue;
    }

    // All specified criteria matched for this product
    return { matched: true, matchedSku: product.sku };
  }

  return { matched: false, reason: 'Shown products did not match all requested attributes' };
}

function extractKeyAdviceTerms(tc: EvalTestCase): string[] {
  const terms = new Set<string>();
  const ref = tc.groundTruthReference || '';
  const quoted = ref.match(/"([^"]+)"/g) || [];
  for (const q of quoted) {
    const clean = q.replace(/"/g, '').trim().toLowerCase();
    if (clean.length > 2 && !clean.startsWith('http')) {
      terms.add(clean);
      const words = clean.split(/\s+/).filter(w => w.length > 3);
      for (const w of words) terms.add(w);
    }
  }

  const pLower = (Array.isArray(tc.prompt) ? tc.prompt.join(' ') : tc.prompt).toLowerCase();
  if (pLower.includes('masonry')) { terms.add('masonry'); terms.add('sds'); terms.add('hammer'); terms.add('drill'); }
  if (pLower.includes('treated timber') && pLower.includes('saw')) { terms.add('circular saw'); terms.add('hand saw'); terms.add('saw'); }
  if (pLower.includes('hedges')) { terms.add('hedge trimmer'); terms.add('trimmer'); terms.add('shears'); }
  if (pLower.includes('tiles') && pLower.includes('drill')) { terms.add('tile'); terms.add('ceramic'); terms.add('diamond'); terms.add('masonry'); }
  if (pLower.includes('plywood') && pLower.includes('tool')) { terms.add('circular saw'); terms.add('track saw'); terms.add('jigsaw'); terms.add('saw'); }
  if (pLower.includes('mdf') && pLower.includes('primer')) { terms.add('primer'); terms.add('sealer'); terms.add('undercoat'); }
  if (pLower.includes('decking') && pLower.includes('screw')) { terms.add('screw'); terms.add('10g'); terms.add('12g'); terms.add('65mm'); terms.add('50mm'); terms.add('stainless'); }
  if (pLower.includes('retaining wall') && pLower.includes('fixing')) { terms.add('coach'); terms.add('bolt'); terms.add('screw'); terms.add('hex'); }
  if (pLower.includes('plumbing tools')) { terms.add('wrench'); terms.add('plunger'); terms.add('spanner'); terms.add('pliers'); }
  if (pLower.includes('different sizes') && pLower.includes('fittings')) { terms.add('reducer'); terms.add('reducing'); terms.add('adapter'); terms.add('coupling'); }
  if (pLower.includes('paving') && pLower.includes('driveway')) { terms.add('paver'); terms.add('paving'); terms.add('concrete'); terms.add('50mm'); terms.add('80mm'); }
  if (pLower.includes('joists') && pLower.includes('timber')) { terms.add('150x50'); terms.add('140x45'); terms.add('200x50'); terms.add('190x45'); terms.add('joist'); terms.add('span'); }
  if (pLower.includes('kwila')) { terms.add('oil'); terms.add('stain'); terms.add('protect'); terms.add('seal'); }
  if (pLower.includes('r-value')) { terms.add('ceiling'); terms.add('wall'); terms.add('r2.2'); terms.add('r2.6'); terms.add('insulation'); }
  if (pLower.includes('plasterboard') && pLower.includes('thickness')) { terms.add('10mm'); terms.add('13mm'); terms.add('gib'); }

  return Array.from(terms);
}

function extractKeyProjectTerms(tc: EvalTestCase): string[] {
  const terms = new Set<string>();
  const pLower = (Array.isArray(tc.prompt) ? tc.prompt.join(' ') : tc.prompt).toLowerCase();
  if (pLower.includes('cabinet')) { terms.add('mdf'); terms.add('panel'); terms.add('handle'); terms.add('knob'); terms.add('hinge'); terms.add('glue'); terms.add('screws'); }
  if (pLower.includes('deck')) { terms.add('deck'); terms.add('timber'); terms.add('post'); terms.add('bearer'); terms.add('joist'); terms.add('bracket'); terms.add('screws'); }
  if (pLower.includes('fence')) { terms.add('fence'); terms.add('post'); terms.add('rail'); terms.add('paling'); terms.add('concrete'); }
  if (pLower.includes('shed')) { terms.add('shed'); terms.add('kitset'); terms.add('timber'); terms.add('framing'); terms.add('roofing'); }
  if (pLower.includes('insulate') || pLower.includes('insulation')) { terms.add('insulation'); terms.add('batts'); terms.add('ceiling'); terms.add('wall'); terms.add('underfloor'); terms.add('r-value'); terms.add('pink batts'); }
  if (pLower.includes('bathroom')) { terms.add('sink'); terms.add('mixer'); terms.add('shower'); terms.add('toilet'); terms.add('tile'); terms.add('vanity'); terms.add('plumbing'); }
  if (pLower.includes('kitchen')) { terms.add('cabinet'); terms.add('benchtop'); terms.add('tap'); terms.add('mixer'); terms.add('kitchen'); }
  if (pLower.includes('pergola')) { terms.add('pergola'); terms.add('post'); terms.add('beam'); terms.add('rafter'); terms.add('bracket'); terms.add('roofing'); }
  if (pLower.includes('landscaping')) { terms.add('paver'); terms.add('weed'); terms.add('fertiliser'); terms.add('rake'); terms.add('garden'); terms.add('landscape'); }
  return Array.from(terms);
}

/**
 * Scores advice, project, safety, and vocabulary prompts against ground truth requirements.
 */
export function checkGroundTruthRequirements(params: {
  tc: EvalTestCase;
  promptType: PromptType;
  assistantMessage: string;
  cards: string[];
  toolProductSkus: string[];
}): { met: boolean; reason?: string } {
  const { tc, promptType, assistantMessage, cards, toolProductSkus } = params;
  const msgLower = assistantMessage.toLowerCase();

  switch (promptType) {
    case 'safety': {
      const hasSafetyNotice =
        /safety|hazard|danger|risk|shock|electrician|certified|licensed|turn off|shut off|precaution|warning|caution|careful/i.test(assistantMessage);
      if (!hasSafetyNotice) {
        return { met: false, reason: 'Missing safety precaution, hazard awareness, or disclaimer' };
      }
      return { met: true };
    }

    case 'project': {
      const asksClarification =
        /\?/.test(assistantMessage) &&
        /(?:what|which|how|where|when|size|dimensions?|measurements?|type|material|scope|budget|length|height|area|indoor|outdoor)/i.test(assistantMessage);

      const projectComponents = extractKeyProjectTerms(tc);
      const mentionsComponents = projectComponents.some(term => msgLower.includes(term.toLowerCase()));

      if (!asksClarification && !mentionsComponents && toolProductSkus.length === 0) {
        return { met: false, reason: 'Response neither asked clarifying scoping questions nor recommended relevant project materials' };
      }
      return { met: true };
    }

    case 'advice': {
      const keyTerms = extractKeyAdviceTerms(tc);
      const matchesTerm = keyTerms.some(term => msgLower.includes(term.toLowerCase()));
      if (!matchesTerm && toolProductSkus.length === 0 && cards.length === 0) {
        return { met: false, reason: 'Response did not address the key advisory concepts or recommendations from the ground truth' };
      }
      return { met: true };
    }

    case 'vocabulary': {
      const promptStr = (Array.isArray(tc.prompt) ? tc.prompt.join(' ') : tc.prompt).toLowerCase();
      if (promptStr.includes('dwang')) {
        const explainsDwang = /nogging|blocking|timber|framing|stud|horizontal/i.test(assistantMessage);
        if (!explainsDwang) return { met: false, reason: 'Did not explain local trade term dwang' };
      }
      return { met: true };
    }

    case 'education':
    case 'garbled':
    case 'product_lookup':
    default:
      return { met: true };
  }
}

async function main() {
  const { promptsPath, outputPath, reportPath, useRealModel, useAgentMode, limit } = parseArgs();

  console.log(`Loading test prompts from: ${promptsPath}`);
  if (!fs.existsSync(promptsPath)) {
    console.error(`Error: Prompts file not found at ${promptsPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(promptsPath, 'utf8');
  let testCases: EvalTestCase[] = JSON.parse(raw);
  if (limit && limit > 0) {
    testCases = testCases.slice(0, limit);
    console.log(`Limiting evaluation to first ${limit} test cases.`);
  }

  console.log(`Setting up in-process PlaceMakers runtime stack (${useRealModel ? 'real model gateway' : 'scripted fake model server'} | ${useAgentMode ? 'Agent Mode' : 'Rule-Based Mode'})...`);
  const stack = await buildPlaceMakersStack({ agentMode: useAgentMode });
  const loadedCount = await loadPlacemakersCsvProducts(stack.db);
  console.log(`Loaded ${loadedCount} catalogue products into in-memory store.`);

  // Load catalog mapping attribute definitions for evaluation scoring
  const mappingPath = path.resolve('docs/migrations/placemakers-catalog-mapping.json');
  let attributeDefinitions: any = undefined;
  if (fs.existsSync(mappingPath)) {
    try {
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
      attributeDefinitions = mapping.catalogMapping?.attributeDefinitions;
    } catch {}
  }

  const service = stack.serviceFor({
    servePacks: true,
    modelGateway: useRealModel ? new ModelGateway() : undefined,
  });

  const evalResults: EvalTurnResult[] = [];
  let completed = 0;
  console.log(`\nRunning ${testCases.length} evaluation turns...`);

  for (const tc of testCases) {
    const classification = classifyPrompt(tc);
    const turns = Array.isArray(tc.prompt) ? tc.prompt : [tc.prompt];
    const workspaceId = `eval-ws-${tc.id}-${Date.now()}`;
    let lastResult: any = null;
    let aggregateTiming: any = null;

    for (let turnIdx = 0; turnIdx < turns.length; turnIdx++) {
      const turnMsg = turns[turnIdx];
      const turnId = `turn-${tc.id}-${turnIdx + 1}`;

      const res = await service.executeTurn({
        tenantId: TENANT,
        environmentId: ENVIRONMENT,
        workspaceId,
        turnId,
        message: turnMsg,
      });
      lastResult = res;
      if (res.trace?.timing) {
        aggregateTiming = res.trace.timing;
      }
    }

    const assistantMessage = (lastResult?.assistantMessage || '').trim();
    const cards = (lastResult?.uiInstructions || []).map((ui: any) => ui.component || ui.envelope?.arguments?.card?.cardType || 'unknown');
    const toolCalls =
      (lastResult?.executedCapabilities || []).length ||
      (lastResult?.trace?.toolsCalled || []).length ||
      0;
    const toolsCalled =
      ((lastResult?.trace?.toolsCalled || []).map((t: any) => t.name) as string[]) ||
      ((lastResult?.executedCapabilities || []).map((c: any) => c.toolId) as string[]) ||
      [];

    // Record full tool invocations including arguments and result counts
    const toolInvocations: ToolInvocationRecord[] = (lastResult?.trace?.toolsCalled || []).map((t: any) => ({
      name: t.name,
      durationMs: t.durationMs ?? 0,
      ok: t.ok ?? true,
      error: t.error,
      arguments: t.arguments,
      resultCount: t.resultCount,
      resultPreview: t.resultPreview,
    }));

    const timing = aggregateTiming || {
      timeToFirstEventMs: lastResult?.trace?.timeToFirstTextMs ?? 0,
      timeToFirstTextMs: lastResult?.trace?.timeToFirstTextMs ?? 0,
      interpretMs: 0,
      responseMs: lastResult?.trace?.durationMs ?? 0,
      phraseMs: 0,
      retrievalMs: 0,
      totalMs: lastResult?.trace?.durationMs ?? 0,
      modelCalls: toolCalls + 1,
      tokens: lastResult?.trace?.tokens || { prompt: 0, completion: 0, total: 0 },
    };

    // Automated Checks
    const expectedSkus = extractExpectedSkus(tc.groundTruthReference, tc.groundTruthUrls);
    const answerNotEmpty = assistantMessage.length > 0;
    const noInternalIds = checkNoInternalIds(assistantMessage);
    const allowedClasses = (useAgentMode && lastResult?.trace?.allowedClaimClasses)
      ? lastResult.trace.allowedClaimClasses
      : ['suggestion'];
    const claimCheck = validateOkfGeneratedClaims(assistantMessage, allowedClasses, stack.pack);
    const forbiddenClaimsAbsent = claimCheck.valid;

    // SKU / Attribute check for product lookups
    let expectedSkuPresent = true;
    let skuFailureReason: string | undefined;
    if (classification.type === 'product_lookup' && classification.expectsSpecificSku) {
      const matchOutcome = await checkProductLookupMatch({
        tc,
        expectedSkus,
        assistantMessage,
        uiInstructions: lastResult?.uiInstructions || [],
        toolProductSkus: lastResult?.trace?.toolProductSkus || [],
        toolsCalled: lastResult?.trace?.toolsCalled || [],
        db: stack.db,
        attributeDefinitions,
      });
      expectedSkuPresent = matchOutcome.matched;
      if (!matchOutcome.matched) {
        skuFailureReason = matchOutcome.reason || `Expected SKU not found (expected: ${expectedSkus.slice(0, 3).join(', ')})`;
      }
    }

    // Ground-truth requirement check for advice, project, safety, vocabulary
    const reqOutcome = checkGroundTruthRequirements({
      tc,
      promptType: classification.type,
      assistantMessage,
      cards,
      toolProductSkus: lastResult?.trace?.toolProductSkus || [],
    });
    const groundTruthMet = reqOutcome.met;

    const failureReasons: string[] = [];
    if (!answerNotEmpty) failureReasons.push('Empty assistant message');
    if (!noInternalIds) failureReasons.push('Internal IDs or platform terms leaked in message');
    if (!forbiddenClaimsAbsent) failureReasons.push(`Forbidden claims present: ${claimCheck.forbidden.join(', ')}`);
    if (!expectedSkuPresent) failureReasons.push(skuFailureReason || `Expected SKU not found (expected: ${expectedSkus.slice(0, 3).join(', ')})`);
    if (!groundTruthMet) failureReasons.push(reqOutcome.reason || 'Ground truth requirement not addressed');

    const passed = answerNotEmpty && noInternalIds && forbiddenClaimsAbsent && expectedSkuPresent && groundTruthMet;

    evalResults.push({
      id: tc.id,
      category: tc.category,
      promptType: classification.type,
      prompt: tc.prompt,
      purpose: tc.purpose,
      groundTruthReference: tc.groundTruthReference,
      assistantMessage,
      cards,
      cardStates: (lastResult?.uiInstructions || []).map((ui: any) => ui.envelope?.arguments?.card?.state ?? ui.state ?? ui.props ?? null),
      toolCalls,
      toolsCalled,
      toolInvocations,
      timing,
      checks: {
        answerNotEmpty,
        noInternalIds,
        forbiddenClaimsAbsent,
        expectedSkuPresent,
        groundTruthMet,
      },
      passed,
      failureReasons,
    });

    completed++;
    if (completed % 10 === 0 || completed === testCases.length) {
      process.stdout.write(`  [${completed}/${testCases.length}] processed\n`);
    }
  }

  // Aggregate Metrics
  const total = evalResults.length;
  const passedCount = evalResults.filter((r) => r.passed).length;
  const overallPassRate = (passedCount / total) * 100;

  const ttftValues = evalResults.map((r) => r.timing.timeToFirstTextMs ?? r.timing.totalMs);
  const totalMsValues = evalResults.map((r) => r.timing.totalMs);
  const modelCallsValues = evalResults.map((r) => r.timing.modelCalls);

  const p50Ttft = percentile(ttftValues, 50);
  const p95Ttft = percentile(ttftValues, 95);
  const p50Total = percentile(totalMsValues, 50);
  const p95Total = percentile(totalMsValues, 95);
  const maxTotal = totalMsValues.length > 0 ? Math.max(...totalMsValues) : 0;
  const avgModelCalls = modelCallsValues.reduce((a, b) => a + b, 0) / (total || 1);
  const totalToolCalls = evalResults.reduce((acc, r) => acc + (r.toolCalls || 0), 0);
  const avgToolCalls = totalToolCalls / (total || 1);
  const slowTurns = evalResults.filter((r) => (r.timing.totalMs || 0) > 20000);

  // Category Breakdown
  const categoriesMap = new Map<string, { total: number; passed: number }>();
  for (const r of evalResults) {
    const entry = categoriesMap.get(r.category) || { total: 0, passed: 0 };
    entry.total++;
    if (r.passed) entry.passed++;
    categoriesMap.set(r.category, entry);
  }

  const categoryStats: CategoryStats[] = [];
  for (const [cat, data] of categoriesMap.entries()) {
    categoryStats.push({
      category: cat,
      total: data.total,
      passed: data.passed,
      passRate: (data.passed / data.total) * 100,
    });
  }
  categoryStats.sort((a, b) => a.category.localeCompare(b.category));

  // Prompt Type Breakdown
  const promptTypeMap = new Map<PromptType, { total: number; passed: number }>();
  for (const r of evalResults) {
    const entry = promptTypeMap.get(r.promptType) || { total: 0, passed: 0 };
    entry.total++;
    if (r.passed) entry.passed++;
    promptTypeMap.set(r.promptType, entry);
  }

  const promptTypeStats: PromptTypeStats[] = [];
  for (const [type, data] of promptTypeMap.entries()) {
    promptTypeStats.push({
      type,
      total: data.total,
      passed: data.passed,
      passRate: (data.passed / data.total) * 100,
    });
  }
  promptTypeStats.sort((a, b) => a.type.localeCompare(b.type));

  // Write JSON Results
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(evalResults, null, 2), 'utf8');
  console.log(`\nJSON evaluation results saved to: ${outputPath}`);

  // Write Markdown Report
  const modeLabel = useAgentMode
    ? (useRealModel ? 'Agent Mode (Real Model Gateway)' : 'Agent Mode (Scripted Model Server)')
    : (useRealModel ? 'Rule-Based Baseline (Real Model Gateway)' : 'Retrieval-Only Baseline (Mock Model Gateway)');

  const reportTitle = useAgentMode
    ? `# PlaceMakers Conversation Quality Evaluation Report: Agent Mode`
    : `# PlaceMakers Conversation Quality Baseline Report (Retrieval-Only Baseline)`;

  const noteBlock = useAgentMode
    ? `> [!NOTE]\n> **Agent Mode Evaluation**: Evaluates the autonomous AI-led loop with dynamic tool calling (parallel read-only tools, catalog search, OKF notes, present_card) and streaming sentence shaping with OKF Claim Guard.`
    : `> [!NOTE]\n> **Retrieval-Only Baseline**: This evaluation was executed using the mock model gateway. Latency numbers reflect local in-memory execution and pass rates reflect catalogue retrieval and rule-based response generation without a live LLM API key. To run against a live provider with streaming LLM generation, set your API key and pass \`--real\`.`;

  const reportLines: string[] = [
    reportTitle,
    ``,
    noteBlock,
    ``,
    `- **Date**: ${new Date().toISOString()}`,
    `- **Test Set**: PlaceMakers 100 Test Prompts (\`${path.basename(promptsPath)}\`)`,
    `- **Mode**: ${modeLabel}`,
    `- **Total Prompts**: ${total}`,
    `- **Overall Pass Rate**: **${overallPassRate.toFixed(1)}%** (${passedCount}/${total})`,
    ``,
    `## Latency & Model Calls`,
    ``,
    `| Metric | Value |`,
    `| --- | --- |`,
    `| p50 Time to First Text | ${p50Ttft.toFixed(1)} ms |`,
    `| p95 Time to First Text | ${p95Ttft.toFixed(1)} ms |`,
    `| p50 Total Turn Latency | ${p50Total.toFixed(1)} ms |`,
    `| p95 Total Turn Latency | ${p95Total.toFixed(1)} ms |`,
    `| Max Total Turn Latency | ${maxTotal.toFixed(1)} ms |`,
    `| Average Model Calls / Turn | ${avgModelCalls.toFixed(2)} |`,
    `| Average Tool Calls / Turn | ${avgToolCalls.toFixed(2)} |`,
    ``,
    `## Slow Turns Audit (> 20s)`,
    ``,
    slowTurns.length === 0
      ? `- **Zero turns exceeded 20s** (max turn latency: ${maxTotal.toFixed(1)} ms). All turns completed within the 20s SLA threshold.`
      : [
          `- **${slowTurns.length} turn(s) exceeded the 20s SLA threshold**:`,
          ``,
          ...slowTurns.map(
            (r) =>
              `- **#${r.id}** [${r.category} | ${r.promptType}] (${(r.timing.totalMs / 1000).toFixed(2)}s, ${r.timing.modelCalls} model call(s), tools: [${r.toolsCalled.join(', ')}]): "${Array.isArray(r.prompt) ? r.prompt.join(' -> ') : r.prompt}"`
          ),
        ].join('\n'),
    ``,
    `## Pass Rate by Prompt Type`,
    ``,
    `| Prompt Type | Total | Passed | Pass Rate | Evaluation Criteria |`,
    `| --- | --- | --- | --- | --- |`,
    ...promptTypeStats.map(
      (p) => {
        let desc = 'Expected SKU or matching product attributes (size, grade, brand, category) present';
        if (p.type === 'education') desc = 'Explanatory answer without specific SKU enforcement';
        else if (p.type === 'safety') desc = 'Safety guidance/disclaimer, hazard awareness, no unsafe claims';
        else if (p.type === 'project') desc = 'Scoping clarification or component recommendation';
        else if (p.type === 'advice') desc = 'Grounded recommendation addressing row requirement';
        else if (p.type === 'vocabulary') desc = 'Term resolution / Kiwi trade slang explanation';
        else if (p.type === 'garbled') desc = 'Graceful handling without crash or internal leakage';
        return `| **${p.type}** | ${p.total} | ${p.passed} | ${p.passRate.toFixed(1)}% | ${desc} |`;
      }
    ),
    ``,
    `## Pass Rate by Original Category`,
    ``,
    `| Category | Total | Passed | Pass Rate |`,
    `| --- | --- | --- | --- |`,
    ...categoryStats.map(
      (c) => `| ${c.category} | ${c.total} | ${c.passed} | ${c.passRate.toFixed(1)}% |`
    ),
    ``,
    `## Checks Summary`,
    ``,
    `- **Answer Not Empty**: ${evalResults.filter((r) => r.checks.answerNotEmpty).length}/${total}`,
    `- **No Internal IDs Leaked**: ${evalResults.filter((r) => r.checks.noInternalIds).length}/${total}`,
    `- **Forbidden Claims Absent**: ${evalResults.filter((r) => r.checks.forbiddenClaimsAbsent).length}/${total}`,
    `- **Expected SKU / Product Attributes Present**: ${evalResults.filter((r) => r.checks.expectedSkuPresent).length}/${total}`,
    `- **Ground Truth Requirements Met**: ${evalResults.filter((r) => r.checks.groundTruthMet).length}/${total}`,
    ``,
    `## Failure Sample (First 5)`,
    ``,
    ...evalResults
      .filter((r) => !r.passed)
      .slice(0, 5)
      .map(
        (r) =>
          `- **#${r.id}** [${r.category} | ${r.promptType}] "${Array.isArray(r.prompt) ? r.prompt.join(' -> ') : r.prompt}": ${r.failureReasons.join('; ')}`
      ),
    ``,
  ];

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf8');
  console.log(`Markdown baseline report saved to: ${reportPath}`);

  // Console Summary Table
  console.log(`\n============================================================`);
  console.log(`EVALUATION SUMMARY (${modeLabel})`);
  console.log(`============================================================`);
  console.log(`Pass Rate: ${overallPassRate.toFixed(1)}% (${passedCount}/${total})`);
  console.log(`p50 Time to First Text: ${p50Ttft.toFixed(1)} ms | p95: ${p95Ttft.toFixed(1)} ms`);
  console.log(`p50 Turn Latency: ${p50Total.toFixed(1)} ms | p95: ${p95Total.toFixed(1)} ms | Max: ${maxTotal.toFixed(1)} ms`);
  console.log(`Model Calls/Turn: ${avgModelCalls.toFixed(2)} | Tool Calls/Turn: ${avgToolCalls.toFixed(2)}`);
  console.log(`Slow Turns (> 20s): ${slowTurns.length === 0 ? '0 (all within SLA)' : `${slowTurns.length} turns`}`);
  for (const st of slowTurns) {
    console.log(`  - Turn #${st.id} [${st.category}]: ${(st.timing.totalMs / 1000).toFixed(2)}s, tools: [${st.toolsCalled.join(', ')}]`);
  }
  console.log(`\nPrompt Type Breakdown:`);
  for (const p of promptTypeStats) {
    console.log(`  - ${p.type.padEnd(20)}: ${p.passed}/${p.total} (${p.passRate.toFixed(1)}%)`);
  }
  console.log(`\nCategory Breakdown:`);
  for (const c of categoryStats) {
    console.log(`  - ${c.category.padEnd(30)}: ${c.passed}/${c.total} (${c.passRate.toFixed(1)}%)`);
  }
  console.log(`============================================================\n`);
}

if (require.main === module || (process.argv[1] && process.argv[1].includes('run-conversation-eval'))) {
  main().catch((err) => {
    console.error('Eval run failed:', err);
    process.exit(1);
  });
}
