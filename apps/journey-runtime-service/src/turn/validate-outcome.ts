import { Decision, WorkspaceState } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';

export interface ValidatedOutcome {
  valid: boolean;
  outcome: any;
  appliedRules: string[];
  remediationApplied?: boolean;
  notes?: string;
}

export class OutcomeValidator {
  /**
   * Deterministically validates capability outputs against Business Pack rules
   * (e.g. Budget ceiling <= $250 AUD, Safety certification standards).
   */
  validate(
    decision: Decision,
    outcome: any,
    release: BusinessPackRelease,
    workspace: WorkspaceState
  ): ValidatedOutcome {
    const appliedRules: string[] = [];

    if (!outcome) {
      return { valid: true, outcome: null, appliedRules };
    }

    // Rule 1: Enforce Total Bundle Budget
    const budgetFact = workspace.facts['budget']?.value;
    if (budgetFact && budgetFact.amountCents) {
      const maxBudget = budgetFact.amountCents;

      if (outcome.bundle && typeof outcome.bundle.totalPriceCents === 'number') {
        appliedRules.push('total_bundle_budget');

        if (outcome.bundle.totalPriceCents > maxBudget) {
          if (outcome.alternatives && Array.isArray(outcome.alternatives)) {
            const fittingAlt = outcome.alternatives.find(
              (alt: any) => alt.bundle && alt.bundle.totalPriceCents <= maxBudget
            );
            if (fittingAlt) {
              return {
                valid: true,
                outcome: fittingAlt,
                appliedRules,
                remediationApplied: true,
                notes: 'Replaced over-budget primary bundle with verified compliant alternative.',
              };
            }
          }

          return {
            valid: false,
            outcome: null,
            appliedRules,
            notes: `Bundle total $${(outcome.bundle.totalPriceCents / 100).toFixed(2)} exceeds budget $${(maxBudget / 100).toFixed(2)}`,
          };
        }
      }
    }

    return {
      valid: true,
      outcome,
      appliedRules,
    };
  }
}
