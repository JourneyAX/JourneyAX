import { z } from 'zod';

export const RuleDefinitionSchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  severity: z.enum(['blocking', 'warning', 'advisory']).default('blocking'),
  targetDomain: z.string().optional(),
  condition: z.object({
    ruleExpression: z.string().optional(),
    requiredFacts: z.array(z.string()).optional(),
    customEvaluator: z.string().optional(),
  }),
  action: z.enum(['deny', 'allow', 'require_approval', 'adjust_parameters', 'override_response']),
  parameters: z.record(z.string(), z.any()).default({}),
  remediationMessage: z.string().optional(),
});

export const RulesCollectionSchema = z.object({
  version: z.string().default('1.0.0'),
  rules: z.array(RuleDefinitionSchema),
});

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
