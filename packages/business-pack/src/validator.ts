/**
 * Business Pack Semantic and Referential Validator
 *
 * Enforces cross-referencing correctness, secret-free snapshots,
 * and executable integrity before any release can be published.
 */

import { BusinessPackRelease } from './schemas/business-pack.schema';

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
          severity: 'warning',
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
              severity: 'warning',
              path: `journeys[${journey.journeyId}].stages[${stageId}].allowedCapabilities`,
              message: `Stage '${stageId}' allows capability '${capId}' which is not declared in toolDefinitions.`,
            });
          }
        }
      }
    }
  }

  // 6. Validate Tool Bindings
  for (const binding of pack.capabilities.toolBindings) {
    if (!registeredToolIds.has(binding.toolId)) {
      issues.push({
        severity: 'error',
        path: `capabilities.toolBindings[${binding.toolId}]`,
        message: `Tool binding references unknown toolId '${binding.toolId}'`,
      });
    }
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  };
}
