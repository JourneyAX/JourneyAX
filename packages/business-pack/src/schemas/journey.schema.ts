import { z } from 'zod';

export const StageExitConditionSchema = z.object({
  allFactsPresent: z.array(z.string()).optional(),
  anyFactsPresent: z.array(z.string()).optional(),
  ruleExpression: z.string().optional(),
  conditionRuleRef: z.string().optional(),
  nextStage: z.string(),
});

export const FactRequirementSchema = z.object({
  key: z.string(),
  priority: z.number().int().default(100),
  reason: z.string().optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).default([]),
  required: z.boolean().default(true),
});

export const FactRequirementItemSchema = z.union([
  z.string(),
  FactRequirementSchema,
]);

export const CapabilityPlanConditionSchema = z.object({
  factsPresent: z.array(z.string()).optional(),
  factsMissing: z.array(z.string()).optional(),
  ruleExpression: z.string().optional(),
});

export const CapabilityPlanItemSchema = z.object({
  toolId: z.string(),
  when: z.union([z.string(), CapabilityPlanConditionSchema]).optional(),
  producesFacts: z.array(z.string()).optional(),
  sameTurnContinuation: z.boolean().optional(),
  autoContinue: z.boolean().optional(),
  continueTurn: z.boolean().optional(),
});

export const JourneyStageSchema = z.object({
  stageId: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  requiredFacts: z.array(FactRequirementItemSchema).default([]),
  optionalFacts: z.array(FactRequirementItemSchema).optional(),
  allowedCapabilities: z.array(z.string()).default([]),
  blockedCapabilities: z.array(z.string()).optional(),
  capabilityPlan: z.array(CapabilityPlanItemSchema).optional(),
  sameTurnContinuation: z.boolean().optional(),
  autoContinue: z.boolean().optional(),
  continueTurn: z.boolean().optional(),
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
export type CapabilityPlanItem = z.infer<typeof CapabilityPlanItemSchema>;
