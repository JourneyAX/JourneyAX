import { ModelPolicy, ModelPolicySchema, ModelPolicyItem, ModelCandidateSchema } from './schemas/model-policy.schema';
import policyDefaults from './defaults/model-policies.json';

export interface CompileModelPolicyInput {
  projectId: string;
  mode?: 'simple' | 'advanced';
  existingModelPolicy?: Partial<ModelPolicy> | null;
  aiConfig?: {
    provider?: string;
    model?: string;
    temperature?: number;
    fallbackProvider?: string;
    fallbackModel?: string;
    /** Per-policy overrides of the platform defaults (see defaults/model-policies.json). */
    policyOverrides?: Record<string, { provider?: string; model?: string; timeoutMs?: number }> | null;
  } | null;
  dataResidency?: string;
}

/**
 * Normalizes provider name string to schema enum values:
 * 'openai' | 'anthropic' | 'google' | 'open-model' | 'custom'
 */
export function normalizeProvider(raw?: string): 'openai' | 'anthropic' | 'google' | 'open-model' | 'custom' {
  const p = (raw || 'openai').toLowerCase().trim();
  if (p === 'gemini') return 'google';
  if (p === 'ollama') return 'open-model';
  if (['openai', 'anthropic', 'google', 'open-model', 'custom'].includes(p)) {
    return p as any;
  }
  return 'custom';
}

const KNOWN_POLICY_IDS: string[] = policyDefaults.policies.map((policy) => policy.policyId);

/** Problems with a project's `ai.policyOverrides`; empty means valid. Checked when the setting is saved and again when the pack is compiled. */
export function validatePolicyOverrides(overrides: unknown): string[] {
  if (overrides === undefined || overrides === null) return [];
  if (typeof overrides !== 'object' || Array.isArray(overrides)) return ['ai.policyOverrides must be an object keyed by policy id'];
  const { minTimeoutMs, maxTimeoutMs } = policyDefaults.limits;
  const problems: string[] = [];
  for (const [policyId, override] of Object.entries(overrides as Record<string, any>)) {
    if (!KNOWN_POLICY_IDS.includes(policyId)) { problems.push(`ai.policyOverrides.${policyId}: unknown policy (expected one of ${KNOWN_POLICY_IDS.join(', ')})`); continue; }
    if (!override || typeof override !== 'object' || Array.isArray(override)) { problems.push(`ai.policyOverrides.${policyId} must be an object`); continue; }
    const unknown = Object.keys(override).filter((key) => !['provider', 'model', 'timeoutMs'].includes(key));
    if (unknown.length) problems.push(`ai.policyOverrides.${policyId}: unknown key(s) ${unknown.join(', ')}`);
    if (override.model !== undefined && (typeof override.model !== 'string' || !override.model.trim())) problems.push(`ai.policyOverrides.${policyId}.model must be a non-empty string`);
    if (override.provider !== undefined && (typeof override.provider !== 'string' || !override.provider.trim())) problems.push(`ai.policyOverrides.${policyId}.provider must be a non-empty string`);
    if (override.timeoutMs !== undefined && (!Number.isInteger(override.timeoutMs) || override.timeoutMs < minTimeoutMs || override.timeoutMs > maxTimeoutMs)) {
      problems.push(`ai.policyOverrides.${policyId}.timeoutMs must be a whole number of milliseconds between ${minTimeoutMs} and ${maxTimeoutMs}`);
    }
  }
  return problems;
}

/**
 * Deterministic compiler for Business Pack model policies.
 * 
 * Rules:
 * 1. Backoffice configuration compiles into the immutable published release.
 * 2. Simple mode explicitly configures the 4 primary conversational policies:
 *    - fast_intent
 *    - complex_reasoning
 *    - tool_selection
 *    - response_generation
 * 3. Simple mode does NOT preserve stale fallback candidates.
 * 4. Fallback candidate is included if and only if explicitly selected.
 * 5. Advanced mode preserves independently configured task policies.
 * 6. Validates output strictly with ModelPolicySchema.
 */
export function compileModelPolicy(input: CompileModelPolicyInput): ModelPolicy {
  const { projectId, mode = 'simple', existingModelPolicy, aiConfig, dataResidency = 'au' } = input;

  const isAdvanced = mode === 'advanced' || (existingModelPolicy as any)?.mode === 'advanced';

  // Advanced mode: preserve independently configured task policies
  if (isAdvanced && existingModelPolicy?.policies && Array.isArray(existingModelPolicy.policies) && existingModelPolicy.policies.length > 0) {
    const defaultPolicy =
      existingModelPolicy.defaultPolicy ||
      (existingModelPolicy.policies.length === 1 ? existingModelPolicy.policies[0].policyId : 'complex_reasoning');

    const compiled: ModelPolicy = {
      version: existingModelPolicy.version || '1.0.0',
      defaultPolicy,
      policies: existingModelPolicy.policies.map((p) => ({
        policyId: p.policyId,
        description: p.description || `${p.policyId} policy for ${projectId}`,
        candidates: (p.candidates || []).map((c, idx) => ({
          provider: normalizeProvider(c.provider),
          model: c.model,
          priority: c.priority ?? idx + 1,
          temperature: typeof c.temperature === 'number' ? c.temperature : undefined,
        })),
        dataResidency: p.dataResidency || dataResidency,
        acceptedResidencies: p.acceptedResidencies || [p.dataResidency || dataResidency, 'au', 'us', 'global'],
        residencyAttestation: p.residencyAttestation,
        maxInputTokens: p.maxInputTokens ?? 20000,
        maxOutputTokens: p.maxOutputTokens ?? 2000,
        fallbackAllowed: p.fallbackAllowed ?? (p.candidates && p.candidates.length > 1),
        timeoutMs: p.timeoutMs ?? 10000,
      })),
    };

    const parsed = ModelPolicySchema.safeParse(compiled);
    if (!parsed.success) {
      throw new Error(`[compileModelPolicy] Advanced model policy failed schema validation: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  // Simple mode: compile authoritative conversational policies from aiConfig
  if (!aiConfig?.provider?.trim() || !aiConfig?.model?.trim()) {
    throw new Error(`[compileModelPolicy] ai.provider and ai.model must be configured for '${projectId}'; no provider or model is assumed.`);
  }
  const primaryProvider = normalizeProvider(aiConfig.provider);
  const primaryModel = aiConfig.model.trim();
  const configuredTemp = typeof aiConfig?.temperature === 'number' ? aiConfig.temperature : 0.4;

  const hasExplicitFallback = Boolean(
    aiConfig?.fallbackProvider &&
    aiConfig?.fallbackModel &&
    (aiConfig.fallbackProvider !== primaryProvider || aiConfig.fallbackModel !== primaryModel)
  );

  const fallbackCandidate = hasExplicitFallback
    ? {
        provider: normalizeProvider(aiConfig!.fallbackProvider),
        model: aiConfig!.fallbackModel!.trim(),
        priority: 2,
        temperature: configuredTemp,
      }
    : null;

  /** The policy's candidates: the project's primary model (or this policy's override of it), then the explicit fallback if there is one. */
  const buildCandidates = (temp: number | undefined, override?: { provider?: string; model?: string }) => {
    const primary = {
      provider: override?.provider ? normalizeProvider(override.provider) : primaryProvider,
      model: override?.model ? override.model.trim() : primaryModel,
      priority: 1,
      temperature: temp,
    };
    return fallbackCandidate
      ? [primary, { ...fallbackCandidate, temperature: temp !== undefined ? temp : fallbackCandidate.temperature }]
      : [primary];
  };

  const overrideProblems = validatePolicyOverrides(aiConfig.policyOverrides);
  if (overrideProblems.length) throw new Error(`[compileModelPolicy] ${overrideProblems.join('; ')}`);

  const policies: ModelPolicyItem[] = policyDefaults.policies.map((defaults) => {
    const override = aiConfig.policyOverrides?.[defaults.policyId];
    const temperature = defaults.temperature === 'zero' ? 0.0 : configuredTemp;
    const candidates = buildCandidates(temperature, override);
    return {
      policyId: defaults.policyId,
      description: defaults.description.replace('{projectId}', projectId),
      candidates,
      dataResidency,
      acceptedResidencies: [dataResidency, 'au', 'us', 'global'],
      timeoutMs: override?.timeoutMs ?? defaults.timeoutMs,
      fallbackAllowed: hasExplicitFallback,
      maxInputTokens: defaults.maxInputTokens,
      maxOutputTokens: defaults.maxOutputTokens,
    };
  });

  const compiled: ModelPolicy = {
    version: '1.0.0',
    defaultPolicy: 'complex_reasoning',
    policies,
  };

  const parsed = ModelPolicySchema.safeParse(compiled);
  if (!parsed.success) {
    throw new Error(`[compileModelPolicy] Simple model policy failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
