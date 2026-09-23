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

    // Rule 1: Enforce Total Bundle Budget (WORKWEAR-002)
    const budgetFact = workspace.facts['budget']?.value;
    if (budgetFact && budgetFact.amountCents) {
      const maxBudget = budgetFact.amountCents;

      if (outcome.bundle && typeof outcome.bundle.totalPriceCents === 'number') {
        appliedRules.push('total_bundle_budget');

        if (outcome.bundle.totalPriceCents > maxBudget) {
          // If the primary bundle is over budget, check if alternative items fit under budget
          if (outcome.alternatives && Array.isArray(outcome.alternatives)) {
            const fittingAlt = outcome.alternatives.find(
              (alt: any) => alt.totalPriceCents <= maxBudget
            );
            if (fittingAlt) {
              return {
                valid: true,
                outcome: {
                  ...outcome,
                  bundle: fittingAlt,
                  originalOverbudgetBundle: outcome.bundle,
                },
                appliedRules,
                remediationApplied: true,
                notes: `Replaced overbudget selection (${outcome.bundle.totalPriceCents / 100} AUD) with budget-compliant alternative (${fittingAlt.totalPriceCents / 100} AUD <= ${maxBudget / 100} AUD).`,
              };
            }
          }

          // If no precomputed alternative, filter items to stay within budget
          return {
            valid: false,
            outcome,
            appliedRules,
            notes: `Bundle total (${outcome.bundle.totalPriceCents / 100} AUD) exceeds max budget of ${maxBudget / 100} AUD.`,
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
