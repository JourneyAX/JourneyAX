/**
 * benchmark-placemakers-latency.ts
 *
 * Generic offline two-artifact latency & grounding comparator.
 *
 * Compares a baseline execution trace against a candidate execution trace:
 * - Requires both --baseline and --candidate artifact file paths.
 * - Embeds NO tenant, product, provider, model, timing, or output fixtures in code.
 * - Validates nonempty required schema on both artifacts.
 * - Validates finite non-negative prefetchMs, modelToolRoundsMs, finalResponseMs.
 * - Validates each retrieval has reason, type, query, filter identity (category, gender, limit),
 *   finite duration, boolean reused, and downstream embedding/vector timing (or unavailable reason).
 * - Enforces exact equality on scenario, tenantId, provider, and model.
 * - Compares retrieval sequence and filter intent, allowing only exact-dedupe changes.
 * - Verifies normalized assistantReply and full normalized UI action arguments.
 * - Fails closed on any missing argument, malformed schema, or output mismatch.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';

export interface RetrievalDownstreamTiming {
  embeddingMs: number;
  vectorSearchMs: number;
}

export interface RetrievalTraceRecord {
  reason: string;
  type: string;
  query: string;
  durationMs: number;
  reused: boolean;
  category?: string | null;
  gender?: string | null;
  limit?: number | null;
  downstreamTiming?: RetrievalDownstreamTiming;
  downstreamUnavailableReason?: string;
}

export interface TraceArtifact {
  scenario: string;
  tenantId: string;
  provider: string;
  model: string;
  wallClockMs: number;
  timingBreakdown: {
    prefetchMs: number;
    modelToolRoundsMs: number;
    finalResponseMs: number;
    retrievals: RetrievalTraceRecord[];
    [key: string]: any;
  };
  assistantReply: string;
  uiActions: Array<{
    name: string;
    arguments?: any;
    [key: string]: any;
  }>;
}

export interface ComparisonResult {
  ok: boolean;
  baselineWallClockMs: number;
  candidateWallClockMs: number;
  wallClockDeltaMs: number;
  reductionPercentage: string;
  summary: string;
}

export function parseCliArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

export function validateArtifactSchema(label: string, data: any): TraceArtifact {
  if (!data || typeof data !== 'object') {
    throw new Error(`[${label}] Artifact must be a non-null object.`);
  }

  const requiredStringFields = ['scenario', 'tenantId', 'provider', 'model', 'assistantReply'];
  for (const field of requiredStringFields) {
    if (typeof data[field] !== 'string' || !data[field].trim()) {
      throw new Error(`[${label}] Missing or empty required string field: '${field}'.`);
    }
  }

  if (typeof data.wallClockMs !== 'number' || !Number.isFinite(data.wallClockMs) || data.wallClockMs <= 0) {
    throw new Error(`[${label}] 'wallClockMs' must be a positive finite number.`);
  }

  if (!data.timingBreakdown || typeof data.timingBreakdown !== 'object') {
    throw new Error(`[${label}] Missing or invalid required object field: 'timingBreakdown'.`);
  }

  const tb = data.timingBreakdown;
  const timingNumberFields = ['prefetchMs', 'modelToolRoundsMs', 'finalResponseMs'];
  for (const field of timingNumberFields) {
    if (typeof tb[field] !== 'number' || !Number.isFinite(tb[field]) || tb[field] < 0) {
      throw new Error(`[${label}] 'timingBreakdown.${field}' must be a non-negative finite number.`);
    }
  }

  if (!Array.isArray(tb.retrievals)) {
    throw new Error(`[${label}] 'timingBreakdown.retrievals' must be an array.`);
  }

  for (let i = 0; i < tb.retrievals.length; i++) {
    const r = tb.retrievals[i];
    if (!r || typeof r !== 'object') {
      throw new Error(`[${label}] retrievals[${i}] must be a non-null object.`);
    }
    if (typeof r.reason !== 'string' || !r.reason.trim()) {
      throw new Error(`[${label}] retrievals[${i}].reason must be a non-empty string.`);
    }
    if (typeof r.type !== 'string' || !r.type.trim()) {
      throw new Error(`[${label}] retrievals[${i}].type must be a non-empty string.`);
    }
    if (typeof r.query !== 'string' || !r.query.trim()) {
      throw new Error(`[${label}] retrievals[${i}].query must be a non-empty string.`);
    }
    if (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs) || r.durationMs < 0) {
      throw new Error(`[${label}] retrievals[${i}].durationMs must be a non-negative finite number.`);
    }
    if (typeof r.reused !== 'boolean') {
      throw new Error(`[${label}] retrievals[${i}].reused must be a boolean.`);
    }

    if (r.category !== undefined && r.category !== null && typeof r.category !== 'string') {
      throw new Error(`[${label}] retrievals[${i}].category must be a string if defined.`);
    }
    if (r.gender !== undefined && r.gender !== null && typeof r.gender !== 'string') {
      throw new Error(`[${label}] retrievals[${i}].gender must be a string if defined.`);
    }
    if (r.limit !== undefined && r.limit !== null && (typeof r.limit !== 'number' || !Number.isInteger(r.limit) || r.limit <= 0)) {
      throw new Error(`[${label}] retrievals[${i}].limit must be a positive integer if defined.`);
    }

    // Downstream embedding & vector search timing for non-reused searches
    if (!r.reused) {
      const hasDownstreamTiming =
        r.downstreamTiming &&
        typeof r.downstreamTiming === 'object' &&
        typeof r.downstreamTiming.embeddingMs === 'number' &&
        Number.isFinite(r.downstreamTiming.embeddingMs) &&
        r.downstreamTiming.embeddingMs >= 0 &&
        typeof r.downstreamTiming.vectorSearchMs === 'number' &&
        Number.isFinite(r.downstreamTiming.vectorSearchMs) &&
        r.downstreamTiming.vectorSearchMs >= 0;

      const hasUnavailableReason =
        typeof r.downstreamUnavailableReason === 'string' && r.downstreamUnavailableReason.trim().length > 0;

      if (!hasDownstreamTiming && !hasUnavailableReason) {
        throw new Error(
          `[${label}] retrievals[${i}] executed non-reused search requires downstreamTiming ({ embeddingMs, vectorSearchMs }) or an explicit downstreamUnavailableReason string.`
        );
      }
    }
  }

  if (!Array.isArray(data.uiActions)) {
    throw new Error(`[${label}] Missing or invalid required array field: 'uiActions'.`);
  }

  for (let i = 0; i < data.uiActions.length; i++) {
    const act = data.uiActions[i];
    if (!act || typeof act !== 'object' || typeof act.name !== 'string' || !act.name.trim()) {
      throw new Error(`[${label}] uiActions[${i}] must be an object with a non-empty 'name' property.`);
    }
  }

  return data as TraceArtifact;
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_#`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function deepNormalize(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return normalizeText(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(deepNormalize);
  if (typeof obj === 'object') {
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, any> = {};
    for (const key of sortedKeys) {
      result[key] = deepNormalize(obj[key]);
    }
    return result;
  }
  return obj;
}

export function compareRetrievalSequences(
  baseline: RetrievalTraceRecord[],
  candidate: RetrievalTraceRecord[]
): void {
  if (baseline.length !== candidate.length) {
    throw new Error(
      `Retrieval sequence length mismatch: baseline has ${baseline.length} retrievals but candidate has ${candidate.length}.`
    );
  }

  const executedSearches: Set<string> = new Set();

  for (let i = 0; i < baseline.length; i++) {
    const b = baseline[i];
    const c = candidate[i];

    const normBQuery = normalizeText(b.query);
    const normCQuery = normalizeText(c.query);
    if (normBQuery !== normCQuery) {
      throw new Error(
        `Retrieval query mismatch at index ${i}: baseline='${b.query}' vs candidate='${c.query}'.`
      );
    }

    if (b.type !== c.type) {
      throw new Error(
        `Retrieval type filter mismatch at index ${i}: baseline='${b.type}' vs candidate='${c.type}'.`
      );
    }

    const bCat = b.category || '';
    const cCat = c.category || '';
    if (bCat !== cCat) {
      throw new Error(
        `Retrieval category filter mismatch at index ${i}: baseline='${bCat}' vs candidate='${cCat}'.`
      );
    }

    const bGender = b.gender || '';
    const cGender = c.gender || '';
    if (bGender !== cGender) {
      throw new Error(
        `Retrieval gender filter mismatch at index ${i}: baseline='${bGender}' vs candidate='${cGender}'.`
      );
    }

    const bLimit = b.limit ?? null;
    const cLimit = c.limit ?? null;
    if (bLimit !== cLimit) {
      throw new Error(
        `Retrieval limit filter mismatch at index ${i}: baseline='${bLimit}' vs candidate='${cLimit}'.`
      );
    }

    if (b.reason !== c.reason) {
      throw new Error(
        `Retrieval reason mismatch at index ${i}: baseline='${b.reason}' vs candidate='${c.reason}'.`
      );
    }

    const sig = `${c.type}|${cCat}|${cGender}|${cLimit}|${normCQuery}`;
    if (!c.reused) {
      executedSearches.add(sig);
    } else {
      // Must be an exact dedupe of an already executed in-flight/prior search
      if (!executedSearches.has(sig)) {
        throw new Error(
          `Candidate marked retrieval at index ${i} as reused (0ms) without a prior executed search matching signature '${sig}'.`
        );
      }
    }
  }
}

export function compareTraceArtifacts(baselineRaw: any, candidateRaw: any): ComparisonResult {
  const baseline = validateArtifactSchema('baseline', baselineRaw);
  const candidate = validateArtifactSchema('candidate', candidateRaw);

  const invariantFields: (keyof TraceArtifact)[] = ['scenario', 'tenantId', 'provider', 'model'];
  for (const field of invariantFields) {
    if (baseline[field] !== candidate[field]) {
      throw new Error(
        `Invariant disparity detected on '${field}': baseline='${baseline[field]}' vs candidate='${candidate[field]}'.`
      );
    }
  }

  compareRetrievalSequences(
    baseline.timingBreakdown.retrievals,
    candidate.timingBreakdown.retrievals
  );

  const normBaseReply = normalizeText(baseline.assistantReply);
  const normCandReply = normalizeText(candidate.assistantReply);
  if (normBaseReply !== normCandReply) {
    throw new Error('Grounded assistantReply disparity detected between baseline and candidate.');
  }

  const normBaseActions = deepNormalize(baseline.uiActions);
  const normCandActions = deepNormalize(candidate.uiActions);
  assert.deepStrictEqual(
    normBaseActions,
    normCandActions,
    'Normalized UI action arguments must be strictly equivalent.'
  );

  const diffMs = baseline.wallClockMs - candidate.wallClockMs;
  const pct = ((diffMs / baseline.wallClockMs) * 100).toFixed(1);

  return {
    ok: true,
    baselineWallClockMs: baseline.wallClockMs,
    candidateWallClockMs: candidate.wallClockMs,
    wallClockDeltaMs: diffMs,
    reductionPercentage: pct,
    summary: `Verified equivalent output across identical model/filters with ${diffMs}ms (${pct}%) delta.`,
  };
}

export function loadArtifact(label: string, filePath: string): TraceArtifact {
  const fullPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`[${label}] Artifact file not found at: ${fullPath}`);
  }

  let parsed: any;
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`[${label}] Failed to parse artifact JSON from ${fullPath}: ${err.message}`);
  }

  return validateArtifactSchema(label, parsed);
}

function runCli(): void {
  console.log('==============================================================================');
  console.log('       Controlled Offline Trace Comparator (Latency & Grounding)              ');
  console.log('==============================================================================\n');

  const baselineArg = parseCliArg('--baseline') || process.env.BASELINE_TRACE_PATH;
  const candidateArg = parseCliArg('--candidate') || process.env.CANDIDATE_TRACE_PATH;

  if (!baselineArg || !candidateArg) {
    console.error('⛔ ERROR: Missing required artifact paths.');
    console.error('   Both --baseline and --candidate must be provided as CLI arguments or via');
    console.error('   BASELINE_TRACE_PATH and CANDIDATE_TRACE_PATH environment variables.\n');
    console.error('Usage:');
    console.error('   npx tsx scripts/benchmark-placemakers-latency.ts --baseline <path> --candidate <path>\n');
    process.exit(1);
  }

  let baseline: TraceArtifact;
  let candidate: TraceArtifact;

  try {
    baseline = loadArtifact('baseline', baselineArg);
    candidate = loadArtifact('candidate', candidateArg);
  } catch (err: any) {
    console.error(`⛔ ERROR: Schema validation failed: ${err.message}`);
    process.exit(1);
  }

  try {
    const result = compareTraceArtifacts(baseline, candidate);

    console.log('🔍 Scenario, Tenant, and Provider/Model Invariance:');
    console.log(`    ✔ PASS: Exact match on scenario="${baseline.scenario}", tenant="${baseline.tenantId}", provider="${baseline.provider}", model="${baseline.model}".`);

    console.log('\n⚖️ Retrieval Plan & Filter Invariance:');
    console.log(`    ✔ PASS: All retrieval intents and filters strictly match baseline (dedupe verified).`);

    console.log('\n💬 Grounded Output & UI Actions Equivalence:');
    console.log('    ✔ PASS: Grounded assistantReply and UI action arguments strictly match baseline.');

    console.log('\n------------------------------------------------------------------------------');
    console.log('🏁 CONTROLLED LATENCY COMPARISON RESULTS:');
    console.log('------------------------------------------------------------------------------');
    console.log(`• Baseline Wall-Clock:       ${result.baselineWallClockMs}ms`);
    console.log(`• Candidate Wall-Clock:      ${result.candidateWallClockMs}ms`);
    console.log(`• Wall-Clock Delta:          ${result.wallClockDeltaMs >= 0 ? '-' : '+'}${Math.abs(result.wallClockDeltaMs)}ms (${result.reductionPercentage}%)`);
    console.log('==============================================================================\n');
  } catch (err: any) {
    console.error(`⛔ ERROR: Comparison failed: ${err.message}`);
    process.exit(1);
  }
}

// Auto-run CLI if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  runCli();
}
