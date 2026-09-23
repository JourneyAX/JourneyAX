import { z } from 'zod';

export const StageExitConditionSchema = z.object({
  allFactsPresent: z.array(z.string()).optional(),
  anyFactsPresent: z.array(z.string()).optional(),
  ruleExpression: z.string().optional(),
  conditionRuleRef: z.string().optional(),
  nextStage: z.string(),
});

export const JourneyStageSchema = z.object({
  stageId: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  requiredFacts: z.array(z.string()).default([]),
  optionalFacts: z.array(z.string()).optional(),
  allowedCapabilities: z.array(z.string()).default([]),
  blockedCapabilities: z.array(z.string()).optional(),
  nextDecisionPolicy: z.enum(['dependency-first', 'rule-first', 'agent-driven']).default('dependency-first'),
  exitConditions: z.array(StageExitConditionSchema).default([]),
  handoffPolicy: z.object({
    allowed: z.boolean().default(false),
    targetRole: z.string().optional(),
    conditionRef: z.string().optional(),
  }).optional(),
});

export const JourneyDefinitionSchema = z.object({
  journeyId: z.string(),
  version: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  goals: z.array(z.string()).min(1),
  initialStage: z.string(),
  stages: z.record(z.string(), JourneyStageSchema),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const JourneysCollectionSchema = z.object({
  version: z.string().default('1.0.0'),
  journeys: z.array(JourneyDefinitionSchema),
});

export type JourneyDefinition = z.infer<typeof JourneyDefinitionSchema>;
export type JourneyStage = z.infer<typeof JourneyStageSchema>;
export type StageExitCondition = z.infer<typeof StageExitConditionSchema>;
