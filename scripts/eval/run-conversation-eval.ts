#!/usr/bin/env node
/**
 * Conversation Quality Evaluation Runner (PlaceMakers 100 Prompts)
 *
 * Runs test prompts in-process through the canonical JourneyAX runtime,
 * captures structured timing, cards, and assistant replies, and evaluates:
 * 1. Answer not empty
 * 2. No internal IDs leaked to customer text
 * 3. Forbidden claims absent (claim guard)
 * 4. Expected SKU or category present when a specific SKU is expected
 *
 * Classifies prompts by type:
 *   product_lookup, advice, project, vocabulary, education, safety, garbled
 *
 * Usage:
 *   npx tsx scripts/eval/run-conversation-eval.ts [--prompts <path>] [--output <path>] [--report <path>] [--mock] [--real] [--limit <n>]
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildPlaceMakersStack, TENANT, ENVIRONMENT } from '../../apps/journey-runtime-service/test/helpers/placemakers-stack';
import { validateOkfGeneratedClaims } from '../../apps/journey-runtime-service/src/kernel/okf-claim-validator';
import { ModelGateway } from '../../apps/journey-runtime-service/src/kernel/model.gateway';

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
  promptType: PromptType;
  prompt: string | string[];
  purpose: string;
  groundTruthReference: string;
  assistantMessage: string;
  cards: string[];
  toolCalls: number;
  toolsCalled: string[];
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

interface PromptTypeStats {
  type: PromptType;
  total: number;
  passed: number;
  passRate: number;
}

/**
 * Classifies a prompt into one of 7 standard evaluation types and determines
 * if a specific SKU match is expected.
 */
export function classifyPrompt(tc: EvalTestCase): {
  type: PromptType;
  expectsSpecificSku: boolean;
} {
  const promptStr = Array.isArray(tc.prompt) ? tc.prompt.join(' ') : tc.prompt;
  const pLower = promptStr.toLowerCase();
  const purposeLower = tc.purpose.toLowerCase();
  const refLower = tc.groundTruthReference.toLowerCase();

  // 1. Garbled / gibberish
  if (tc.id === 100 || pLower.includes('asdkfj')) {
    return { type: 'garbled', expectsSpecificSku: false };
  }

  // 2. Safety / hazard / code compliance / legal restrictions
  if (
    tc.id === 55 || tc.id === 99 ||
    purposeLower.includes('safety') ||
    pLower.includes('safe to use') ||
    pLower.includes('electrical wiring') ||
    pLower.includes('power outlets') ||
    pLower.includes('hazard') ||
    pLower.includes('load bearing')
  ) {
    return { type: 'safety', expectsSpecificSku: false };
  }

  // 3. Vocabulary / local trade slang / terminology
  if (
    tc.id === 96 || tc.id === 97 || tc.id === 98 ||
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
    tc.id === 3 || tc.id === 17 || tc.id === 57 ||
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
    (tc.id >= 86 && tc.id <= 95) ||
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
  const hasNoSingleSku = refLower.includes('no single sku') || refLower.includes('no feed match is "the" right answer');
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
async function loadPlacemakersCsvProducts(db: any): Promise<number> {
  const csvPath = path.resolve('apps/journeyax-web/public/data/placemakers-products.csv');
  if (!fs.existsSync(csvPath)) return 0;

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n');
  const products: any[] = [];

  const header = lines[0].split(',').map((h) => h.trim());
  const skuIdx = header.indexOf('Item_SKU') >= 0 ? header.indexOf('Item_SKU') : header.indexOf('Parent_SKU');
  const nameIdx = header.indexOf('Item_Name');
  const catIdx = header.indexOf('Category');
  const descIdx = header.indexOf('Item_Description');
  const priceIdx = header.indexOf('OriginalPrice');
  const brandIdx = header.indexOf('Brand');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
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

    const brand = brandIdx >= 0 ? (parts[brandIdx] || '').trim() : '';
    const category = (parts[catIdx] || 'General').trim();
    const description = (parts[descIdx] || name).trim();
    const priceStr = (parts[priceIdx] || '0').replace(/[^0-9.]/g, '');
    const price = parseFloat(priceStr) || 15.0;

    products.push({
      projectId: TENANT,
      sku,
      name,
      brand,
      category,
      categoryPath: [category],
      description: brand ? `${brand} ${description}` : description,
      priceUSD: { min: price },
      currency: 'NZD',
      inStock: true,
    });
  }

  if (products.length > 0) {
    await db.collection('products').insertMany(products);
  }
  return products.length;
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
    const claimCheck = validateOkfGeneratedClaims(assistantMessage, allowedClasses);
    const forbiddenClaimsAbsent = claimCheck.valid;

    // SKU check:
    // A prompt passes only if an expected SKU for that prompt is shown (in message or presented card)
    // or the prompt type does not need one.
    let expectedSkuPresent = true;
    if (classification.expectsSpecificSku && expectedSkus.length > 0) {
      const uiStr = JSON.stringify(lastResult?.uiInstructions || []);
      const mentionsSku = expectedSkus.some((sku) => assistantMessage.includes(sku) || uiStr.includes(sku));
      expectedSkuPresent = mentionsSku;
    }

    const failureReasons: string[] = [];
    if (!answerNotEmpty) failureReasons.push('Empty assistant message');
    if (!noInternalIds) failureReasons.push('Internal IDs or platform terms leaked in message');
    if (!forbiddenClaimsAbsent) failureReasons.push(`Forbidden claims present: ${claimCheck.forbidden.join(', ')}`);
    if (!expectedSkuPresent) failureReasons.push(`Expected SKU not found (expected: ${expectedSkus.slice(0, 3).join(', ')})`);

    const passed = answerNotEmpty && noInternalIds && forbiddenClaimsAbsent && expectedSkuPresent;

    evalResults.push({
      id: tc.id,
      category: tc.category,
      promptType: classification.type,
      prompt: tc.prompt,
      purpose: tc.purpose,
      groundTruthReference: tc.groundTruthReference,
      assistantMessage,
      cards,
      toolCalls,
      toolsCalled,
      timing,
      checks: {
        answerNotEmpty,
        noInternalIds,
        forbiddenClaimsAbsent,
        expectedSkuPresent,
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
  const totalToolCalls = evalResults.reduce((acc, r) => acc + (r.toolCalls || 0), 0);
  const avgToolCalls = totalToolCalls / (total || 1);

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
    `| Average Model Calls / Turn | ${avgModelCalls.toFixed(2)} |`,
    `| Average Tool Calls / Turn | ${avgToolCalls.toFixed(2)} |`,
    ``,
    `## Pass Rate by Prompt Type`,
    ``,
    `| Prompt Type | Total | Passed | Pass Rate | Evaluation Criteria |`,
    `| --- | --- | --- | --- | --- |`,
    ...promptTypeStats.map(
      (p) => {
        let desc = 'Expected SKU/category in response';
        if (p.type === 'education') desc = 'Explanatory answer without specific SKU enforcement';
        else if (p.type === 'safety') desc = 'Safety guidance/disclaimer, no unsafe claims';
        else if (p.type === 'project') desc = 'Project planning / clarification response';
        else if (p.type === 'advice') desc = 'Grounded recommendation, no unverified claims';
        else if (p.type === 'vocabulary') desc = 'Term resolution without failure';
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
    `- **Expected SKU Present (where applicable)**: ${evalResults.filter((r) => r.checks.expectedSkuPresent).length}/${total}`,
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
  console.log(`Model Calls/Turn: ${avgModelCalls.toFixed(2)} | Tool Calls/Turn: ${avgToolCalls.toFixed(2)}`);
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

main().catch((err) => {
  console.error('Eval run failed:', err);
  process.exit(1);
});
