/**
 * Gemini as the model that answers with tools: how a turn's messages and tools become a Gemini request, and how the streamed answer is
 * read back. Kept apart from the gateway so each half can be tested without a network.
 *
 * What differs from the OpenAI and Claude paths:
 *  - the system prompt is a separate `systemInstruction`, not a message;
 *  - the assistant is the `model` role, and a tool call is a `functionCall` part (it has no id of its own, so the gateway makes one);
 *  - every result for one round of tool calls goes back together, in one `user` message of `functionResponse` parts, which are
 *    matched to the calls by name and order, not by id;
 *  - newer Gemini models attach a "thought signature" to a function call that must be sent back with it on the next request,
 *    otherwise the request is refused; it rides on the tool call as `thoughtSignature`.
 */
import type { AgentMessage, AgentToolDefinition } from './model.gateway';

export interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  thoughtSignature?: string;
}

export interface GeminiStreamState {
  content: string;
  toolCalls: GeminiToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finishReason?: string;
  blockReason?: string;
}

export const newGeminiStreamState = (): GeminiStreamState => ({ content: '', toolCalls: [] });

/** A tool's result as Gemini wants it: always an object. */
const responseObject = (content: string | undefined): Record<string, any> => {
  const text = content ?? '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { result: parsed };
  } catch {
    return { result: text };
  }
};

/** The conversation as Gemini `contents`: roles alternate, so neighbours of the same role are joined into one message. */
export function geminiContents(messages: AgentMessage[]): Array<{ role: 'user' | 'model'; parts: any[] }> {
  const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
  const push = (role: 'user' | 'model', parts: any[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool') {
      const name = m.name || nameById.get(m.tool_call_id || '') || 'tool';
      push('user', [{ functionResponse: { name, response: responseObject(m.content) } }]);
    } else if (m.role === 'assistant') {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.tool_calls || []) {
        nameById.set(call.id, call.name);
        const args = typeof (call.arguments as any) === "string" ? safeParse(call.arguments as any) : call.arguments ?? {};
        parts.push({ functionCall: { name: call.name, args }, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) });
      }
      push('model', parts);
    } else {
      // user, and any system message in the middle of the history (the main system prompt is sent separately)
      push('user', [{ text: m.content || '' }]);
    }
  }
  return contents;
}

const safeParse = (text: string): Record<string, any> => {
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
};

/** Thinking is on by default and billed as output. The pack's "none" or "minimal" reasoning effort turns it down where the model allows. */
export function geminiThinkingConfig(model: string, effort?: string): Record<string, unknown> | undefined {
  if (!effort) return undefined;
  const off = effort === 'none' || effort === 'minimal';
  if (/^gemini-2\.5-flash/.test(model)) return off ? { thinkingBudget: 0 } : undefined;
  if (/^gemini-3/.test(model)) {
    const level = off ? 'minimal' : effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined;
    return level ? { thinkingLevel: level } : undefined;
  }
  return undefined;
}

export interface GeminiRoute {
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
}

/** The request body for one round of the agent loop. */
export function buildGeminiAgentBody(req: { systemPrompt?: string; messages: AgentMessage[]; tools?: AgentToolDefinition[] }, route: GeminiRoute): Record<string, any> {
  const generationConfig: Record<string, any> = {};
  if (route.maxOutputTokens) generationConfig.maxOutputTokens = route.maxOutputTokens;
  // Gemini 3 models are tuned for their default temperature; earlier ones take the pack's value.
  if (/^gemini-2\./.test(route.model)) generationConfig.temperature = route.temperature ?? 0.2;
  const thinking = geminiThinkingConfig(route.model, route.reasoningEffort);
  if (thinking) generationConfig.thinkingConfig = thinking;

  const body: Record<string, any> = { contents: geminiContents(req.messages), generationConfig };
  if (req.systemPrompt) body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
  if (req.tools && req.tools.length > 0) {
    body.tools = [{
      functionDeclarations: req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // JSON Schema as written, so free-form objects and the other keywords the tools use are kept as they are.
        ...(Object.keys(tool.parameters?.properties || {}).length > 0 ? { parametersJsonSchema: tool.parameters } : {}),
      })),
    }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return body;
}

/** The address for the streaming call, made from the gateway's usual `:generateContent` address. */
export const geminiStreamEndpoint = (endpoint: string): string => {
  const base = endpoint.split('?')[0].replace(/:(stream)?generateContent$/, '');
  return `${base}:streamGenerateContent?alt=sse`;
};

/** Reads one streamed chunk into the running state; text is passed on as it arrives. */
export function readGeminiChunk(chunk: any, state: GeminiStreamState, onDelta: (text: string) => void): void {
  if (chunk?.promptFeedback?.blockReason) state.blockReason = String(chunk.promptFeedback.blockReason);
  const candidate = chunk?.candidates?.[0];
  if (candidate?.finishReason) state.finishReason = String(candidate.finishReason);
  for (const part of candidate?.content?.parts || []) {
    if (part?.functionCall?.name) {
      state.toolCalls.push({
        id: part.functionCall.id || `call_${state.toolCalls.length}_${Date.now()}`,
        name: part.functionCall.name,
        args: part.functionCall.args && typeof part.functionCall.args === 'object' ? part.functionCall.args : {},
        ...(part.thoughtSignature ? { thoughtSignature: String(part.thoughtSignature) } : {}),
      });
    } else if (typeof part?.text === 'string' && part.text && !part.thought) {
      state.content += part.text;
      onDelta(part.text);
    }
  }
  const meta = chunk?.usageMetadata;
  if (meta) {
    const completion = (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
    state.usage = { promptTokens: meta.promptTokenCount, completionTokens: completion, totalTokens: meta.totalTokenCount ?? (meta.promptTokenCount || 0) + completion };
  }
}
