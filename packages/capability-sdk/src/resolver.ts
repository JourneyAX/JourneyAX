import { ToolDefinition, ToolBinding, StageBinding } from './types';
import { areAllFactsPresent, FactsMap } from '@journeyax/journey-core';

export interface ResolvedStageCapabilities {
  stageId: string;
  tools: {
    definition: ToolDefinition;
    binding?: ToolBinding;
  }[];
}

export class CapabilityResolver {
  /**
   * Resolves only the stage-scoped tools that are permitted and have their prerequisites met.
   * Never exposes the entire tool catalog to the model.
   */
  resolveForStage(
    stageId: string,
    toolDefinitions: ToolDefinition[],
    toolBindings: ToolBinding[],
    stageBindings: StageBinding[],
    facts: FactsMap = {},
    tenantId?: string,
    environmentId?: string
  ): ResolvedStageCapabilities {
    const toolDefMap = new Map<string, ToolDefinition>(toolDefinitions.map((t) => [t.toolId, t]));
    const bindingMap = new Map<string, ToolBinding>();
    for (const b of toolBindings) {
      if (
        (!tenantId || b.tenantId === tenantId) &&
        (!environmentId || b.environmentId === environmentId)
      ) {
        bindingMap.set(b.toolId, b);
      }
    }

    // Find bindings explicitly tied to this stage
    const currentStageBinding = stageBindings.find((s) => s.stageId === stageId);
    const resolvedTools: { definition: ToolDefinition; binding?: ToolBinding }[] = [];

    if (currentStageBinding) {
      for (const item of currentStageBinding.tools) {
        // Evaluate facts prerequisite condition
        if (item.condition?.factsPresent && item.condition.factsPresent.length > 0) {
          if (!areAllFactsPresent(facts, item.condition.factsPresent)) {
            // Prerequisite facts missing, do not expose this tool yet
            continue;
          }
        }

        const toolDef = toolDefMap.get(item.toolId);
        if (toolDef) {
          resolvedTools.push({
            definition: toolDef,
            binding: bindingMap.get(item.toolId),
          });
        }
      }
    }

    return {
      stageId,
      tools: resolvedTools,
    };
  }
}
