/**
 * Stage and Transition Evaluator for JourneyAX Core
 *
 * Evaluates required facts, exit conditions, and allowed capabilities
 * deterministically without arbitrary JS eval or LLM hallucinations.
 */

import { JourneyStage, StageExitCondition, FactsMap, FactEntry, FactRequirement } from './types';

export interface TransitionEvaluationResult {
  shouldTransition: boolean;
  nextStage?: string;
  matchedCondition?: StageExitCondition;
  reason?: string;
}

/**
 * Normalizes an array of string or FactRequirement objects to a typed FactRequirement array.
 */
export function normalizeFactRequirements(requirements?: Array<string | FactRequirement>): FactRequirement[] {
  if (!requirements || requirements.length === 0) return [];
  return requirements.map((item) => {
    if (typeof item === 'string') {
      return {
        key: item,
        priority: 100,
        required: true,
        dependencies: [],
      };
    }
    return {
      key: item.key,
      priority: item.priority ?? 100,
      reason: item.reason,
      question: item.question,
      options: item.options,
      dependencies: item.dependencies ?? [],
      required: item.required !== false,
    };
  });
}

/**
 * Checks whether all specified fact keys are present with a valid (non-null, non-undefined, non-empty) value.
 */
export function areAllFactsPresent(facts: FactsMap, requiredKeys: string[]): boolean {
  if (!requiredKeys || requiredKeys.length === 0) return true;
  return requiredKeys.every((key) => {
    const entry = facts[key];
    if (!entry) return false;
    const v = entry.value;
    if (v === null || v === undefined) return false;
    if (typeof v === 'string' && v.trim() === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
}

/**
 * Checks whether any of the specified fact keys are present with a valid value.
 */
export function areAnyFactsPresent(facts: FactsMap, candidateKeys: string[]): boolean {
  if (!candidateKeys || candidateKeys.length === 0) return true;
  return candidateKeys.some((key) => {
    const entry = facts[key];
    if (!entry) return false;
    const v = entry.value;
    if (v === null || v === undefined) return false;
    if (typeof v === 'string' && v.trim() === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
}

/**
 * Returns a list of required fact keys that are missing or empty in the current facts map.
 * Optional facts (required: false) are excluded so they do not block exit conditions.
 */
export function findMissingRequiredFacts(stage: JourneyStage, facts: FactsMap): string[] {
  const normalized = normalizeFactRequirements(stage.requiredFacts);
  return normalized
    .filter((req) => req.required !== false)
    .map((req) => req.key)
    .filter((key) => {
      const entry = facts[key];
      if (!entry) return true;
      const v = entry.value;
      if (v === null || v === undefined) return true;
      if (typeof v === 'string' && v.trim() === '') return true;
      if (Array.isArray(v) && v.length === 0) return true;
      return false;
    });
}

/**
 * Evaluates stage exit conditions in order.
 * First condition that passes triggers the transition to `nextStage`.
 */
export function evaluateStageExit(
  stage: JourneyStage,
  facts: FactsMap,
  releaseRules?: any[]
): TransitionEvaluationResult {
  if (!stage.exitConditions || stage.exitConditions.length === 0) {
    return { shouldTransition: false };
  }

  for (const condition of stage.exitConditions) {
    let matched = true;

    if (condition.allFactsPresent && condition.allFactsPresent.length > 0) {
      if (!areAllFactsPresent(facts, condition.allFactsPresent)) {
        matched = false;
      }
    }

    if (matched && condition.anyFactsPresent && condition.anyFactsPresent.length > 0) {
      if (!areAnyFactsPresent(facts, condition.anyFactsPresent)) {
        matched = false;
      }
    }

    if (matched && condition.ruleExpression) {
      const exprPassed = evaluateControlledExpression(condition.ruleExpression, facts);
      if (!exprPassed) {
        matched = false;
      }
    }

    if (matched && condition.conditionRuleRef && Array.isArray(releaseRules)) {
      const referencedRule = releaseRules.find(
        (r) => (r.ruleId && r.ruleId === condition.conditionRuleRef) || (r.name && r.name === condition.conditionRuleRef)
      );
      if (referencedRule) {
        const ruleExpr = referencedRule.condition?.ruleExpression || referencedRule.expression;
        if (ruleExpr) {
          const rulePassed = evaluateControlledExpression(ruleExpr, facts);
          if (!rulePassed) {
            matched = false;
          }
        }
      }
    }

    if (matched) {
      return {
        shouldTransition: true,
        nextStage: condition.nextStage,
        matchedCondition: condition,
        reason: `Matched exit condition targeting stage '${condition.nextStage}'`,
      };
    }
  }

  return { shouldTransition: false };
}

/**
 * Verifies whether a capability is permitted in the current stage.
 */
export function isCapabilityAllowed(
  stage: JourneyStage,
  capabilityId: string,
): { allowed: boolean; reason?: string } {
  if (stage.blockedCapabilities && stage.blockedCapabilities.includes(capabilityId)) {
    return { allowed: false, reason: `Capability '${capabilityId}' is explicitly blocked in stage '${stage.displayName || stage.stageId || 'current'}'` };
  }

  if (stage.allowedCapabilities && stage.allowedCapabilities.length > 0) {
    // Exact match or wildcard prefix match e.g. "catalog.*"
    const isAllowed = stage.allowedCapabilities.some((pattern) => {
      if (pattern === '*' || pattern === capabilityId) return true;
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        return capabilityId.startsWith(`${prefix}.`);
      }
      return false;
    });

    if (!isAllowed) {
      return {
        allowed: false,
        reason: `Capability '${capabilityId}' is not in allowed capabilities for stage '${stage.displayName || stage.stageId || 'current'}'`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Safe, controlled expression evaluator for simple comparison rules without using `eval()`:
 * Supports simple comparisons:
 *   - "field <= 25000"
 *   - "field == 'electrician'"
 *   - "field > 0"
 */
export function evaluateControlledExpression(expression: string, facts: FactsMap): boolean {
  try {
    const trimmed = expression.trim();
    // Match: path (op) literal
    const match = trimmed.match(/^([a-zA-Z0-9_.]+)\s*(<=|>=|===|!==|==|!=|<|>)\s*(.+)$/);
    if (!match) return false;

    const [, path, operator, rawLiteral] = match;
    const resolvedValue = resolveFactValue(facts, path);
    if (resolvedValue === undefined) return false;

    let targetLiteral: any = rawLiteral.trim();
    // Parse quotes
    if (
      (targetLiteral.startsWith('"') && targetLiteral.endsWith('"')) ||
      (targetLiteral.startsWith("'") && targetLiteral.endsWith("'"))
    ) {
      targetLiteral = targetLiteral.slice(1, -1);
    } else if (!isNaN(Number(targetLiteral))) {
      targetLiteral = Number(targetLiteral);
    } else if (targetLiteral === 'true') {
      targetLiteral = true;
    } else if (targetLiteral === 'false') {
      targetLiteral = false;
    }

    switch (operator) {
      case '===':
        return resolvedValue === targetLiteral;
      case '!==':
        return resolvedValue !== targetLiteral;
      case '==':
        return resolvedValue == targetLiteral;
      case '!=':
        return resolvedValue != targetLiteral;
      case '<=':
        return Number(resolvedValue) <= Number(targetLiteral);
      case '>=':
        return Number(resolvedValue) >= Number(targetLiteral);
      case '<':
        return Number(resolvedValue) < Number(targetLiteral);
      case '>':
        return Number(resolvedValue) > Number(targetLiteral);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function resolveFactValue(facts: FactsMap, path: string): any {
  const parts = path.split('.');
  const rootKey = parts[0];
  const factEntry = facts[rootKey];
  if (!factEntry) return undefined;

  let current: any = factEntry.value;
  for (let i = 1; i < parts.length; i++) {
    if (current === null || current === undefined) return undefined;
    current = current[parts[i]];
  }
  return current;
}
