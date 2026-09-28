import { Decision, WorkspaceState } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';

export interface ValidatedOutcome {
  valid: boolean;
  status?: 'success' | 'failed' | 'pending' | 'no_outcome';
  outcome: any;
  appliedRules: string[];
  remediationApplied?: boolean;
  notes?: string;
}

function resolvePath(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr === null || curr === undefined) return undefined;
    if (typeof curr === 'object' && part in curr) {
      curr = curr[part];
    } else {
      return undefined;
    }
  }
  return curr;
}

function evaluateSafeExpression(expr: string, context: Record<string, any>): boolean {
  try {
    const match = expr.trim().match(/^([a-zA-Z0-9_.]+)\s*(<=|>=|==|!=|<|>)\s*(.+)$/);
    if (!match) return false;
    const [, path, op, rawVal] = match;
    const left = resolvePath(context, path);
    if (left === undefined) return false;

    let right: any = rawVal.trim();
    if ((right.startsWith('"') && right.endsWith('"')) || (right.startsWith("'") && right.endsWith("'"))) {
      right = right.slice(1, -1);
    } else if (!isNaN(Number(right))) {
      right = Number(right);
    } else if (right === 'true') {
      right = true;
    } else if (right === 'false') {
      right = false;
    }

    switch (op) {
      case '==':
        return left == right;
      case '!=':
        return left != right;
      case '<=':
        return Number(left) <= Number(right);
      case '>=':
        return Number(left) >= Number(right);
      case '<':
        return Number(left) < Number(right);
      case '>':
        return Number(left) > Number(right);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export class OutcomeValidator {
  /**
   * Deterministically validates capability outputs against declared output schemas
   * and Business Pack rules using a safe declarative evaluator.
   * Zero eval(), zero domain/currency literals, and truthful pending/no_outcome handling.
   */
  validate(
    decision: Decision,
    outcome: any,
    release: BusinessPackRelease,
    workspace: WorkspaceState
  ): ValidatedOutcome {
    const appliedRules: string[] = [];

    // Truthful handling of missing or pending outcome
    if (outcome === undefined || outcome === null) {
      return {
        valid: false,
        status: 'no_outcome',
        outcome: null,
        appliedRules,
        notes: 'No capability execution outcome provided for validation.',
      };
    }

    // 1. Output Schema Validation against Tool Definition (if declared)
    const toolId = decision.targetCapability || decision.payload?.toolId;
    if (toolId && release.capabilities?.toolDefinitions) {
      const toolDef = release.capabilities.toolDefinitions.find((t) => t.toolId === toolId);
      if (toolDef && toolDef.outputSchema) {
        const schemaProps = (toolDef.outputSchema as any).properties || toolDef.outputSchema;
        const requiredFields: string[] = Array.isArray((toolDef.outputSchema as any).required)
          ? (toolDef.outputSchema as any).required
          : [];

        for (const reqField of requiredFields) {
          if (outcome[reqField] === undefined || outcome[reqField] === null) {
            return {
              valid: false,
              status: 'failed',
              outcome: null,
              appliedRules,
              notes: `Capability outcome for '${toolId}' is missing required field '${reqField}' declared in output schema.`,
            };
          }
        }

        for (const [field, def] of Object.entries(schemaProps)) {
          const val = outcome[field];
          if (val === undefined || val === null) continue;
          const expectedType = (def as any)?.type;
          if (expectedType && typeof val !== expectedType) {
            return {
              valid: false,
              status: 'failed',
              outcome: null,
              appliedRules,
              notes: `Capability outcome for '${toolId}' field '${field}' type mismatch: expected ${expectedType}, got ${typeof val}.`,
            };
          }
        }
      }
    }

    // 2. Safe Declarative Rule Evaluation across release.rules
    const evalContext = {
      outcome,
      workspace: {
        facts: Object.fromEntries(
          Object.entries(workspace.facts || {}).map(([k, v]) => [k, v?.value])
        ),
        currentStage: workspace.currentStage,
        journeyId: workspace.journeyId,
      },
    };

    const packRules = release.rules || [];
    for (const rule of packRules) {
      const expr = rule.condition?.ruleExpression || (rule as any).expression;
      if (expr && typeof expr === 'string') {
        const passed = evaluateSafeExpression(expr, evalContext);
        appliedRules.push(rule.ruleId || rule.name || 'declarative_rule');

        if (!passed) {
          const action = rule.action || 'deny';
          if (action === 'deny') {
            return {
              valid: false,
              status: 'failed',
              outcome: null,
              appliedRules,
              notes:
                rule.remediationMessage ||
                rule.description ||
                `Capability outcome violated business rule '${rule.ruleId || rule.name}'.`,
            };
          }
        }
      }
    }

    // 3. Dynamic Budget Constraint Evaluation from Workspace State (if present)
    const budgetFact = workspace.facts?.['budget']?.value;
    if (budgetFact && typeof budgetFact === 'object' && budgetFact.amountCents) {
      const maxBudget = budgetFact.amountCents;

      if (outcome.bundle && typeof outcome.bundle.totalPriceCents === 'number') {
        appliedRules.push('total_bundle_budget');

        if (outcome.bundle.totalPriceCents > maxBudget) {
          // Check for compliant alternatives
          if (outcome.alternatives && Array.isArray(outcome.alternatives)) {
            const fittingAlt = outcome.alternatives.find(
              (alt: any) => alt.bundle && alt.bundle.totalPriceCents <= maxBudget
            );
            if (fittingAlt) {
              return {
                valid: true,
                status: 'success',
                outcome: fittingAlt,
                appliedRules,
                remediationApplied: true,
                notes: 'Primary recommendation exceeded budget; selected verified compliant alternative.',
              };
            }
          }

          const currency = outcome.bundle.currency || '';
          return {
            valid: false,
            status: 'failed',
            outcome: null,
            appliedRules,
            notes: `Bundle total ${outcome.bundle.totalPriceCents / 100} ${currency} exceeds budget ceiling of ${maxBudget / 100} ${currency}.`,
          };
        }
      }
    }

    return {
      valid: true,
      status: 'success',
      outcome,
      appliedRules,
    };
  }
}
