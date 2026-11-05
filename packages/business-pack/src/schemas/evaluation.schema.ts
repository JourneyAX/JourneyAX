import { z } from 'zod';

export const AssertionSchema = z.object({
  type: z.enum([
    'fact_present',
    'fact_equals',
    'budget_ceiling',
    'capability_executed',
    'stage_reached',
    'no_hallucinated_skus',
    'response_contains',
    'response_not_contains',
    'card_present',
    'capability_not_executed',
  ]),
  field: z.string().optional(),
  expected: z.any().optional(),
  description: z.string().optional(),
});

export const ScenarioSchema = z.object({
  scenarioId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  messages: z.array(z.string()).optional(),
  forbiddenSubstrings: z.array(z.string()).optional(),
  initialFacts: z.record(z.string(), z.any()).optional(),
  expectedTargetStage: z.string().optional(),
  expectedFacts: z.array(z.string()).optional(),
  maxBudgetAmountCents: z.number().optional(),
  budgetCurrency: z.string().default('AUD'),
  requiredCapabilities: z.array(z.string()).optional(),
  assertions: z.array(AssertionSchema).default([]),
  timeoutMs: z.number().int().default(15000),
});

export const EvaluationSuiteSchema = z.object({
  suiteId: z.string(),
  name: z.string(),
  tenantId: z.string(),
  version: z.string().default('1.0.0'),
  blockingOnPublish: z.boolean().default(true),
  deterministicOffline: z.boolean().optional(),
  executionMode: z.string().optional(),
  /** Public source records copied into isolated evaluation storage; never customer/account data. */
  sourceFixtures: z.object({ productSkus: z.array(z.string().min(1).max(120)).max(100) }).strict().optional(),
  scenarios: z.array(ScenarioSchema).min(1),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type EvaluationSuite = z.infer<typeof EvaluationSuiteSchema>;
