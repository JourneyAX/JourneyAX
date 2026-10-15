import { Injectable, Optional } from '@nestjs/common';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
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

export function isAnthropicProvider(opts: ModelCallOptions): boolean {
  if (opts.provider === 'anthropic') return true;
  if (opts.model && opts.model.toLowerCase().includes('claude')) return true;
  if (process.env.DEFAULT_AI_PROVIDER === 'anthropic') return true;
  return false;
}

export function normalizeAnthropicModel(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return 'claude-haiku-4-5';
  if (m.includes('sonnet')) return 'claude-sonnet-4-5';
  if (m.includes('claude')) return model;
  return 'claude-haiku-4-5';
}

function convertOpenAIToAnthropic(
  messages: OpenAI.ChatCompletionMessageParam[],
  tools?: OpenAI.ChatCompletionTool[]
): {
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
} {
  let system = '';
  const anthropicMessages: Anthropic.MessageParam[] = [];

  function addMessage(role: 'user' | 'assistant', contentBlocks: any[]) {
    if (contentBlocks.length === 0) return;
    if (anthropicMessages.length > 0) {
      const lastMsg = anthropicMessages[anthropicMessages.length - 1];
      if (lastMsg.role === role) {
        const prevBlocks = Array.isArray(lastMsg.content)
          ? (lastMsg.content as any[])
          : [{ type: 'text', text: typeof lastMsg.content === 'string' ? lastMsg.content : '' }];
        lastMsg.content = [...prevBlocks, ...contentBlocks];
        return;
      }
    }
    anthropicMessages.push({ role, content: contentBlocks });
  }

  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content.trim() : '';
      if (text) {
        system = system ? `${system}\n\n${text}` : text;
      }
    } else if (m.role === 'user') {
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      const text = raw.trim() || 'Please continue.';
      addMessage('user', [{ type: 'text', text }]);
    } else if (m.role === 'assistant') {
      const contentBlocks: any[] = [];
      const rawText = typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : '');
      const trimmed = rawText.trim();
      if (trimmed) {
        contentBlocks.push({
          type: 'text',
          text: trimmed,
        });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = (tc as any).function;
          let input = {};
          try {
            input =
              typeof fn?.arguments === 'string'
                ? JSON.parse(fn.arguments)
                : fn?.arguments || {};
          } catch {
            input = {};
          }
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: fn?.name || 'search',
            input,
          });
        }
      }
      if (contentBlocks.length === 0) {
        contentBlocks.push({ type: 'text', text: 'Continuing with request.' });
      }
      addMessage('assistant', contentBlocks);
    } else if (m.role === 'tool') {
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '{}');
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: raw || '{}',
      };
      addMessage('user', [block]);
    }
  }

  if (anthropicMessages.length === 0) {
    anthropicMessages.push({ role: 'user', content: 'Hello' });
  } else if (anthropicMessages[0].role === 'assistant') {
    anthropicMessages.unshift({ role: 'user', content: 'Hello' });
  }

  const anthropicTools = (tools || []).map((t: any) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    };
  });

  return {
    system: system || undefined,
    messages: anthropicMessages,
    tools: anthropicTools.length > 0 ? (anthropicTools as Anthropic.Tool[]) : undefined,
  };
}

async function* streamAnthropicToOpenAI(
  stream: AsyncIterable<Anthropic.MessageStreamEvent>,
  model: string
): AsyncIterable<OpenAI.ChatCompletionChunk> {
  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'tool_use') {
        yield {
          id: `chunk_${Date.now()}`,
          created: Math.floor(Date.now() / 1000),
          model,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: event.index,
                    id: event.content_block.id,
                    type: 'function',
                    function: {
                      name: event.content_block.name,
                      arguments: '',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        } as any;
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') {
        yield {
          id: `chunk_${Date.now()}`,
          created: Math.floor(Date.now() / 1000),
          model,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                content: event.delta.text,
              },
              finish_reason: null,
            },
          ],
        } as any;
      } else if (event.delta?.type === 'input_json_delta') {
        yield {
          id: `chunk_${Date.now()}`,
          created: Math.floor(Date.now() / 1000),
          model,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: event.index,
                    function: {
                      arguments: event.delta.partial_json,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        } as any;
      }
    } else if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) {
        const finish_reason =
          event.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop';
        yield {
          id: `chunk_${Date.now()}`,
          created: Math.floor(Date.now() / 1000),
          model,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason,
            },
          ],
        } as any;
      }
    }
  }
}

/**
 * ModelRouter: Responsible for routing LLM completions and streams
 * via the configured provider client (OpenAI or Anthropic Claude).
 */
@Injectable()
export class ModelRouter {
  private defaultClient?: OpenAI;
  private anthropicClients = new Map<string, Anthropic>();

  constructor(@Optional() defaultClient?: OpenAI) {
    this.defaultClient = defaultClient;
  }

  getAnthropicClient(apiKey?: string): Anthropic {
    const isAntKey = apiKey && (apiKey.startsWith('sk-ant-') || !apiKey.startsWith('sk-proj-'));
    const key = (isAntKey ? apiKey : '') || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
    if (!key) {
      throw new Error('ModelRouter: No Anthropic/Claude API key configured in ANTHROPIC_API_KEY or CLAUDE_API_KEY.');
    }
    let client = this.anthropicClients.get(key);
    if (!client) {
      client = new Anthropic({ apiKey: key });
      this.anthropicClients.set(key, client);
    }
    return client;
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
    if (isAnthropicProvider(opts)) {
      const anthropic = this.getAnthropicClient(opts.apiKey);
      const model = normalizeAnthropicModel(opts.model);
      const { system, messages: anthropicMessages, tools: anthropicTools } = convertOpenAIToAnthropic(
        messages,
        tools
      );

      const res = await anthropic.messages.create({
        model,
        max_tokens: extra.max_tokens || 2048,
        system,
        messages: anthropicMessages,
        tools: anthropicTools,
        ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
      });

      let content = '';
      const toolCalls: any[] = [];
      for (const block of res.content) {
        if (block.type === 'text') content += block.text;
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      return {
        id: res.id,
        created: Math.floor(Date.now() / 1000),
        model: res.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: content || null,
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: res.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
          },
        ],
      } as any;
    }

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
    if (isAnthropicProvider(opts)) {
      const anthropic = this.getAnthropicClient(opts.apiKey);
      const model = normalizeAnthropicModel(opts.model);
      const { system, messages: anthropicMessages, tools: anthropicTools } = convertOpenAIToAnthropic(
        messages,
        tools
      );

      const stream = await anthropic.messages.create({
        model,
        max_tokens: extra.max_tokens || 2048,
        system,
        messages: anthropicMessages,
        tools: anthropicTools,
        stream: true,
        ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
      });

      return streamAnthropicToOpenAI(stream, model);
    }

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
