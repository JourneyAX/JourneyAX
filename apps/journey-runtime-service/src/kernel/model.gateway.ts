import { BusinessPackRelease } from '@journeyax/business-pack';
import { ModelRouter, TaskType, ModelRouteResult } from '../model/model-router';
import { AgentRouter, ResolvedAgent } from './agent.router';
import { WorkspaceState } from '@journeyax/journey-core';

export class ModelGatewayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly provider?: string,
    public readonly model?: string,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = 'ModelGatewayError';
  }
}

export class ModelMissingCredentialsError extends ModelGatewayError {
  constructor(provider: string) {
    super(`Missing required API credentials for model provider '${provider}'`, 'MISSING_CREDENTIALS', provider);
    this.name = 'ModelMissingCredentialsError';
  }
}

export class ModelTimeoutError extends ModelGatewayError {
  constructor(provider: string, model: string, timeoutMs: number) {
    super(`Model request to ${provider}/${model} timed out after ${timeoutMs}ms`, 'TIMEOUT', provider, model, { timeoutMs });
    this.name = 'ModelTimeoutError';
  }
}

export class ModelProviderHttpError extends ModelGatewayError {
  constructor(provider: string, model: string, public readonly status: number, public readonly responseBody: string) {
    super(`Provider ${provider}/${model} returned HTTP ${status}: ${responseBody}`, 'PROVIDER_HTTP_ERROR', provider, model, { status, responseBody });
    this.name = 'ModelProviderHttpError';
  }
}

export class ModelMalformedResponseError extends ModelGatewayError {
  constructor(provider: string, model: string, reason: string) {
    super(`Provider ${provider}/${model} returned malformed or empty response: ${reason}`, 'MALFORMED_RESPONSE', provider, model, { reason });
    this.name = 'ModelMalformedResponseError';
  }
}

export class ModelResidencyViolationError extends ModelGatewayError {
  constructor(
    public readonly requiredResidency: string,
    public readonly actualResidency: string,
    evidence?: string
  ) {
    super(
      `Data residency violation: Required '${requiredResidency}' but actual evidenced residency is '${actualResidency}' (${evidence || 'no evidence'}). Execution blocked.`,
      'RESIDENCY_VIOLATION',
      undefined,
      undefined,
      { requiredResidency, actualResidency, evidence }
    );
    this.name = 'ModelResidencyViolationError';
  }
}

export interface ModelExecutionRequest {
  taskType: TaskType;
  prompt: string;
  systemPrompt?: string;
  targetDataResidency?: string;
  policyRef?: string;
}

export interface ModelExecutionResponse {
  content: string;
  route: ModelRouteResult;
  latencyMs: number;
  residencyProven: boolean;
  residencyEvidence: string;
}

export class ModelGateway {
  public readonly router: ModelRouter;
  public readonly agentRouter: AgentRouter;

  constructor(router?: ModelRouter, agentRouter?: AgentRouter) {
    this.router = router || new ModelRouter();
    this.agentRouter = agentRouter || new AgentRouter();
  }

  /**
   * Discovers and verifies sovereign data residency evidenced by the configured endpoint and provider runtime.
   */
  determineEndpointResidency(provider: string, endpoint: string): { residency: string; evidence: string } {
    // 1. Explicit provider residency configuration
    const envVarMap: Record<string, string | undefined> = {
      openai: process.env.OPENAI_DATA_RESIDENCY,
      anthropic: process.env.ANTHROPIC_DATA_RESIDENCY,
      google: process.env.GOOGLE_DATA_RESIDENCY || process.env.GOOGLE_CLOUD_REGION,
      'open-model': process.env.OPEN_MODEL_DATA_RESIDENCY,
      custom: process.env.CUSTOM_MODEL_DATA_RESIDENCY,
    };

    const explicitEnv = envVarMap[provider]?.trim().toLowerCase();
    if (explicitEnv) {
      const normalized = explicitEnv.includes('australia') || explicitEnv.includes('sydney') ? 'au'
        : explicitEnv.includes('europe') || explicitEnv.includes('eu-') ? 'eu'
        : explicitEnv.includes('us-') ? 'us'
        : explicitEnv;
      return {
        residency: normalized,
        evidence: `env:${provider.toUpperCase()}_DATA_RESIDENCY=${explicitEnv}`,
      };
    }

    // 2. URL Hostname pattern inspection
    try {
      const url = new URL(endpoint);
      const hostname = url.hostname.toLowerCase();
      if (
        hostname.includes('australia') ||
        hostname.includes('sydney') ||
        hostname.includes('ap-southeast-2') ||
        hostname.includes('.au.') ||
        hostname.endsWith('.au')
      ) {
        return { residency: 'au', evidence: `url_hostname:${hostname}` };
      }
      if (
        hostname.includes('europe') ||
        hostname.includes('eu-central') ||
        hostname.includes('eu-west') ||
        hostname.includes('.eu.') ||
        hostname.endsWith('.eu')
      ) {
        return { residency: 'eu', evidence: `url_hostname:${hostname}` };
      }
      if (
        hostname.includes('us-central') ||
        hostname.includes('us-east') ||
        hostname.includes('us-west') ||
        hostname.includes('.us.') ||
        hostname.endsWith('.us')
      ) {
        return { residency: 'us', evidence: `url_hostname:${hostname}` };
      }
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        const localResidency = (process.env.LOCAL_DATA_RESIDENCY || 'au').toLowerCase();
        return { residency: localResidency, evidence: `loopback_endpoint:${hostname}(LOCAL_DATA_RESIDENCY=${localResidency})` };
      }
    } catch {}

    // 3. Fallback: Standard global public cloud endpoints process predominantly in US
    return {
      residency: 'us',
      evidence: `default_global_public_cloud_endpoint:${provider}`,
    };
  }

  /**
   * Returns the configured endpoint for a given provider.
   */
  getEndpointForProvider(provider: string, model: string): string {
    switch (provider) {
      case 'openai':
        return process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions';
      case 'anthropic':
        return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';
      case 'google': {
        const base = process.env.GOOGLE_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
        return `${base}/models/${model}:generateContent`;
      }
      case 'open-model':
        return (
          process.env.OPEN_MODEL_ENDPOINT ||
          'http://localhost:8000/v1/chat/completions'
        );
      case 'custom':
        return (
          process.env.CUSTOM_MODEL_ENDPOINT ||
          'http://localhost:8000/v1/chat/completions'
        );
      default:
        throw new ModelGatewayError(`Unsupported model provider '${provider}'`, 'UNSUPPORTED_PROVIDER', provider);
    }
  }

  /**
   * Executes a model task compliant with business pack model policy and strict data residency.
   * Throws typed fail-closed errors on any failure—never fabricates responses or asserts unproven residency.
   */
  async execute(
    release: BusinessPackRelease,
    req: ModelExecutionRequest
  ): Promise<ModelExecutionResponse> {
    const startTime = Date.now();

    // 1. Resolve compliant model route
    const route = this.router.resolveModel(req.taskType, release, {
      targetDataResidency: req.targetDataResidency,
      policyRef: req.policyRef,
    });

    const endpoint = this.getEndpointForProvider(route.provider, route.model);

    // 2. Evidenced Data Residency Verification (Must be proven by endpoint/config, not just label)
    const evidenced = this.determineEndpointResidency(route.provider, endpoint);
    const requiredResidency = (req.targetDataResidency || route.dataResidency).trim().toLowerCase();

    // Find the active policy item for residency allow-lists & attestations
    const policy =
      release.modelPolicy?.policies?.find((p: any) => p.policyId === route.policyId) ||
      release.modelPolicy?.policies?.find((p: any) => p.policyId === req.policyRef);

    const allowedResidencies = new Set<string>([requiredResidency]);

    // Add accepted residencies from pack policy
    if (policy && Array.isArray((policy as any).acceptedResidencies)) {
      for (const r of (policy as any).acceptedResidencies) {
        if (typeof r === 'string' && r.trim()) {
          allowedResidencies.add(r.trim().toLowerCase());
        }
      }
    }

    // Add attested residency from pack policy
    if (policy && (policy as any).residencyAttestation?.attestedResidency) {
      allowedResidencies.add(String((policy as any).residencyAttestation.attestedResidency).trim().toLowerCase());
    }

    // Add platform config allowlist from environment if specified
    const platformAllowed = process.env.ACCEPTED_DATA_RESIDENCIES;
    if (platformAllowed) {
      for (const r of platformAllowed.split(',')) {
        if (r.trim()) allowedResidencies.add(r.trim().toLowerCase());
      }
    }

    const evidencedResidencyNorm = evidenced.residency.toLowerCase();
    if (!allowedResidencies.has(evidencedResidencyNorm)) {
      throw new ModelResidencyViolationError(
        requiredResidency,
        evidenced.residency,
        `${evidenced.evidence}; allowed=[${Array.from(allowedResidencies).join(', ')}]`
      );
    }

    // 3. Credential Verification
    const apiKey = this.getApiKeyForProvider(route.provider);
    if (route.provider !== 'open-model' && route.provider !== 'custom' && !apiKey) {
      throw new ModelMissingCredentialsError(route.provider);
    }

    // 4. Provider Call Execution
    const timeoutMs = route.timeoutMs || 10000;
    let signal: AbortSignal;
    try {
      signal = AbortSignal.timeout(timeoutMs);
    } catch {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), timeoutMs);
      signal = controller.signal;
    }

    let resp: Response;
    try {
      if (route.provider === 'openai') {
        resp = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: route.model,
            messages: [
              ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
              { role: 'user', content: req.prompt },
            ],
            temperature: route.temperature ?? 0.2,
            max_tokens: route.maxOutputTokens,
          }),
        });
      } else if (route.provider === 'anthropic') {
        resp = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey || '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: route.model,
            system: req.systemPrompt,
            messages: [{ role: 'user', content: req.prompt }],
            temperature: route.temperature ?? 0.2,
            max_tokens: route.maxOutputTokens,
          }),
        });
      } else if (route.provider === 'google') {
        const urlWithKey = endpoint.includes('?') ? `${endpoint}&key=${apiKey}` : `${endpoint}?key=${apiKey}`;
        resp = await fetch(urlWithKey, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
            systemInstruction: req.systemPrompt ? { parts: [{ text: req.systemPrompt }] } : undefined,
            generationConfig: {
              temperature: route.temperature ?? 0.2,
              maxOutputTokens: route.maxOutputTokens,
            },
          }),
        });
      } else {
        // open-model / custom OpenAI-compatible endpoint
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        resp = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers,
          body: JSON.stringify({
            model: route.model,
            messages: [
              ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
              { role: 'user', content: req.prompt },
            ],
            temperature: route.temperature ?? 0.2,
            max_tokens: route.maxOutputTokens,
          }),
        });
      }
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ModelTimeoutError(route.provider, route.model, timeoutMs);
      }
      throw new ModelGatewayError(
        `Failed to execute model request to ${route.provider}/${route.model}: ${err.message}`,
        'NETWORK_FAILURE',
        route.provider,
        route.model,
        { cause: err.message }
      );
    }

    if (!resp.ok) {
      const errorBody = await resp.text();
      throw new ModelProviderHttpError(route.provider, route.model, resp.status, errorBody);
    }

    let responseData: any;
    try {
      responseData = await resp.json();
    } catch (err: any) {
      throw new ModelMalformedResponseError(route.provider, route.model, 'Invalid JSON received from provider');
    }

    let content = '';
    if (route.provider === 'openai' || route.provider === 'open-model' || route.provider === 'custom') {
      content = responseData.choices?.[0]?.message?.content || '';
    } else if (route.provider === 'anthropic') {
      content = responseData.content?.[0]?.text || '';
    } else if (route.provider === 'google') {
      content = responseData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    if (!content || !content.trim()) {
      throw new ModelMalformedResponseError(
        route.provider,
        route.model,
        'Provider response contained empty content or empty choices array'
      );
    }

    return {
      content: content.trim(),
      route,
      latencyMs: Date.now() - startTime,
      residencyProven: true,
      residencyEvidence: evidenced.evidence,
    };
  }

  /**
   * High-level agent execution: resolves specialist agent, composes structured token-safe prompt,
   * binds agent modelPolicyRef, and executes compliant model generation.
   */
  async executeWithAgent(
    release: BusinessPackRelease,
    workspace: WorkspaceState,
    userMessage: string,
    options?: {
      taskType?: TaskType;
      targetDataResidency?: string;
    }
  ): Promise<ModelExecutionResponse & { agent: ResolvedAgent }> {
    const resolvedAgent = this.agentRouter.resolveAgent(release, workspace);
    const { systemPrompt, userPrompt } = this.agentRouter.composePrompt(
      resolvedAgent,
      workspace,
      userMessage
    );

    const taskType = options?.taskType || 'complex_reasoning';
    const executionResponse = await this.execute(release, {
      taskType,
      prompt: userPrompt,
      systemPrompt,
      targetDataResidency: options?.targetDataResidency,
      policyRef: resolvedAgent.modelPolicyRef,
    });

    return {
      ...executionResponse,
      agent: resolvedAgent,
    };
  }

  private getApiKeyForProvider(provider: string): string | undefined {
    switch (provider) {
      case 'openai':
        return process.env.OPENAI_API_KEY;
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
      case 'google':
        return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      default:
        return undefined;
    }
  }
}
