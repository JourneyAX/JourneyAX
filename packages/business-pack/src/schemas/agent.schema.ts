import { z } from 'zod';

export const JourneyPlaybookStageSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  goal: z.string(),
  tools: z.array(z.string()).default([]),
  exitCondition: z.string(),
});

export const JourneyPlaybookSchema = z.object({
  description: z.string().optional(),
  stages: z.array(JourneyPlaybookStageSchema),
});

export const JourneyPlaybookUnionSchema = z.union([
  z.array(JourneyPlaybookStageSchema),
  JourneyPlaybookSchema,
]);

export type JourneyPlaybookStage = z.infer<typeof JourneyPlaybookStageSchema>;
export type JourneyPlaybook = z.infer<typeof JourneyPlaybookSchema>;

export function normalizePlaybookStages(
  playbook?: unknown
): JourneyPlaybookStage[] {
  if (!playbook) return [];
  if (Array.isArray(playbook)) return playbook as JourneyPlaybookStage[];
  if (
    typeof playbook === 'object' &&
    playbook !== null &&
    Array.isArray((playbook as any).stages)
  ) {
    return (playbook as any).stages as JourneyPlaybookStage[];
  }
  return [];
}

export const AgentDefinitionSchema = z.object({
  agentId: z.string(),
  name: z.string().optional(),
  purpose: z.string(),
  systemPromptTemplate: z.string().optional(),
  inputSchema: z.record(z.string(), z.any()).default({}),
  outputSchema: z.record(z.string(), z.any()).default({}),
  allowedTools: z.array(z.string()).default([]),
  modelPolicyRef: z.string(),
  maxTurns: z.number().int().default(3),
  handoffConditions: z.array(z.string()).default([]),
  isDefault: z.boolean().optional(),
  toolFirst: z.boolean().optional(),
  journeyPlaybook: JourneyPlaybookUnionSchema.optional(),
});

export const AgentsCollectionSchema = z.object({
  version: z.string().default('1.0.0'),
  agents: z.array(AgentDefinitionSchema),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
