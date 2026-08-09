/**
 * Step 6 — Grounding Validator (lightweight, no extra LLM call by default).
 *
 * Two checks, both heuristic on purpose — an LLM validator adds latency/cost;
 * add one later for high-stakes tenants.
 *
 * 1. TECHNICAL MODE (install/repair/specs): if the reply reads like step-by-step
 *    instructions but NO knowledge was retrieved this turn, flag it as ungrounded
 *    so the orchestrator can note it in the trace.
 *
 * 2. ANY MODE — commercial facts: the hallucination rule covers products, prices
 *    and SKUs, not just install steps. Business mode was previously unchecked, so
 *    an invented price passed silently. We extract every price/SKU the reply
 *    asserts and confirm each one appears in the knowledge retrieved THIS TURN.
 *    A figure present nowhere in those results is flagged BY VALUE, so the trace
 *    names the exact unverified number.
 *
 *    Scope, deliberately narrow: this check runs ONLY when a retrieval happened
 *    this turn. Tool results are transient — `persistableTranscript` strips them,
 *    so on a turn with no search we have no corpus to check against and cannot
 *    distinguish "re-stating a price fetched three turns ago" (legitimate, and
 *    common) from a fabrication. Flagging then would be guesswork, so we stay
 *    silent. What this DOES catch is the real failure mode: the agent searched,
 *    got results, and then stated a number those results never contained.
 */
import { ConversationMode } from './types';

export interface GroundingVerdict {
  ok: boolean;
  reason?: string;
  /** Price/SKU tokens asserted in the reply that appear in no retrieved fact. */
  unverified?: string[];
}

const STEP_LIKE = /(step\s*\d|^\s*\d+\.\s|turn off the|unscrew|tighten|apply sealant|remove the)/im;

/** "$1,063" · "$425.00" · "$ 349" */
const PRICE = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;

/**
 * Product codes such as 853010MW, 766100W, 99651F — 5+ chars, uppercase, mixing
 * letters and digits. Measurements (300MM, 1200X600) are excluded: they are
 * dimensions, not catalogue identifiers, and would otherwise dominate the noise.
 */
const SKU = /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{5,}\b/g;
const MEASUREMENT = /^\d+(MM|CM|M|KG|G|ML|L|W|V|MB|GB|X\d+)$/;

/** Compare prices by digits only, so "$1,063" matches a retrieved "1063". */
function priceKey(raw: string): string {
  return raw.replace(/[^0-9]/g, '');
}

function assertedFacts(text: string): string[] {
  const out = new Set<string>();
  for (const p of text.match(PRICE) || []) out.add(p.trim());
  for (const s of text.match(SKU) || []) {
    if (!MEASUREMENT.test(s)) out.add(s);
  }
  return [...out];
}

function isSupported(token: string, corpus: string, corpusDigits: string): boolean {
  if (token.startsWith('$')) {
    const digits = priceKey(token);
    // Guard: a 1-2 digit "price" ($5) matches too easily by chance — skip it
    // rather than claim verification we did not really perform.
    return digits.length < 3 ? true : corpusDigits.includes(digits);
  }
  return corpus.toUpperCase().includes(token.toUpperCase());
}

export function validateGrounding(
  text: string,
  mode: ConversationMode,
  hadRetrieval: boolean,
  /** Tool results from THIS turn. Omit to skip the commercial-fact check. */
  retrievedFacts?: string,
): GroundingVerdict {
  // ── Check 2: commercial facts (every mode, only when we have a corpus) ──
  if (text && hadRetrieval && retrievedFacts) {
    const corpus = retrievedFacts;
    const corpusDigits = corpus.replace(/[^0-9]/g, '');
    const unverified = assertedFacts(text).filter((t) => !isSupported(t, corpus, corpusDigits));

    if (unverified.length > 0) {
      return {
        ok: false,
        unverified,
        reason:
          `Reply asserts ${unverified.length} price/SKU value(s) absent from the knowledge ` +
          `retrieved this turn: ${unverified.join(', ')} — possible fabricated commercial fact.`,
      };
    }
  }

  // ── Check 1: technical step instructions (unchanged) ─────────────
  if (mode !== 'technical') return { ok: true };
  if (hadRetrieval) return { ok: true };

  if (text && STEP_LIKE.test(text)) {
    return {
      ok: false,
      reason:
        'Technical reply contains step-like instructions but no knowledge was retrieved this turn — possible ungrounded/invented steps.',
    };
  }
  return { ok: true };
}
