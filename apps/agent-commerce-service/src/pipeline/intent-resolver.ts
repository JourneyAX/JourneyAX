/**
 * Step 1 — classify the customer's latest message before the main response call.
 * The allowed intents, stages, and dimensions come from the active tenant
 * configuration (or the generic platform defaults); this module owns classification.
 */
import OpenAI from 'openai';
import { ConversationMode, IntentResult } from './types';
import { EffectiveAgentConfig, AgentContextDimension } from '../runtime-config';
import { PLATFORM_DEFAULT_AGENT_CONFIG } from '../runtime-config/defaults-platform';

interface DimensionSpec {
  key: string;
  label?: string;
  values?: string[];
  description?: string;
  scoping?: boolean;
}

const DEFAULT_RETRIEVAL_TYPES = [
  'product', 'design', 'collection', 'troubleshooting', 'installation', 'faq', 'sizing', 'general', 'none',
];

function packDimensionSpecs(pack: EffectiveAgentConfig): DimensionSpec[] {
  return pack.scope.dimensions.main.map((dimension: AgentContextDimension) => ({
    key: dimension.id,
    label: dimension.name,
    values: dimension.values?.map((value) => typeof value === 'string' ? value : value.id),
    description: dimension.description,
    scoping: Boolean(dimension.scoping),
  }));
}

function buildIntentSystem(pack?: EffectiveAgentConfig, configuredDimensions?: DimensionSpec[]): string {
  const activePack = pack || PLATFORM_DEFAULT_AGENT_CONFIG;
  const dimensions = configuredDimensions?.length ? configuredDimensions : packDimensionSpecs(activePack);
  const intentLines = activePack.intents.main
    .map((intent) => `- ${intent.name}: ${intent.description}`)
    .join('\n');
  const exampleLines = activePack.intents.main
    .flatMap((intent) => (intent.examples || []).slice(0, 2).map((example) => `- ${intent.name}: “${example}”`))
    .join('\n');
  const stages = activePack.stages.main.map((stage) => stage.name);
  const retrievalTypes = activePack.retrieval?.types?.length
    ? activePack.retrieval.types
    : DEFAULT_RETRIEVAL_TYPES;
  const dimensionLines = dimensions.length
    ? dimensions.map((dimension) => {
        const allowed = dimension.values?.length
          ? `Allowed values: [${dimension.values.join(', ')}].`
          : 'Free text.';
        const scope = dimension.scoping && dimension.values?.length
          ? ' Values outside this list may be outside the business scope.'
          : '';
        return `- ${dimension.key}${dimension.label ? ` (${dimension.label})` : ''}: ${dimension.description || ''} ${allowed}${scope}`;
      }).join('\n')
    : '- No extra context dimensions are configured.';

  return `You classify the customer's latest message for a conversational commerce or service assistant.
Read the recent conversation so you understand what has already happened. Return ONLY one JSON object.

Configured intents:
${intentLines}
${exampleLines ? `\nExamples from this business:\n${exampleLines}` : ''}

Return these fields:
{
  "intent": one configured intent name,
  "dimensions": an object containing only configured dimension keys and values confidently found in the conversation,
  "inScope": false only when a configured scoping rule clearly excludes the request; otherwise true,
  "stage": one of [${(stages.length ? stages : ['intro']).map((stage) => JSON.stringify(stage)).join(', ')}],
  "mode": "business" for planning or selection, or "technical" for technical support,
  "needsRetrieval": whether verified information should be retrieved this turn,
  "retrievalType": one of [${retrievalTypes.map((type) => JSON.stringify(type)).join(', ')}],
  "panelRenderBlocked": true only when the customer explicitly asks not to show structured results this turn,
  "confidence": a number from 0 to 1,
  "missingInfo": an array of useful context still missing,
  "organization": an object with name and optional location when a named organization is relevant, otherwise null
}

Configured context dimensions:
${dimensionLines}

Use the conversation and active stage to understand progress. Do not repeat completed questions. If the customer has supplied enough information or asks for a specific item or answer, advance to the most relevant configured stage and retrieve verified information when needed. If key context is missing, ask only for details needed to help. Do not invent unsupported intents, stages, or dimension values. Return valid JSON only.`;
}

export class IntentResolver {
  constructor(private readonly openai: OpenAI, private readonly model: string) {}

  async resolve(
    messages: any[],
    state?: { phase?: string },
    modelOverride?: string,
    dimensions?: DimensionSpec[],
    /** A project's own client (self-hosted / other provider). */
    client?: OpenAI,
    /** Tenant configuration for intent, stage, retrieval, and context definitions. */
    pack?: EffectiveAgentConfig,
  ): Promise<IntentResult> {
    const model = modelOverride || this.model;
    const llm = client || this.openai;
    const activePack = pack || PLATFORM_DEFAULT_AGENT_CONFIG;
    const packDimensions = packDimensionSpecs(activePack);
    const configuredDimensions = dimensions || [];
    const overriddenKeys = new Set(configuredDimensions.map((dimension) => dimension.key));
    const dimensionSpecs = [
      ...packDimensions.filter((dimension) => !overriddenKeys.has(dimension.key)),
      ...configuredDimensions,
    ];
    const stageNames = new Set(activePack.stages.main.map((stage) => stage.name));
    const intentNames = new Set(activePack.intents.main.map((intent) => intent.name));
    const retrievalTypes = new Set(activePack.retrieval?.types?.length
      ? activePack.retrieval.types
      : DEFAULT_RETRIEVAL_TYPES);
    const fallbackStage = state?.phase && stageNames.has(state.phase)
      ? state.phase
      : activePack.journeys.default.startStage || activePack.stages.main[0]?.name || 'intro';
    const fallbackIntent = activePack.intents.unknown?.name || 'unknown';
    const fallback: IntentResult = {
      intent: fallbackIntent,
      dimensions: {},
      inScope: true,
      space: 'general',
      stage: fallbackStage,
      mode: 'business',
      needsRetrieval: true,
      retrievalType: retrievalTypes.has('product') ? 'product' : 'none',
      confidence: 0,
      missingInfo: [],
    };

    try {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const lastText = typeof lastUser?.content === 'string' ? lastUser.content : '';
      if (!lastText) return fallback;

      const recent = messages
        .slice(-6)
        .map((message) => `${message.role === 'user' ? 'Customer' : 'Assistant'}: ${typeof message.content === 'string' ? message.content : '[structured message]'}`)
        .join('\n');
      const strictJson = !client;
      const isReasoning = /^(gpt-5|o[134])/.test(model);
      const systemPrompt = buildIntentSystem(activePack, dimensionSpecs);

      const response = await llm.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt + (strictJson ? '' : '\n\nReply with ONE JSON object and nothing else — no prose, no code fence.') },
          { role: 'user', content: `Current stage: ${state?.phase || fallbackStage}\n\nRecent conversation:\n${recent}\n\nClassify the customer's LATEST message in the context of this conversation.` },
        ],
        ...(strictJson ? { response_format: { type: 'json_object' as const } } : { max_tokens: 400 }),
        ...(isReasoning ? {} : { temperature: 0 }),
      });

      const raw = String(response.choices[0].message.content || '{}');
      const firstObject = raw.indexOf('{');
      const lastObject = raw.lastIndexOf('}');
      const parsed = JSON.parse(firstObject >= 0 && lastObject > firstObject
        ? raw.slice(firstObject, lastObject + 1)
        : raw);

      const allowedDimensions = new Map(dimensionSpecs.map((dimension) => [dimension.key, dimension]));
      const extractedDimensions: Record<string, string> = {};
      if (parsed.dimensions && typeof parsed.dimensions === 'object') {
        for (const [key, rawValue] of Object.entries(parsed.dimensions)) {
          if (rawValue == null || !String(rawValue).trim() || String(rawValue).toLowerCase() === 'unknown') continue;
          const spec = allowedDimensions.get(key);
          if (!spec) continue;
          const value = String(rawValue).trim();
          if (spec.values?.length) {
            const canonical = spec.values.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
            if (!canonical) continue;
            extractedDimensions[key] = canonical;
          } else {
            extractedDimensions[key] = value;
          }
        }
      }

      const parsedIntent = String(parsed.intent || fallbackIntent);
      const parsedStage = String(parsed.stage || fallbackStage);
      const parsedRetrievalType = String(parsed.retrievalType || 'none');
      const inScope = !dimensionSpecs.some((dimension) => dimension.scoping)
        ? true
        : parsed.inScope !== false;
      return {
        intent: intentNames.has(parsedIntent) ? parsedIntent : fallbackIntent,
        dimensions: extractedDimensions,
        inScope,
        space: extractedDimensions.space || (inScope ? 'general' : 'out_of_scope'),
        stage: stageNames.has(parsedStage) ? parsedStage : fallbackStage,
        mode: (parsed.mode === 'technical' ? 'technical' : 'business') as ConversationMode,
        needsRetrieval: Boolean(parsed.needsRetrieval),
        retrievalType: retrievalTypes.has(parsedRetrievalType) ? parsedRetrievalType : 'none',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        missingInfo: Array.isArray(parsed.missingInfo) ? parsed.missingInfo.map(String) : [],
        organization: parsed.organization && typeof parsed.organization === 'object' && parsed.organization.name
          ? { name: String(parsed.organization.name), location: parsed.organization.location ? String(parsed.organization.location) : undefined }
          : undefined,
        panelRenderBlocked: Boolean(parsed.panelRenderBlocked),
      };
    } catch (err) {
      console.warn('[IntentResolver] classification failed, using safe default:', (err as Error).message);
      return fallback;
    }
  }
}
