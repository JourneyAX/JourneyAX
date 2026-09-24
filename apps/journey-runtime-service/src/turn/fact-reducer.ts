import { WorkspaceState, FactsMap, FactEntry } from '@journeyax/journey-core';
import { InterpretationResult } from './interpret-event';

export class FactReducer {
  /**
   * Deterministically applies candidate facts into the workspace.
   * Higher-confidence facts overwrite lower-confidence ones.
   */
  apply(
    workspace: WorkspaceState,
    factsOrInterpretation: InterpretationResult | FactsMap | Record<string, any>
  ): WorkspaceState {
    const next = structuredClone(workspace);
    const existing = next.facts;
    const candidates: Record<string, any> =
      factsOrInterpretation && typeof factsOrInterpretation === 'object' && 'candidateFacts' in factsOrInterpretation
        ? factsOrInterpretation.candidateFacts
        : (factsOrInterpretation as Record<string, any>) || {};

    for (const [key, rawCandidate] of Object.entries(candidates)) {
      const candidate: FactEntry =
        rawCandidate && typeof rawCandidate === 'object' && 'value' in rawCandidate && 'source' in rawCandidate
          ? (rawCandidate as FactEntry)
          : {
              value: rawCandidate,
              source: 'system',
              confidence: 1.0,
              extractedAt: new Date().toISOString(),
            };

      const current = existing[key];
      if (!current || candidate.confidence >= (current.confidence || 0)) {
        existing[key] = candidate;
      }
    }

    return next;
  }
}
