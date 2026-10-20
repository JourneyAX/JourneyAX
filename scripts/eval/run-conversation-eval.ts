#!/usr/bin/env node
/**
 * Conversation Quality Evaluation Runner (PlaceMakers 100 Prompts)
 *
 * Runs test prompts in-process through the canonical JourneyAX runtime,
 * captures structured timing, cards, and assistant replies, and evaluates:
 * 1. Answer not empty
 * 2. No internal IDs leaked to customer text
 * 3. Forbidden claims absent (claim guard)
 * 4. Expected SKU or category present when applicable
 *
 * Usage:
 *   npx tsx scripts/eval/run-conversation-eval.ts [--prompts <path>] [--output <path>] [--report <path>] [--mock] [--real] [--limit <n>]
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildPlaceMakersStack, TENANT, ENVIRONMENT } from '../../apps/journey-runtime-service/test/helpers/placemakers-stack';
import { validateOkfGeneratedClaims } from '../../apps/journey-runtime-service/src/kernel/okf-claim-validator';

interface EvalTestCase {
  id: number;
  category: string;
  prompt: string | string[];
  purpose: string;
  groundTruthReference: string;
  groundTruthUrls?: string;
}

interface EvalTurnResult {
  id: number;
  category: string;
  prompt: string | string[];
  purpose: string;
  groundTruthReference: string;
  assistantMessage: string;
  cards: string[];
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
    expectedSkuOrCategoryPresent: boolean;
  };
  passed: boolean;
  failureReasons: string[];
}

interface CategoryStats {
  category: string;
  total: number;
  passed: number;
  passRate: number;
}

function parseArgs(): {
  promptsPath: string;
  outputPath: string;
  reportPath: string;
  useRealModel: boolean;
  limit: number | null;
} {
  const args = process.argv.slice(2);
  let promptsPath = path.resolve('docs/evals/placemakers-100.json');
  const today = new Date().toISOString().slice(0, 10);
  let outputPath = path.resolve(`docs/evals/eval-results-${Date.now()}.json`);
  let reportPath = path.resolve(`docs/evals/baseline-${today}.md`);
  let useRealModel = false;
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
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10);
    }
  }

  return { promptsPath, outputPath, reportPath, useRealModel, limit };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

/** Extracts expected SKUs from ground-truth reference and URLs. */
function extractExpectedSkus(reference: string, urls?: string): string[] {
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
function checkNoInternalIds(text: string): boolean {
  if (!text) return true;
  const leaksInternalPattern = /(concept:\/\/|[a-f0-9]{24}|stage_[a-z0-9_]+|tool\.[a-z0-9_]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/i;
  return !leaksInternalPattern.test(text);
}

/** Load PlaceMakers products CSV into the in-memory db. */
function loadPlacemakersCsvProducts(db: any): number {
  const csvPath = path.resolve('apps/journeyax-web/public/data/placemakers-products.csv');
  if (!fs.existsSync(csvPath)) return 0;

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n');
  const products: any[] = [];

  // Parse header
  const header = lines[0].split(',').map((h) => h.trim());
  const skuIdx = header.indexOf('Item_SKU') >= 0 ? header.indexOf('Item_SKU') : header.indexOf('Parent_SKU');
  const nameIdx = header.indexOf('Item_Name');
  const catIdx = header.indexOf('Category');
  const descIdx = header.indexOf('Item_Description');
  const priceIdx = header.indexOf('OriginalPrice');

  // Load first 2500 products for testing to keep in-memory footprint light and fast
  for (let i = 1; i < Math.min(lines.length, 2500); i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Simple CSV row parser handling quotes
    const parts: string[] = [];
    let inQuotes = false;
    let curr = '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        parts.push(curr);
        curr = '';
      } else {
        curr += ch;
      }
    }
    parts.push(curr);

    const sku = (parts[skuIdx] || '').trim();
    const name = (parts[nameIdx] || '').trim();
    if (!sku || !name) continue;

    const category = (parts[catIdx] || 'General').trim();
    const description = (parts[descIdx] || name).trim();
    const priceStr = (parts[priceIdx] || '0').replace(/[^0-9.]/g, '');
    const price = parseFloat(priceStr) || 15.0;

    products.push({
      projectId: TENANT,
      sku,
      name,
      category,
      categoryPath: [category],
      description,
      priceUSD: { min: price },
      currency: 'NZD',
      inStock: true,
    });
  }

  if (products.length > 0) {
    db.collection('products').insertMany(products);
  }
  return products.length;
}

async function main() {
  const { promptsPath, outputPath, reportPath, useRealModel, limit } = parseArgs();

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

  console.log(`Setting up in-process PlaceMakers runtime stack (${useRealModel ? 'real model gateway' : 'mock model gateway'})...`);
  const stack = await buildPlaceMakersStack();
  const loadedCount = loadPlacemakersCsvProducts(stack.db);
  console.log(`Loaded ${loadedCount} catalogue products into in-memory store.`);

  const service = stack.serviceFor({ servePacks: true });

  const evalResults: EvalTurnResult[] = [];
  let completed = 0;
  console.log(`\nRunning ${testCases.length} evaluation turns...`);

  for (const tc of testCases) {
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
    const timing = aggregateTiming || {
      timeToFirstEventMs: 0,
      timeToFirstTextMs: 0,
      interpretMs: 0,
      responseMs: 0,
      phraseMs: 0,
      retrievalMs: 0,
      totalMs: 0,
      modelCalls: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
    };

    // Automated Checks
    const expectedSkus = extractExpectedSkus(tc.groundTruthReference, tc.groundTruthUrls);
    const answerNotEmpty = assistantMessage.length > 0;
    const noInternalIds = checkNoInternalIds(assistantMessage);
    const claimCheck = validateOkfGeneratedClaims(assistantMessage, ['suggestion']);
    const forbiddenClaimsAbsent = claimCheck.valid;

    // SKU / Category check:
    // If ground truth expects specific SKUs, check if any SKU is mentioned in answer, cards or products.
    // If no specific SKU is expected (advisory/informational/clarify), pass if answer or category is relevant.
    let expectedSkuOrCategoryPresent = true;
    if (expectedSkus.length > 0) {
      const mentionsSku = expectedSkus.some((sku) => assistantMessage.includes(sku));
      const hasProductsCard = cards.includes('products');
      const mentionsCategory = tc.category ? assistantMessage.toLowerCase().includes(tc.category.split('&')[0].trim().toLowerCase()) : false;
      expectedSkuOrCategoryPresent = mentionsSku || hasProductsCard || mentionsCategory;
    }

    const failureReasons: string[] = [];
    if (!answerNotEmpty) failureReasons.push('Empty assistant message');
    if (!noInternalIds) failureReasons.push('Internal IDs or platform terms leaked in message');
    if (!forbiddenClaimsAbsent) failureReasons.push(`Forbidden claims present: ${claimCheck.forbidden.join(', ')}`);
    if (!expectedSkuOrCategoryPresent) failureReasons.push(`Expected SKU or category not found (expected: ${expectedSkus.slice(0, 3).join(', ')})`);

    const passed = answerNotEmpty && noInternalIds && forbiddenClaimsAbsent && expectedSkuOrCategoryPresent;

    evalResults.push({
      id: tc.id,
      category: tc.category,
      prompt: tc.prompt,
      purpose: tc.purpose,
      groundTruthReference: tc.groundTruthReference,
      assistantMessage,
      cards,
      timing,
      checks: {
        answerNotEmpty,
        noInternalIds,
        forbiddenClaimsAbsent,
        expectedSkuOrCategoryPresent,
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
  const avgModelCalls = modelCallsValues.reduce((a, b) => a + b, 0) / (total || 1);

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

  // Write JSON Results
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(evalResults, null, 2), 'utf8');
  console.log(`\nJSON evaluation results saved to: ${outputPath}`);

  // Write Markdown Report
  const reportLines: string[] = [
    `# PlaceMakers Conversation Quality Baseline Report`,
    ``,
    `- **Date**: ${new Date().toISOString()}`,
    `- **Test Set**: PlaceMakers 100 Test Prompts (\`${path.basename(promptsPath)}\`)`,
    `- **Mode**: ${useRealModel ? 'Real Model Gateway' : 'Mock/Offline Model Gateway'}`,
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
    `| Average Model Calls / Turn | ${avgModelCalls.toFixed(2)} |`,
    ``,
    `## Pass Rate by Category`,
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
    `- **No Internal IDs**: ${evalResults.filter((r) => r.checks.noInternalIds).length}/${total}`,
    `- **Forbidden Claims Absent**: ${evalResults.filter((r) => r.checks.forbiddenClaimsAbsent).length}/${total}`,
    `- **Expected SKU/Category Present**: ${evalResults.filter((r) => r.checks.expectedSkuOrCategoryPresent).length}/${total}`,
    ``,
    `## Failure Sample (Top 5)`,
    ``,
    ...evalResults
      .filter((r) => !r.passed)
      .slice(0, 5)
      .map(
        (r) =>
          `- **#${r.id}** [${r.category}] "${Array.isArray(r.prompt) ? r.prompt.join(' -> ') : r.prompt}": ${r.failureReasons.join('; ')}`
      ),
    ``,
  ];

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf8');
  console.log(`Markdown baseline report saved to: ${reportPath}`);

  // Console Summary Table
  console.log(`\n============================================================`);
  console.log(`EVALUATION SUMMARY`);
  console.log(`============================================================`);
  console.log(`Pass Rate: ${overallPassRate.toFixed(1)}% (${passedCount}/${total})`);
  console.log(`p50 Time to First Text: ${p50Ttft.toFixed(1)} ms | p95: ${p95Ttft.toFixed(1)} ms`);
  console.log(`Model Calls/Turn: ${avgModelCalls.toFixed(2)}`);
  console.log(`\nCategory Breakdown:`);
  for (const c of categoryStats) {
    console.log(`  - ${c.category.padEnd(30)}: ${c.passed}/${c.total} (${c.passRate.toFixed(1)}%)`);
  }
  console.log(`============================================================\n`);
}

main().catch((err) => {
  console.error('Eval run failed:', err);
  process.exit(1);
});
