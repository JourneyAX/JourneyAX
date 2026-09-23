import { WorkspaceState, FactsMap } from '@journeyax/journey-core';
import { InterpretationResult } from './interpret-event';

export class FactReducer {
  /**
   * Reduces new candidate facts into the durable workspace facts ledger.
   * Preserves verified facts unless explicitly overridden with higher confidence.
   */
  apply(workspace: WorkspaceState, interpretation: InterpretationResult): WorkspaceState {
    const nextFacts: FactsMap = { ...workspace.facts };

    for (const [key, candidate] of Object.entries(interpretation.candidateFacts)) {
      const existing = nextFacts[key];
      if (!existing || candidate.confidence >= existing.confidence) {
        nextFacts[key] = candidate;
      }
    }

    return {
      ...workspace,
      facts: nextFacts,
      updatedAt: new Date(),
    };
  }
}
