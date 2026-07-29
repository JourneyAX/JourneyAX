/**
 * Step 6 — Grounding Validator (lightweight, no extra LLM call by default).
 *
 * Runs only in "technical" mode (install/repair/specs), where fabrication is
 * dangerous. Heuristic check: if the reply reads like step-by-step installation
 * instructions but NO knowledge was retrieved this turn, flag it as ungrounded so
 * the orchestrator can note it in the trace (and later force a retry/disclaimer).
 *
 * Kept as a heuristic on purpose — an LLM validator adds latency/cost; add one
 * later for high-stakes tenants. This catches the common "invented steps" case.
 */
import { ConversationMode } from './types';

export interface GroundingVerdict {
  ok: boolean;
  reason?: string;
}

const STEP_LIKE = /(step\s*\d|^\s*\d+\.\s|turn off the|unscrew|tighten|apply sealant|remove the)/im;

export function validateGrounding(
  text: string,
  mode: ConversationMode,
  hadRetrieval: boolean,
): GroundingVerdict {
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
