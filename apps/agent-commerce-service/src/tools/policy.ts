import type OpenAI from 'openai';

import type { ToolsetRequest } from './contracts';
import { ALL_TOOL_DEFINITIONS } from './tenant-tools';
import { CAPABILITY_TO_TOOL, UNIVERSAL_TOOL_NAMES } from './registry';

export { AVAILABLE_CAPABILITIES } from './registry';

/**
 * Assemble the model-visible toolset from Back Office capabilities.
 * Empty capability configuration retains the existing all-tools fallback.
 */
export function buildToolset({
  enabledCapabilities,
  entityModel,
  closing = 'quote',
}: ToolsetRequest = {}): OpenAI.ChatCompletionTool[] {
  const allow = new Set(UNIVERSAL_TOOL_NAMES);
  if (closing === 'bag') allow.add('updateQuote');
  if (enabledCapabilities?.length) {
    for (const capability of enabledCapabilities) {
      const mapped = CAPABILITY_TO_TOOL[capability];
      if (Array.isArray(mapped)) mapped.forEach((name) => allow.add(name));
      else if (mapped) allow.add(mapped);
    }
  }
  const picked = enabledCapabilities?.length
    ? ALL_TOOL_DEFINITIONS.filter((tool) => tool.type !== 'function' || allow.has(tool.function.name))
    : ALL_TOOL_DEFINITIONS;

  const label = entityModel?.label || 'organisation';
  const plural = entityModel?.labelPlural || `${label}s`;
  return picked.map((tool) => {
    if (tool.type !== 'function') return tool;
    if (closing === 'bag' && tool.function.name === 'updateQuote') {
      const parameters: any = JSON.parse(JSON.stringify(tool.function.parameters || {}));
      parameters.properties = {
        items: parameters.properties?.items,
        remove: { type: 'array', items: { type: 'string' }, description: 'SKUs to take OUT of the bag' },
      };
      parameters.properties.items.description = 'Items to put in the bag (or whose quantity to set). Only what the customer asked for this turn — the bag keeps everything else.';
      parameters.required = [];
      return {
        ...tool,
        function: {
          ...tool.function,
          parameters,
          description: 'Change the customer\'s BAG: `items` puts items in (or sets their quantity), `remove` takes SKUs out; everything else in the bag stays. Pass ONLY real SKUs the customer has seen or asked for — resolve a name to the code from the cards on screen. The server prices it, checks stock and limits, and shows the bag card. Call it whenever the customer says add / put in my bag / I\'ll take that / remove / change quantity. Never for an assessment.',
        },
      };
    }
    const raw = JSON.stringify(tool.function);
    if (!raw.includes('{ENTITY')) return tool;
    return { ...tool, function: JSON.parse(raw.split('{ENTITY_PLURAL}').join(plural).split('{ENTITY}').join(label)) };
  });
}
