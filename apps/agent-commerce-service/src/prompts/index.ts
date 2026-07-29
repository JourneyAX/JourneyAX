/**
 * Prompt assembler — composes the per-turn system prompt from:
 *   BASE_PROMPT (invariant) + mode overlay (business|technical) + stage hint.
 *
 * Replaces the single monolithic SYSTEM_PROMPT with a modular, mode/stage-aware
 * prompt (see docs/ARCHITECTURE.md §3). BASE_PROMPT is unchanged, so behaviour is
 * preserved; the overlays only sharpen tone and the current objective.
 */
import { BASE_PROMPT } from './base';
import { BUSINESS_OVERLAY } from './business';
import { TECHNICAL_OVERLAY } from './technical';
import { STAGE_HINTS } from './stage';

export function assembleSystemPrompt(
  mode: 'business' | 'technical',
  stage: string,
): string {
  const modeOverlay = mode === 'technical' ? TECHNICAL_OVERLAY : BUSINESS_OVERLAY;
  const stageHint = STAGE_HINTS[stage] || '';
  return [BASE_PROMPT, modeOverlay, stageHint].filter(Boolean).join('\n\n');
}

export { BASE_PROMPT };
