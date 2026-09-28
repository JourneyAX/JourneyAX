import { z } from 'zod';

export const ModelCandidateSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'google', 'open-model', 'custom']),
  model: z.string(),
  priority: z.number().int().min(1),
  temperature: z.number().min(0).max(2).optional(),
});

export const ResidencyAttestationSchema = z.object({
  source: z.string(),
  attestedResidency: z.string(),
  evidenceUrl: z.string().optional(),
  notes: z.string().optional(),
});

export const ModelPolicyItemSchema = z.object({
  policyId: z.string(),
  description: z.string().optional(),
  candidates: z.array(ModelCandidateSchema).min(1),
  dataResidency: z.string().default('au'),
  acceptedResidencies: z.array(z.string()).optional(),
  residencyAttestation: ResidencyAttestationSchema.optional(),
  maxInputTokens: z.number().int().default(20000),
  maxOutputTokens: z.number().int().default(2000),
  fallbackAllowed: z.boolean().default(true),
  timeoutMs: z.number().int().default(10000),
});

export const ModelPolicySchema = z.object({
  version: z.string().default('1.0.0'),
  defaultPolicy: z.string().default('standard_turn'),
  policies: z.array(ModelPolicyItemSchema),
});

export type ResidencyAttestation = z.infer<typeof ResidencyAttestationSchema>;
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;
export type ModelPolicyItem = z.infer<typeof ModelPolicyItemSchema>;
