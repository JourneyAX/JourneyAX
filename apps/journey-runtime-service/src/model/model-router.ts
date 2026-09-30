import { BusinessPackRelease } from '@journeyax/business-pack';

export type TaskType =
  | 'fact_extraction'
  | 'planning'
  | 'tool_selection'
  | 'complex_reasoning'
  | 'fast_intent'
  | 'response_generation';

export interface ModelRouteResult {
  policyId: string;
  provider: 'openai' | 'anthropic' | 'google' | 'open-model' | 'custom';
  model: string;
  temperature?: number;
  dataResidency: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  tenantId?: string;
  environmentId?: string;
  releaseVersion?: string;
}

export class ModelRouter {
  /**
   * Resolves the authoritative model candidate for a given task and Business Pack release.
   * Enforces data residency, provider whitelist, and priority order.
   * Throws explicit errors if no compliant provider is available—never silently falls back to an unlisted model.
   */
  resolveModel(
    taskType: TaskType,
    release: BusinessPackRelease,
    options?: {
      targetDataResidency?: string;
      preferredProvider?: string;
      policyRef?: string;
    }
  ): ModelRouteResult {
    const modelPolicy = release.modelPolicy;
    if (!modelPolicy || !Array.isArray(modelPolicy.policies) || modelPolicy.policies.length === 0) {
      throw new Error(`[ModelRouter] Release '${release.manifest?.name || 'unknown'}' has no valid modelPolicy defined.`);
    }

    // 1. Map task type or explicit policyRef to target policyId
    let targetPolicyId = options?.policyRef || modelPolicy.defaultPolicy;
    if (!options?.policyRef) {
      if (taskType === 'fact_extraction' || taskType === 'fast_intent') {
        const fastPolicy = modelPolicy.policies.find((p) => p.policyId === 'fast_intent');
        if (fastPolicy) targetPolicyId = 'fast_intent';
      } else if (taskType === 'planning' || taskType === 'complex_reasoning') {
        const complexPolicy = modelPolicy.policies.find((p) => p.policyId === 'complex_reasoning');
        if (complexPolicy) targetPolicyId = 'complex_reasoning';
      } else if (taskType === 'tool_selection') {
        const toolPolicy = modelPolicy.policies.find((p) => p.policyId === 'tool_selection' || p.policyId === 'complex_reasoning');
        if (toolPolicy) targetPolicyId = toolPolicy.policyId;
      } else if (taskType === 'response_generation') {
        const respPolicy = modelPolicy.policies.find((p) => p.policyId === 'response_generation');
        if (respPolicy) {
          targetPolicyId = 'response_generation';
        } else {
          const complexPolicy = modelPolicy.policies.find((p) => p.policyId === 'complex_reasoning');
          if (complexPolicy) targetPolicyId = 'complex_reasoning';
        }
      }
    }

    // 2. Find policy item
    const policy =
      modelPolicy.policies.find((p) => p.policyId === targetPolicyId) ||
      modelPolicy.policies.find((p) => p.policyId === modelPolicy.defaultPolicy);

    if (!policy) {
      throw new Error(
        `[ModelRouter] No matching policy found for targetPolicyId='${targetPolicyId}' or defaultPolicy='${modelPolicy.defaultPolicy}'. Available policies: ${modelPolicy.policies.map((p) => p.policyId).join(', ')} - failing closed.`
      );
    }

    // 3. Verify data residency (case-insensitive)
    if (options?.targetDataResidency && policy.dataResidency && policy.dataResidency.trim().toLowerCase() !== options.targetDataResidency.trim().toLowerCase()) {
      if (!policy.fallbackAllowed) {
        throw new Error(
          `[ModelRouter] Data residency mismatch for policy '${policy.policyId}': required '${options.targetDataResidency}', policy specifies '${policy.dataResidency}', and fallback is not allowed.`
        );
      }
    }

    // 4. Sort candidates by priority ascending (1 = highest priority)
    const sortedCandidates = [...policy.candidates].sort((a, b) => a.priority - b.priority);

    // 5. Select best available candidate
    let selected: (typeof sortedCandidates)[0] | null = null;

    if (options?.preferredProvider) {
      selected = sortedCandidates.find((c) => c.provider === options.preferredProvider) || null;
    }

    if (!selected) {
      if (policy.fallbackAllowed === false) {
        // Fallback is strictly disallowed: only priority 1 candidate is permitted
        const primaryCandidates = sortedCandidates.filter((c) => c.priority === 1);
        const configuredPrimary = primaryCandidates.find((c) => this.isProviderConfigured(c.provider));
        if (configuredPrimary) {
          selected = configuredPrimary;
        } else {
          throw new Error(
            `[ModelRouter] No configured API credentials found for primary candidate in policy '${policy.policyId}' (primary: ${primaryCandidates.map((c) => `${c.provider}/${c.model}`).join(', ')}), and fallback is not allowed.`
          );
        }
      } else {
        // Fallback is allowed: iterate sorted candidates and select first configured candidate
        for (const candidate of sortedCandidates) {
          if (this.isProviderConfigured(candidate.provider)) {
            selected = candidate;
            break;
          }
        }
      }
    }

    // If still none found, check if fallback is permitted among listed candidates
    if (!selected && sortedCandidates.length > 0) {
      if (policy.fallbackAllowed) {
        const topPriority = Math.min(...sortedCandidates.map((c) => c.priority));
        const topCandidates = sortedCandidates.filter((c) => c.priority === topPriority);
        if (topCandidates.length > 1) {
          throw new Error(
            `[ModelRouter] Ambiguous top-priority candidates (${topCandidates.map((c) => `${c.provider}/${c.model}`).join(', ')}) in policy '${policy.policyId}' with no credentials configured - failing closed.`
          );
        }
        selected = topCandidates[0];
      } else {
        throw new Error(
          `[ModelRouter] No configured API credentials found for policy '${policy.policyId}' (candidates: ${sortedCandidates.map((c) => `${c.provider}/${c.model}`).join(', ')}), and fallback is not allowed.`
        );
      }
    }

    if (!selected) {
      throw new Error(`[ModelRouter] No compliant candidate models found in policy '${policy.policyId}'. Never falling back to unlisted model.`);
    }

    const tenantId = release.manifest?.tenantId || 'unknown';
    const environmentId = release.manifest?.environmentId || 'unknown';
    const releaseVersion = release.manifest?.version || (release.modelPolicy as any)?.version || '1.0.0';

    return {
      policyId: policy.policyId,
      provider: selected.provider as ModelRouteResult['provider'],
      model: selected.model,
      temperature: selected.temperature,
      dataResidency: policy.dataResidency,
      maxInputTokens: policy.maxInputTokens,
      maxOutputTokens: policy.maxOutputTokens,
      timeoutMs: policy.timeoutMs,
      tenantId,
      environmentId,
      releaseVersion,
    };
  }

  private isProviderConfigured(provider: string): boolean {
    switch (provider) {
      case 'openai':
        return Boolean(process.env.OPENAI_API_KEY);
      case 'google':
        return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
      case 'anthropic':
        return Boolean(process.env.ANTHROPIC_API_KEY);
      case 'open-model':
      case 'custom':
        return Boolean(
          process.env.OPEN_MODEL_ENDPOINT ||
          process.env.OPEN_MODEL_URL ||
          process.env.CUSTOM_MODEL_ENDPOINT ||
          process.env.CUSTOM_MODEL_URL ||
          process.env.NODE_ENV === 'test' ||
          !process.env.NODE_ENV
        );
      default:
        return false;
    }
  }
}
