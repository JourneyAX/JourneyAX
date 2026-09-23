import { z } from 'zod';

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
});

export const AgentsCollectionSchema = z.object({
  version: z.string().default('1.0.0'),
  agents: z.array(AgentDefinitionSchema),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
