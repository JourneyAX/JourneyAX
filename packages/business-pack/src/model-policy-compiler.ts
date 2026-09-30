import { ModelPolicy, ModelPolicySchema, ModelPolicyItem, ModelCandidateSchema } from './schemas/model-policy.schema';

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
  const primaryProvider = normalizeProvider(aiConfig?.provider || 'openai');
  const primaryModel = (aiConfig?.model || 'gpt-4o').trim();
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

  const buildCandidates = (policyId: string, temp?: number) => {
    const list = [
      {
        provider: primaryProvider,
        model: primaryModel,
        priority: 1,
        temperature: temp,
      },
    ];
    if (fallbackCandidate) {
      list.push({
        ...fallbackCandidate,
        temperature: temp !== undefined ? temp : fallbackCandidate.temperature,
      });
    }
    return list;
  };

  const policies: ModelPolicyItem[] = [
    {
      policyId: 'fast_intent',
      description: `Fast intent and slot extraction policy for ${projectId}`,
      candidates: buildCandidates('fast_intent', 0.0),
      dataResidency,
      acceptedResidencies: [dataResidency, 'au', 'us', 'global'],
      timeoutMs: 5000,
      fallbackAllowed: hasExplicitFallback,
      maxInputTokens: 8000,
      maxOutputTokens: 1000,
    },
    {
      policyId: 'complex_reasoning',
      description: `Complex multi-trade reasoning policy for ${projectId}`,
      candidates: buildCandidates('complex_reasoning', configuredTemp),
      dataResidency,
      acceptedResidencies: [dataResidency, 'au', 'us', 'global'],
      timeoutMs: 15000,
      fallbackAllowed: hasExplicitFallback,
      maxInputTokens: 20000,
      maxOutputTokens: 2500,
    },
    {
      policyId: 'tool_selection',
      description: `Tool and capability selection policy for ${projectId}`,
      candidates: buildCandidates('tool_selection', 0.0),
      dataResidency,
      acceptedResidencies: [dataResidency, 'au', 'us', 'global'],
      timeoutMs: 5000,
      fallbackAllowed: hasExplicitFallback,
      maxInputTokens: 8000,
      maxOutputTokens: 1000,
    },
    {
      policyId: 'response_generation',
      description: `Grounded customer response composition policy for ${projectId}`,
      candidates: buildCandidates('response_generation', configuredTemp),
      dataResidency,
      acceptedResidencies: [dataResidency, 'au', 'us', 'global'],
      timeoutMs: 15000,
      fallbackAllowed: hasExplicitFallback,
      maxInputTokens: 20000,
      maxOutputTokens: 2500,
    },
  ];

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
