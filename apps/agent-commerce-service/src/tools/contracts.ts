import type OpenAI from 'openai';

/** Model-visible function tools used by the commerce agent. */
export type CommerceToolDefinition = OpenAI.ChatCompletionTool;
export type CommerceFunctionTool = OpenAI.ChatCompletionFunctionTool;

/** The Back Office inputs that determine the model's permitted toolset. */
export interface ToolsetRequest {
  enabledCapabilities?: string[];
  entityModel?: { label?: string; labelPlural?: string };
  closing?: 'bag' | 'quote';
}
