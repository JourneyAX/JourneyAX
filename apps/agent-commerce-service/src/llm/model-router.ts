import { Injectable, Optional } from '@nestjs/common';
import OpenAI from 'openai';
import { getChatClient } from './provider';

/**
 * Reasoning models (gpt-5.x / o-series) reject an explicit temperature
 * and require reasoning effort tuning where supported.
 */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[134])/.test(model);
}

/**
 * Derives generation parameters based on the model and project configuration.
 */
export function genParams(
  model: string,
  temperature?: number
): { temperature?: number; reasoning_effort?: 'low' } {
  if (isReasoningModel(model)) {
    return model === 'gpt-5' ? { reasoning_effort: 'low' } : {};
  }
  if (typeof temperature === 'number') {
    return { temperature };
  }
  return {};
}

/**
 * Output budget for self-hosted / open models, clamped to safe boundaries.
 */
export function openModelMaxTokens(projectConfig: any): number {
  const n = Number(projectConfig?.maxTokens);
  if (!Number.isFinite(n) || n <= 0) return 768;
  return Math.min(Math.max(Math.round(n), 128), 4096);
}

export interface ModelCallOptions {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * ModelRouter: Responsible for routing LLM completions and streams
 * via the configured provider client without hardcoded tenant branches.
 */
@Injectable()
export class ModelRouter {
  private defaultClient?: OpenAI;

  constructor(@Optional() defaultClient?: OpenAI) {
    this.defaultClient = defaultClient;
  }

  getClient(opts: { provider?: string; apiKey?: string; baseUrl?: string }): OpenAI {
    if (opts.provider || opts.apiKey || opts.baseUrl) {
      return getChatClient({
        provider: opts.provider,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      });
    }
    if (!this.defaultClient) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        if (process.env.NODE_ENV !== 'production') {
          this.defaultClient = new OpenAI({
            apiKey: 'test-env-key',
            timeout: 60_000,
            maxRetries: 2,
          });
          return this.defaultClient;
        }
        throw new Error(
          'ModelRouter: No explicit provider/key configured and OPENAI_API_KEY environment variable is not set.'
        );
      }
      this.defaultClient = new OpenAI({
        apiKey,
        timeout: 60_000,
        maxRetries: 2,
      });
    }
    return this.defaultClient;
  }

  async createChatCompletion(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
    opts: ModelCallOptions,
    extra: { tool_choice?: any; max_tokens?: number } = {}
  ): Promise<OpenAI.ChatCompletion> {
    const client = this.getClient(opts);
    const params = genParams(opts.model, opts.temperature);

    const callPayload: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: opts.model,
      messages,
      ...params,
      ...(tools && tools.length ? { tools } : {}),
      ...(extra.tool_choice ? { tool_choice: extra.tool_choice } : {}),
      ...(extra.max_tokens ? { max_tokens: extra.max_tokens } : {}),
    };

    return client.chat.completions.create(callPayload);
  }

  async createChatCompletionStream(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
    opts: ModelCallOptions,
    extra: { tool_choice?: any; max_tokens?: number } = {}
  ): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>> {
    const client = this.getClient(opts);
    const params = genParams(opts.model, opts.temperature);

    const callPayload: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: opts.model,
      messages,
      stream: true,
      ...params,
      ...(tools && tools.length ? { tools } : {}),
      ...(extra.tool_choice ? { tool_choice: extra.tool_choice } : {}),
      ...(extra.max_tokens ? { max_tokens: extra.max_tokens } : {}),
    };

    return client.chat.completions.create(callPayload);
  }
}
