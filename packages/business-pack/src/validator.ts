/**
 * Business Pack Semantic and Referential Validator
 *
 * Enforces cross-referencing correctness, secret-free snapshots,
 * and executable integrity before any release can be published.
 */

import { BusinessPackRelease } from './schemas/business-pack.schema';
import { validateSecretReference } from './schemas/capability-binding.schema';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function validateBusinessPack(pack: BusinessPackRelease): ValidationResult {
  const issues: ValidationIssue[] = [];

  // 1. Validate Secret References (No raw keys or tokens)
  const jsonStr = JSON.stringify(pack);
  if (/sk-[a-zA-Z0-9]{20,}/.test(jsonStr) || /ghp_[a-zA-Z0-9]{20,}/.test(jsonStr)) {
    issues.push({
      severity: 'error',
      path: 'security',
      message: 'Detected raw API key or token in Business Pack snapshot. Use secretRef (e.g. gcp-secret://...) instead.',
    });
  }

  // 2. Validate Model Policy References
  const policyIds = new Set(pack.modelPolicy.policies.map((p) => p.policyId));
  for (const agent of pack.agents) {
    if (!policyIds.has(agent.modelPolicyRef)) {
      issues.push({
        severity: 'error',
        path: `agents[${agent.agentId}].modelPolicyRef`,
        message: `Agent '${agent.agentId}' references unknown model policy '${agent.modelPolicyRef}'`,
      });
    }
  }

  // 3. Collect registered Tool IDs
  const registeredToolIds = new Set(pack.capabilities.toolDefinitions.map((t) => t.toolId));

  // 4. Validate Agent Allowed Tools
  for (const agent of pack.agents) {
    for (const toolId of agent.allowedTools) {
      if (!registeredToolIds.has(toolId) && !toolId.includes('*')) {
        issues.push({
          severity: 'error',
          path: `agents[${agent.agentId}].allowedTools`,
          message: `Agent '${agent.agentId}' allows tool '${toolId}' which is not explicitly defined in toolDefinitions`,
        });
      }
    }
  }

  // 5. Validate Journeys and Stages
  for (const journey of pack.journeys) {
    const stageIds = new Set(Object.keys(journey.stages));

    // Check initialStage
    if (!stageIds.has(journey.initialStage)) {
      issues.push({
        severity: 'error',
        path: `journeys[${journey.journeyId}].initialStage`,
        message: `Journey '${journey.journeyId}' initialStage '${journey.initialStage}' does not exist in stages.`,
      });
    }

    // Check exitConditions target stages
    for (const [stageId, rawStage] of Object.entries(journey.stages)) {
      const stage = rawStage as any;
      if (!stage || !stage.exitConditions) continue;
      for (let i = 0; i < stage.exitConditions.length; i++) {
        const cond = stage.exitConditions[i];
        if (!stageIds.has(cond.nextStage)) {
          issues.push({
            severity: 'error',
            path: `journeys[${journey.journeyId}].stages[${stageId}].exitConditions[${i}].nextStage`,
            message: `Exit condition points to non-existent stage '${cond.nextStage}' in journey '${journey.journeyId}'`,
          });
        }
      }

      // Check allowed capabilities in stage
      if (Array.isArray(stage.allowedCapabilities)) {
        for (const capId of stage.allowedCapabilities) {
          if (!registeredToolIds.has(capId) && !capId.includes('*')) {
            issues.push({
              severity: 'error',
              path: `journeys[${journey.journeyId}].stages[${stageId}].allowedCapabilities`,
              message: `Stage '${stageId}' allows capability '${capId}' which is not declared in toolDefinitions.`,
            });
          }
        }
      }
    }
  }

  // 6. Validate Tool Bindings and Executor Secret References
  const boundToolIds = new Set<string>();
  for (const binding of pack.capabilities.toolBindings) {
    boundToolIds.add(binding.toolId);
    if (!registeredToolIds.has(binding.toolId)) {
      issues.push({
        severity: 'error',
        path: `capabilities.toolBindings[${binding.toolId}]`,
        message: `Tool binding references unknown toolId '${binding.toolId}'`,
      });
    }

    const secretRef = binding.executor?.secretRef;
    if (secretRef) {
      const refIssues = validateSecretReference(secretRef, binding.tenantId, binding.environmentId);
      for (const refIssue of refIssues) {
        issues.push({
          severity: 'error',
          path: `capabilities.toolBindings[${binding.toolId}].executor.secretRef`,
          message: refIssue.message,
        });
      }
    }
  }

  // 7. Enforce Capability Binding: Reject capabilities with no binding
  for (const toolDef of pack.capabilities.toolDefinitions) {
    if (!boundToolIds.has(toolDef.toolId)) {
      issues.push({
        severity: 'error',
        path: `capabilities.toolDefinitions[${toolDef.toolId}]`,
        message: `Capability '${toolDef.toolId}' is defined in toolDefinitions but has no binding in toolBindings`,
      });
    }
  }
  for (const journey of pack.journeys) {
    for (const [stageId, rawStage] of Object.entries(journey.stages)) {
      const stage = rawStage as any;
      if (Array.isArray(stage.allowedCapabilities)) {
        for (const capId of stage.allowedCapabilities) {
          if (!boundToolIds.has(capId) && !capId.includes('*')) {
            issues.push({
              severity: 'error',
              path: `journeys[${journey.journeyId}].stages[${stageId}].allowedCapabilities`,
              message: `Stage '${stageId}' allows capability '${capId}' which has no binding in toolBindings`,
            });
          }
        }
      }
    }
  }

  // 8. Collect all declared fact keys across the entire pack
  const declaredFactKeys = new Set<string>();
  if (pack.vocabulary?.terms) {
    for (const term of pack.vocabulary.terms) {
      if (term.category) declaredFactKeys.add(term.category);
    }
  }
  if (pack.vocabulary?.slotSynonyms) {
    for (const key of Object.keys(pack.vocabulary.slotSynonyms)) {
      declaredFactKeys.add(key);
    }
  }
  if ((pack.vocabulary as any)?.slotQuestions) {
    for (const key of Object.keys((pack.vocabulary as any).slotQuestions)) {
      declaredFactKeys.add(key);
    }
  }
  if (pack.entities?.entities) {
    for (const ent of pack.entities.entities) {
      if ((ent as any).entityName) declaredFactKeys.add((ent as any).entityName);
      if (ent.entityId) declaredFactKeys.add(ent.entityId);
      if (ent.attributes) {
        for (const attr of ent.attributes) {
          if (attr.name) declaredFactKeys.add(attr.name);
        }
      }
    }
  }
  for (const tb of pack.capabilities.toolBindings) {
    if ((tb as any).outputFactMapping) {
      for (const k of Object.keys((tb as any).outputFactMapping)) {
        declaredFactKeys.add(k);
      }
    }
  }
  for (const sb of pack.capabilities.stageBindings || []) {
    for (const t of sb.tools || []) {
      if ((t as any).outputFactMapping) {
        for (const k of Object.keys((t as any).outputFactMapping)) {
          declaredFactKeys.add(k);
        }
      }
    }
  }
  for (const journey of pack.journeys) {
    for (const stage of Object.values(journey.stages || {})) {
      const s = stage as any;
      for (const f of s.requiredFacts || []) {
        const k = typeof f === 'string' ? f : (f?.key || f?.factKey);
        if (k) declaredFactKeys.add(k);
      }
      for (const f of s.optionalFacts || []) {
        const k = typeof f === 'string' ? f : (f?.key || f?.factKey);
        if (k) declaredFactKeys.add(k);
      }
      for (const cp of s.capabilityPlan || []) {
        for (const pf of cp.producesFacts || []) declaredFactKeys.add(pf);
      }
    }
  }

  // 9. Enforce Exit Condition Fact Integrity: Reject unknown fact keys in exits
  for (const journey of pack.journeys) {
    for (const [stageId, rawStage] of Object.entries(journey.stages)) {
      const stage = rawStage as any;
      if (Array.isArray(stage.exitConditions)) {
        for (let i = 0; i < stage.exitConditions.length; i++) {
          const cond = stage.exitConditions[i];
          const exitFacts = [...(cond.allFactsPresent || []), ...(cond.anyFactsPresent || [])];
          for (const f of exitFacts) {
            if (!declaredFactKeys.has(f)) {
              issues.push({
                severity: 'error',
                path: `journeys[${journey.journeyId}].stages[${stageId}].exitConditions[${i}]`,
                message: `Exit condition references unknown fact key '${f}' (not declared in stage facts, vocabulary, entities, or capability outputs)`,
              });
            }
          }
        }
      }
    }
  }

  // 10. Enforce Required Fact Questionnaire Coverage: Reject required facts with no slotQuestion
  const slotQuestions = (pack.vocabulary as any)?.slotQuestions || {};
  for (const journey of pack.journeys) {
    for (const [stageId, rawStage] of Object.entries(journey.stages)) {
      const stage = rawStage as any;
      if (Array.isArray(stage.requiredFacts)) {
        for (const rawFact of stage.requiredFacts) {
          const factKey = typeof rawFact === 'string' ? rawFact : (rawFact?.key || rawFact?.factKey);
          if (!factKey) continue;
          const hasQuestion =
            slotQuestions[factKey] ||
            stage.questionDefinitions?.[factKey] ||
            (typeof rawFact === 'object' && rawFact?.question) ||
            (stage.factRequirements || []).some(
              (r: any) => (r.key === factKey || r.factKey === factKey) && r.question
            );
          if (!hasQuestion) {
            issues.push({
              severity: 'error',
              path: `journeys[${journey.journeyId}].stages[${stageId}].requiredFacts`,
              message: `Required fact '${factKey}' in stage '${stageId}' has no declared slotQuestion in vocabulary.json`,
            });
          }
        }
      }
    }
  }

  // 11. Enforce Rule Expression Parseability: Reject rule expressions that don't parse
  for (const rule of pack.rules || []) {
    const expr = rule.condition?.ruleExpression;
    if (expr && typeof expr === 'string' && expr.trim()) {
      const trimmed = expr.trim();
      const binaryMatch = trimmed.match(
        /^\s*([a-zA-Z0-9_$.]+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/
      );
      const singleIdentMatch = trimmed.match(/^\s*!?([a-zA-Z0-9_$.]+)\s*$/);
      if (!binaryMatch && !singleIdentMatch) {
        issues.push({
          severity: 'error',
          path: `rules[${rule.ruleId}].condition.ruleExpression`,
          message: `Rule expression '${expr}' in rule '${rule.ruleId}' could not be parsed by runtime evaluator`,
        });
      }
    }
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  };
}
