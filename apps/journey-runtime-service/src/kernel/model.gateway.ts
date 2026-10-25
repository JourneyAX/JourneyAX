import { BusinessPackRelease } from '@journeyax/business-pack';
import { ModelRouter, TaskType, ModelRouteResult } from '../model/model-router';
import { AgentRouter, ResolvedAgent } from './agent.router';
import { WorkspaceState } from '@journeyax/journey-core';

/**
 * The temperature part of a Claude request. Claude's newer models (the 5.x family) refuse the setting ("`temperature` is deprecated for
 * this model", HTTP 400), so none is sent to them; earlier models still take the pack's value.
 */
export function anthropicTemperature(model: string, temperature: number | undefined): { temperature?: number } {
  if (/^claude-[a-z]+-5(?:-|$)/i.test(model)) return {};
  return { temperature: temperature ?? 0.2 };
}

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
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AgentExecutionRequest {
  taskType?: TaskType;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: AgentToolDefinition[];
  policyRef?: string;
  targetDataResidency?: string;
}

export interface AgentExecutionResponse {
  content: string;
  toolCalls: AgentToolCall[];
  route: ModelRouteResult;
  latencyMs: number;
  residencyProven: boolean;
  residencyEvidence: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
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

    const routes = this.router.resolveCandidates(req.taskType, release, {
      targetDataResidency: req.targetDataResidency,
      policyRef: req.policyRef,
    });

    let lastError: any = null;
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      try {
        return await this.executeRoute(route, release, req, startTime);
      } catch (err: any) {
        lastError = err;
        if (i < routes.length - 1) {
          const next = routes[i + 1];
          console.warn(
            `[ModelGateway] Candidate ${route.provider}/${route.model} failed (${err.name || err.message}). Attempting fallback to ${next.provider}/${next.model}...`
          );
        }
      }
    }
    throw lastError;
  }

  async executeStream(
    release: BusinessPackRelease,
    req: ModelExecutionRequest,
    onDelta: (delta: string) => void
  ): Promise<ModelExecutionResponse> {
    const startTime = Date.now();

    const routes = this.router.resolveCandidates(req.taskType, release, {
      targetDataResidency: req.targetDataResidency,
      policyRef: req.policyRef,
    });

    let lastError: any = null;
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      try {
        return await this.executeRouteStream(route, release, req, onDelta, startTime);
      } catch (err: any) {
        lastError = err;
        if (i < routes.length - 1) {
          const next = routes[i + 1];
          console.warn(
            `[ModelGateway] Candidate stream ${route.provider}/${route.model} failed (${err.name || err.message}). Attempting fallback to ${next.provider}/${next.model}...`
          );
        }
      }
    }
    throw lastError;
  }

  /**
   * Optional mock executor for scripted agent tests without network.
   */
  public mockAgentExecutor?: (
    req: AgentExecutionRequest,
    onDelta?: (delta: string) => void,
    signal?: AbortSignal,
    route?: ModelRouteResult,
    attempt?: number
  ) => Promise<{
    content: string;
    toolCalls: AgentToolCall[];
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  }>;

  /**
   * Executes an autonomous agent turn with streaming tokens and structured tool calling.
   * Supports OpenAI-compatible first and Anthropic second.
   * Implements Task A4 resilience: retries once per candidate, then falls back to next candidate model.
   */
  async executeAgentStream(
    release: BusinessPackRelease,
    req: AgentExecutionRequest,
    onDelta: (delta: string) => void = () => {},
    signal?: AbortSignal
  ): Promise<AgentExecutionResponse> {
    const startTime = Date.now();

    if (signal?.aborted) {
      throw signal.reason || new Error('Agent turn aborted');
    }

    const taskType: TaskType = req.taskType || 'agent_turn';
    let routes: ModelRouteResult[] = [];
    try {
      routes = this.router.resolveCandidates(taskType, release, {
        targetDataResidency: req.targetDataResidency,
        policyRef: req.policyRef,
      });
    } catch (err: any) {
      if (!this.mockAgentExecutor) {
        throw err;
      }
      routes = [
        {
          policyId: req.policyRef || 'mock_agent_policy',
          provider: 'custom',
          model: 'mock-agent',
          dataResidency: 'au',
          maxInputTokens: 8192,
          maxOutputTokens: 4096,
          timeoutMs: 10000,
        },
      ];
    }

    if (routes.length === 0) {
      routes = [
        {
          policyId: req.policyRef || 'mock_agent_policy',
          provider: 'custom',
          model: 'mock-agent',
          dataResidency: 'au',
          maxInputTokens: 8192,
          maxOutputTokens: 4096,
          timeoutMs: 10000,
        },
      ];
    }

    let lastError: any = null;
    for (let i = 0; i < routes.length; i++) {
      if (signal?.aborted) {
        throw signal.reason || new Error('Agent turn aborted');
      }
      const route = routes[i];
      const maxAttempts = 2; // Initial attempt + retry once

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
          throw signal.reason || new Error('Agent turn aborted');
        }
        try {
          if (this.mockAgentExecutor) {
            const mockResult = await this.mockAgentExecutor(req, onDelta, signal, route, attempt);
            if (signal?.aborted) {
              throw signal.reason || new Error('Agent turn aborted');
            }
            return {
              content: mockResult.content || '',
              toolCalls: mockResult.toolCalls || [],
              route,
              latencyMs: Date.now() - startTime,
              residencyProven: true,
              residencyEvidence: 'mock:internal',
              usage: mockResult.usage,
            };
          }

          return await this.executeRouteAgentStream(route, release, req, onDelta, startTime, signal);
        } catch (err: any) {
          if (signal?.aborted) {
            throw signal.reason || err;
          }
          lastError = err;
          if (attempt < maxAttempts) {
            console.warn(
              `[ModelGateway] Candidate agent stream ${route.provider}/${route.model} failed (attempt ${attempt}/${maxAttempts}: ${err.name || err.message}). Retrying once...`
            );
          } else if (i < routes.length - 1) {
            const next = routes[i + 1];
            console.warn(
              `[ModelGateway] Candidate agent stream ${route.provider}/${route.model} exhausted retries. Attempting fallback to candidate ${next.provider}/${next.model}...`
            );
          }
        }
      }
    }
    throw lastError;
  }

  private prepareExecution(
    route: ModelRouteResult,
    release: BusinessPackRelease,
    req: ModelExecutionRequest,
    clientSignal?: AbortSignal
  ): {
    endpoint: string;
    evidenced: { residency: string; evidence: string };
    apiKey: string | undefined;
    signal: AbortSignal;
    timeoutMs: number;
  } {
    const endpoint = this.getEndpointForProvider(route.provider, route.model);

    // Evidenced Data Residency Verification (Must be proven by endpoint/config, not just label)
    const evidenced = this.determineEndpointResidency(route.provider, endpoint);
    const requiredResidency = (req.targetDataResidency || route.dataResidency || 'au').trim().toLowerCase();

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

    // Credential Verification
    const apiKey = this.getApiKeyForProvider(route.provider);
    if (route.provider !== 'open-model' && route.provider !== 'custom' && !apiKey) {
      throw new ModelMissingCredentialsError(route.provider);
    }

    // Provider Call Execution
    const timeoutMs = route.timeoutMs || 10000;
    let signal: AbortSignal;
    if (!clientSignal) {
      try {
        signal = AbortSignal.timeout(timeoutMs);
      } catch {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error(`Timeout (${timeoutMs}ms)`)), timeoutMs);
        signal = controller.signal;
      }
    } else if (clientSignal.aborted) {
      signal = clientSignal;
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`Timeout (${timeoutMs}ms)`)), timeoutMs);
      clientSignal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          controller.abort(clientSignal.reason);
        },
        { once: true }
      );
      signal = controller.signal;
    }

    return { endpoint, evidenced, apiKey, signal, timeoutMs };
  }

  private async executeRouteStream(
    route: ModelRouteResult,
    release: BusinessPackRelease,
    req: ModelExecutionRequest,
    onDelta: (delta: string) => void,
    startTime: number
  ): Promise<ModelExecutionResponse> {
    const { endpoint, evidenced, apiKey, signal, timeoutMs } = this.prepareExecution(route, release, req);

    let resp: Response;
    try {
      if (route.provider === 'openai') {
        const isReasoningOrGpt5 =
          route.model.startsWith('o1') ||
          route.model.startsWith('o3') ||
          route.model.startsWith('gpt-5') ||
          route.model.includes('preview');

        const payload: Record<string, any> = {
          model: route.model,
          messages: [
            ...(req.systemPrompt
              ? [{ role: isReasoningOrGpt5 ? 'developer' : 'system', content: req.systemPrompt }]
              : []),
            { role: 'user', content: req.prompt },
          ],
          stream: true,
        };

        payload.stream_options = { include_usage: true };
        if (isReasoningOrGpt5) {
          if (route.maxOutputTokens) payload.max_completion_tokens = route.maxOutputTokens;
          if (route.reasoningEffort) payload.reasoning_effort = route.reasoningEffort;
        } else {
          if (route.temperature !== undefined) payload.temperature = route.temperature;
          else payload.temperature = 0.2;
          if (route.maxOutputTokens) payload.max_tokens = route.maxOutputTokens;
        }

        resp = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
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
            ...anthropicTemperature(route.model, route.temperature),
            max_tokens: route.maxOutputTokens,
            stream: true,
          }),
        });
      } else if (route.provider === 'open-model' || route.provider === 'custom') {
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
            stream: true,
          }),
        });
      } else {
        // Fall back to non-streaming execution and emit single delta
        const nonStreamRes = await this.executeRoute(route, release, req, startTime);
        if (nonStreamRes.content) {
          onDelta(nonStreamRes.content);
        }
        return nonStreamRes;
      }
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ModelTimeoutError(route.provider, route.model, timeoutMs);
      }
      throw new ModelGatewayError(
        `Failed to execute model streaming request to ${route.provider}/${route.model}: ${err.message}`,
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

    if (!resp.body) {
      const nonStreamRes = await this.executeRoute(route, release, req, startTime);
      if (nonStreamRes.content) onDelta(nonStreamRes.content);
      return nonStreamRes;
    }

    let content = '';
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;

    if (route.provider === 'openai' || route.provider === 'open-model' || route.provider === 'custom') {
      await readSseStream(resp.body, (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) return;
        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') return;
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              content += delta;
              onDelta(delta);
            }
            if (parsed.usage) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens,
              };
            }
          } catch {}
        }
      });
    } else if (route.provider === 'anthropic') {
      await readSseStream(resp.body, (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) return;
        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              const delta = parsed.delta.text;
              content += delta;
              onDelta(delta);
            } else if (parsed.type === 'message_start' && parsed.message?.usage) {
              usage = {
                promptTokens: parsed.message.usage.input_tokens,
                completionTokens: 0,
                totalTokens: parsed.message.usage.input_tokens,
              };
            } else if (parsed.type === 'message_delta' && parsed.usage) {
              const out = parsed.usage.output_tokens || 0;
              const inTokens = usage?.promptTokens || 0;
              usage = {
                promptTokens: inTokens,
                completionTokens: out,
                totalTokens: inTokens + out,
              };
            }
          } catch {}
        }
      });
    }

    if (!content || !content.trim()) {
      throw new ModelMalformedResponseError(
        route.provider,
        route.model,
        'Provider streaming response contained empty content'
      );
    }

    return {
      content: content.trim(),
      route,
      latencyMs: Date.now() - startTime,
      residencyProven: true,
      residencyEvidence: evidenced.evidence,
      usage,
    };
  }

  private async executeRouteAgentStream(
    route: ModelRouteResult,
    release: BusinessPackRelease,
    req: AgentExecutionRequest,
    onDelta: (delta: string) => void,
    startTime: number,
    clientSignal?: AbortSignal
  ): Promise<AgentExecutionResponse> {
    const { endpoint, evidenced, apiKey, signal, timeoutMs } = this.prepareExecution(
      route,
      release,
      {
        taskType: req.taskType || 'agent_turn',
        prompt: '',
        systemPrompt: req.systemPrompt,
        policyRef: req.policyRef,
        targetDataResidency: req.targetDataResidency,
      },
      clientSignal
    );

    let resp: Response;
    try {
      if (route.provider === 'openai' || route.provider === 'open-model' || route.provider === 'custom') {
        const isReasoningOrGpt5 =
          route.model.startsWith('o1') ||
          route.model.startsWith('o3') ||
          route.model.startsWith('gpt-5') ||
          route.model.includes('preview');

        const messages: any[] = [];
        if (req.systemPrompt) {
          messages.push({ role: isReasoningOrGpt5 ? 'developer' : 'system', content: req.systemPrompt });
        }
        for (const m of req.messages) {
          if (m.role === 'tool') {
            messages.push({
              role: 'tool',
              tool_call_id: m.tool_call_id,
              content: m.content || '',
            });
          } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            messages.push({
              role: 'assistant',
              content: m.content || null,
              tool_calls: m.tool_calls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
                },
              })),
            });
          } else {
            messages.push({ role: m.role, content: m.content || '' });
          }
        }

        const payload: Record<string, any> = {
          model: route.model,
          messages,
          stream: true,
        };

        if (req.tools && req.tools.length > 0) {
          payload.tools = req.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }));
          payload.tool_choice = 'auto';
        }

        payload.stream_options = { include_usage: true };
        if (isReasoningOrGpt5) {
          if (route.maxOutputTokens) payload.max_completion_tokens = route.maxOutputTokens;
          if (route.reasoningEffort) payload.reasoning_effort = route.reasoningEffort;
        } else {
          if (route.temperature !== undefined) payload.temperature = route.temperature;
          else payload.temperature = 0.2;
          if (route.maxOutputTokens) payload.max_tokens = route.maxOutputTokens;
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        resp = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers,
          body: JSON.stringify(payload),
        });
      } else if (route.provider === 'anthropic') {
        const anthropicMessages: any[] = [];
        for (const m of req.messages) {
          if (m.role === 'tool') {
            anthropicMessages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: m.tool_call_id,
                  content: m.content || '',
                },
              ],
            });
          } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            const contentParts: any[] = [];
            if (m.content) contentParts.push({ type: 'text', text: m.content });
            for (const tc of m.tool_calls) {
              contentParts.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: tc.arguments,
              });
            }
            anthropicMessages.push({ role: 'assistant', content: contentParts });
          } else if (m.role === 'user' || m.role === 'assistant') {
            anthropicMessages.push({ role: m.role, content: m.content || '' });
          }
        }

        const payload: Record<string, any> = {
          model: route.model,
          messages: anthropicMessages,
          stream: true,
          max_tokens: route.maxOutputTokens || 4096,
          ...anthropicTemperature(route.model, route.temperature),
        };
        if (req.systemPrompt) payload.system = req.systemPrompt;
        if (req.tools && req.tools.length > 0) {
          payload.tools = req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          }));
        }

        resp = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey || '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(payload),
        });
      } else {
        throw new ModelGatewayError(
          `Provider '${route.provider}' does not support agent tool-calling streaming.`,
          'UNSUPPORTED_PROVIDER',
          route.provider,
          route.model
        );
      }
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ModelTimeoutError(route.provider, route.model, timeoutMs);
      }
      throw new ModelGatewayError(
        `Failed to execute model agent request to ${route.provider}/${route.model}: ${err.message}`,
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

    if (!resp.body) {
      throw new ModelMalformedResponseError(route.provider, route.model, 'Response body is empty');
    }

    let content = '';
    const toolCallsMap = new Map<number, { id: string; name: string; argsStr: string }>();
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;

    if (route.provider === 'openai' || route.provider === 'open-model' || route.provider === 'custom') {
      await readSseStream(
        resp.body,
        (line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) return;
          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') return;
            try {
              const parsed = JSON.parse(dataStr);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta;
              if (delta?.content) {
                content += delta.content;
                onDelta(delta.content);
              }
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  let existing = toolCallsMap.get(idx);
                  if (!existing) {
                    existing = { id: tc.id || `call_${idx}_${Date.now()}`, name: tc.function?.name || '', argsStr: '' };
                    toolCallsMap.set(idx, existing);
                  }
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name = tc.function.name;
                  if (tc.function?.arguments) existing.argsStr += tc.function.arguments;
                }
              }
              if (parsed.usage) {
                usage = {
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens,
                  totalTokens: parsed.usage.total_tokens,
                };
              }
            } catch {}
          }
        },
        signal
      );
    } else if (route.provider === 'anthropic') {
      let currentToolIdx = -1;
      await readSseStream(
        resp.body,
        (line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) return;
          if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.type === 'content_block_start') {
              if (parsed.content_block?.type === 'tool_use') {
                currentToolIdx = parsed.index ?? toolCallsMap.size;
                toolCallsMap.set(currentToolIdx, {
                  id: parsed.content_block.id || `tool_${Date.now()}`,
                  name: parsed.content_block.name || '',
                  argsStr: '',
                });
              }
            } else if (parsed.type === 'content_block_delta') {
              if (parsed.delta?.type === 'text_delta' && parsed.delta?.text) {
                content += parsed.delta.text;
                onDelta(parsed.delta.text);
              } else if (parsed.delta?.type === 'input_json_delta' && parsed.delta?.partial_json) {
                const existing = toolCallsMap.get(currentToolIdx);
                if (existing) existing.argsStr += parsed.delta.partial_json;
              }
            } else if (parsed.type === 'message_start' && parsed.message?.usage) {
              usage = {
                promptTokens: parsed.message.usage.input_tokens,
                completionTokens: 0,
                totalTokens: parsed.message.usage.input_tokens,
              };
            } else if (parsed.type === 'message_delta' && parsed.usage) {
              const out = parsed.usage.output_tokens || 0;
              const inTokens = usage?.promptTokens || 0;
              usage = {
                promptTokens: inTokens,
                completionTokens: out,
                totalTokens: inTokens + out,
              };
            }
          } catch {}
        }
      },
      signal
    );
  }

    const toolCalls: AgentToolCall[] = [];
    for (const [, item] of toolCallsMap.entries()) {
      let args: Record<string, any> = {};
      try {
        args = item.argsStr ? JSON.parse(item.argsStr) : {};
      } catch {
        args = { raw: item.argsStr };
      }
      toolCalls.push({
        id: item.id,
        name: item.name,
        arguments: args,
      });
    }

    if (!content.trim() && toolCalls.length === 0) {
      throw new ModelMalformedResponseError(
        route.provider,
        route.model,
        'Provider agent streaming response contained neither content nor tool calls'
      );
    }

    return {
      content: content.trim(),
      toolCalls,
      route,
      latencyMs: Date.now() - startTime,
      residencyProven: true,
      residencyEvidence: evidenced.evidence,
      usage,
    };
  }

  private async executeRoute(
    route: ModelRouteResult,
    release: BusinessPackRelease,
    req: ModelExecutionRequest,
    startTime: number
  ): Promise<ModelExecutionResponse> {
    const { endpoint, evidenced, apiKey, signal, timeoutMs } = this.prepareExecution(route, release, req);

    let resp: Response;
    try {
      if (route.provider === 'openai') {
        const isReasoningOrGpt5 =
          route.model.startsWith('o1') ||
          route.model.startsWith('o3') ||
          route.model.startsWith('gpt-5') ||
          route.model.includes('preview');

        const payload: Record<string, any> = {
          model: route.model,
          messages: [
            ...(req.systemPrompt
              ? [{ role: isReasoningOrGpt5 ? 'developer' : 'system', content: req.systemPrompt }]
              : []),
            { role: 'user', content: req.prompt },
          ],
        };

        if (isReasoningOrGpt5) {
          if (route.maxOutputTokens) payload.max_completion_tokens = route.maxOutputTokens;
          if (route.reasoningEffort) payload.reasoning_effort = route.reasoningEffort;
        } else {
          if (route.temperature !== undefined) payload.temperature = route.temperature;
          else payload.temperature = 0.2;
          if (route.maxOutputTokens) payload.max_tokens = route.maxOutputTokens;
        }

        resp = await fetch(endpoint, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
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
            ...anthropicTemperature(route.model, route.temperature),
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
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    if (route.provider === 'openai' || route.provider === 'open-model' || route.provider === 'custom') {
      content = responseData.choices?.[0]?.message?.content || '';
      if (responseData.usage) {
        usage = {
          promptTokens: responseData.usage.prompt_tokens,
          completionTokens: responseData.usage.completion_tokens,
          totalTokens: responseData.usage.total_tokens,
        };
      }
    } else if (route.provider === 'anthropic') {
      content = responseData.content?.[0]?.text || '';
      if (responseData.usage) {
        const inputTokens = responseData.usage.input_tokens || 0;
        const outputTokens = responseData.usage.output_tokens || 0;
        usage = {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }
    } else if (route.provider === 'google') {
      content = responseData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (responseData.usageMetadata) {
        usage = {
          promptTokens: responseData.usageMetadata.promptTokenCount,
          completionTokens: responseData.usageMetadata.candidatesTokenCount,
          totalTokens: responseData.usageMetadata.totalTokenCount,
        };
      }
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
      usage,
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
      /** Who is asking; without it the caller is treated as a shopper, so a staff-only agent is never chosen by mistake. */
      principal?: { audience: 'shopper' | 'staff'; groups: string[] };
    }
  ): Promise<ModelExecutionResponse & { agent: ResolvedAgent }> {
    const resolvedAgent = this.agentRouter.resolveAgent(release, workspace, undefined, options?.principal);
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

/**
 * Reads a streaming response body line-by-line for Server-Sent Events (SSE).
 */
async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      throw signal.reason || new Error('Stream aborted');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      onLine(line);
    }
  }
  if (buffer.trim()) {
    onLine(buffer);
  }
}

