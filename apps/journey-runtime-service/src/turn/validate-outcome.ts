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
    const match = expr.trim().match(/^([a-zA-Z0-9_.]+)\s*(<=|>=|===|!==|==|!=|<|>)\s*(.+)$/);
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
      case '===':
        return left === right;
      case '!==':
        return left !== right;
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
    const notesList: string[] = [];

    for (const rule of packRules) {
      // Scope rules by appliesTo { toolIds, stageIds, journeyIds }
      const appliesTo = (rule as any).appliesTo;
      if (appliesTo) {
        if (Array.isArray(appliesTo.toolIds) && appliesTo.toolIds.length > 0) {
          if (!toolId || !appliesTo.toolIds.includes(toolId)) continue;
        }
        if (Array.isArray(appliesTo.stageIds) && appliesTo.stageIds.length > 0) {
          if (!workspace.currentStage || !appliesTo.stageIds.includes(workspace.currentStage)) continue;
        }
        if (Array.isArray(appliesTo.journeyIds) && appliesTo.journeyIds.length > 0) {
          if (!workspace.journeyId || !appliesTo.journeyIds.includes(workspace.journeyId)) continue;
        }
      }

      const expr = rule.condition?.ruleExpression || (rule as any).expression;
      if (expr && typeof expr === 'string') {
        // Record appliedRules only for rules actually evaluated
        appliedRules.push(rule.ruleId || rule.name || 'declarative_rule');
        const passed = evaluateSafeExpression(expr, evalContext);

        if (!passed) {
          const action = (rule as any).action || 'deny';
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
          } else if (action === 'require_approval') {
            return {
              valid: false,
              status: 'pending',
              outcome,
              appliedRules,
              notes:
                rule.remediationMessage ||
                rule.description ||
                `Capability outcome requires business approval per rule '${rule.ruleId || rule.name}'.`,
            };
          } else if (action === 'warn') {
            const warningMsg =
              rule.remediationMessage ||
              rule.description ||
              `Warning: Capability outcome flagged by rule '${rule.ruleId || rule.name}'.`;
            notesList.push(warningMsg);
          }
        }
      }
    }

    return {
      valid: true,
      status: 'success',
      outcome,
      appliedRules,
      notes: notesList.length > 0 ? notesList.join('; ') : undefined,
    };
  }
}
