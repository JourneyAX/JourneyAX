/** Assemble the tenant-neutral platform prompt with the effective Backoffice configuration. */
import { BASE_PROMPT } from './base';
import { BUSINESS_OVERLAY } from './business';
import { TECHNICAL_OVERLAY } from './technical';
import { EffectiveAgentConfig } from '../runtime-config';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Render the existing Back Office Business Profile as instructions instead of
 * exposing its JSON shape to the model. This is intentionally descriptive: it
 * gives each tenant its own language and order context without turning a
 * profile field into executable policy. */
function renderBusinessProfile(business: any): string {
  if (!business || typeof business !== 'object') return '';
  const entity = business.entityModel && typeof business.entityModel === 'object'
    ? business.entityModel
    : null;
  const audience = Array.isArray(business.audience)
    ? business.audience
      .map((item: any) => [text(item?.role), text(item?.buysFor) && `buys for ${text(item.buysFor)}`].filter(Boolean).join(' — '))
      .filter(Boolean)
    : [];
  const lines = [
    text(business.summary),
    text(business.type) && `Business type: ${text(business.type)}.`,
    text(business.sellsTo) && `Serves: ${text(business.sellsTo)}.`,
    audience.length ? `Typical buyers: ${audience.join('; ')}.` : '',
    text(business.orderPattern) && `Order pattern: ${text(business.orderPattern)}.`,
    business.customised === true ? 'This business customises goods per order; only describe configured customisation options and verified product capabilities.' : '',
    business.approvalRequired === true ? 'Customer approval is required before calling a customised order production-ready.' : '',
    Array.isArray(business.regions) && business.regions.length ? `Operating regions: ${business.regions.join(', ')}.` : '',
    entity ? `Every order is for a ${text(entity.label) || 'configured entity'}. ${text(entity.askPrompt) || `Identify the ${text(entity.label) || 'entity'} when it materially affects the recommendation.`}` : '',
    entity?.captureFields?.length ? `Capture, when relevant: ${entity.captureFields.map((field: any) => text(field?.label) || text(field?.key)).filter(Boolean).join(', ')}.` : '',
    entity?.confirmWithCustomer?.length ? `Confirm with the customer; never assert: ${entity.confirmWithCustomer.join(', ')}.` : '',
    entity?.hasDirectory === false ? 'Do not imply that an external directory exists for the configured entity.' : '',
    entity?.allowCreate === true ? 'The customer may provide a new configured entity when it is not already on file.' : '',
  ].filter(Boolean);
  return lines.length ? `[BUSINESS PROFILE]\n${lines.map((line) => `- ${line}`).join('\n')}` : '';
}

function renderPresentationContext(config: EffectiveAgentConfig): string {
  const presentation = config.presentation;
  const labels = presentation.labels || {};
  const fulfilment: any = config.commerce.fulfilment;
  const components: any = config.components;
  const bundles: any[] = Array.isArray(config.multiTradeBundles) ? config.multiTradeBundles : [];
  const discoveryQuestions = Array.isArray(components?.discoveryQuestions)
    ? components.discoveryQuestions
      .map((question: any) => {
        const prompt = text(question?.questions?.[0]);
        const options = Array.isArray(question?.options) ? question.options.filter((option: unknown) => text(option)).join(', ') : '';
        return text(question?.trigger) && prompt
          ? `For “${text(question.trigger)}”, use the configured discovery question: ${prompt}${options ? ` Options: ${options}.` : ''}`
          : '';
      })
      .filter(Boolean)
    : [];
  const lines = [
    labels.items ? `Call recommendations “${labels.items}”${labels.itemsSingular ? ` (singular: “${labels.itemsSingular}”)` : ''}.` : '',
    labels.headerTitle ? `Presentation heading: ${labels.headerTitle}.` : '',
    presentation.quoteIntro ? `Quote introduction: ${presentation.quoteIntro}` : '',
    presentation.complianceBadge ? `Only show this configured compliance label where applicable: ${presentation.complianceBadge}.` : '',
    config.commerce.mode === 'cart' ? 'Use the configured cart language for this business; do not call its cart a quote.' : '',
    config.commerce.mode === 'quote' ? 'Use the configured quote language for this business; do not imply immediate checkout unless the configured commerce flow supports it.' : '',
    fulfilment?.label ? `Fulfilment label: ${fulfilment.label}.` : '',
    fulfilment?.badge ? `Fulfilment promise: ${fulfilment.badge}.` : '',
    Array.isArray(fulfilment?.branches) && fulfilment.branches.length
      ? `Configured fulfilment locations: ${fulfilment.branches.map((branch: any) => text(branch?.name) || text(branch?.id)).filter(Boolean).join(', ')}.`
      : '',
    components?.spacePlanner?.enabled === true
      ? `Configured planning spaces: ${(components.spacePlanner.roomTypes || []).join(', ') || text(components.spacePlanner.defaultRoom) || 'the tenant-defined space'}.`
      : '',
    ...discoveryQuestions,
    ...bundles.map((bundle: any) => {
      const trades = Array.isArray(bundle?.trades)
        ? bundle.trades.map((trade: any) => text(trade?.tradeName)).filter(Boolean).join(', ')
        : '';
      return text(bundle?.name)
        ? `Configured solution bundle: ${text(bundle.name)}${text(bundle.description) ? ` — ${text(bundle.description)}` : ''}${trades ? ` (includes: ${trades})` : ''}. Use it only when it matches the customer’s goal and verified catalogue facts.`
        : '';
    }),
  ].filter(Boolean);
  return lines.length ? `[CONFIGURED PRESENTATION AND COMMERCE]\n${lines.map((line) => `- ${line}`).join('\n')}` : '';
}

function renderJourneyGraph(persona: EffectiveAgentConfig['persona']): string {
  const nodes = persona.journeyGraph?.nodes;
  if (!Array.isArray(nodes) || !nodes.length) return '';
  const stages = nodes
    .map((node: any) => text(node?.label) || text(node?.name) || text(node?.data?.label) || text(node?.id))
    .filter(Boolean);
  return stages.length ? `[CONFIGURED JOURNEY GRAPH]\n- Available journey stages: ${stages.join(' → ')}. Follow the configured journey guidance and active rules; do not invent a tenant-specific flow.` : '';
}

function renderEffectiveAgentConfigContext(config: EffectiveAgentConfig): string {
  const tenant = config.tenant;
  const persona = config.persona;
  const identity = [
    `[BUSINESS IDENTITY — active configuration for ${tenant.companyName || tenant.name || tenant.projectId}]`,
    tenant.companyName || tenant.name ? `Name: ${tenant.companyName || tenant.name}.` : '',
    persona.systemName ? `Assistant role: ${persona.systemName}.` : '',
  ].filter(Boolean).join('\n');
  const scope = [
    ...(config.scope.rooms?.length ? [`Served spaces: ${config.scope.rooms.join(', ')}`] : []),
    ...(config.scope.categories?.length ? [`Served categories: ${config.scope.categories.join(', ')}`] : []),
  ];
  const dimensions = config.scope.dimensions.main.length
    ? `[CONFIGURED CONTEXT DIMENSIONS]\n${config.scope.dimensions.main.map((dimension) => {
        const values = dimension.values.map((value) => typeof value === 'string' ? value : value.name).filter(Boolean);
        return `- ${dimension.name} (${dimension.id}): ${dimension.description}${dimension.clarificationQuestion ? ` Suggested question: ${dimension.clarificationQuestion}` : ''}${values.length ? ` Options: ${values.join(', ')}.` : ''}`;
      }).join('\n')}`
    : '';
  const intents = config.intents.main.length
    ? `[CONFIGURED CUSTOMER NEEDS]\n${config.intents.main.map((intent) => `- ${intent.name}: ${intent.description}`).join('\n')}`
    : '';
  const vocabulary = config.behavior.vocabulary;
  const vocabularyLines = [
    vocabulary.concepts && Object.entries(vocabulary.concepts).map(([term, meaning]) => `${term}: ${meaning}`).join('; '),
    vocabulary.jargon && Object.entries(vocabulary.jargon).map(([term, meaning]) => `${term}: ${meaning}`).join('; '),
    vocabulary.glossary && Object.entries(vocabulary.glossary).map(([term, meaning]) => `${term}: ${meaning}`).join('; '),
  ].filter(Boolean);
  const journey = config.journeys.default;
  const journeyContext = journey
    ? `[JOURNEY CONTEXT]\n${journey.description}\n${journey.steps.map((step) => [step.title || step.name || step.id, step.description, step.systemPrompt || step.action].filter(Boolean).join(': ')).map((line) => `- ${line}`).join('\n')}`
    : '';
  const ruleLines = [
    ...config.rules.business.map((rule) =>
      `[${rule.scope || 'general'}] When ${rule.condition || 'applicable'} → ${rule.action || rule.description || 'follow the configured rule.'}`,
    ),
    config.rules.constraints.canQuotePrices === false ? 'Do not provide prices or quotes.' : '',
    config.rules.constraints.canPlaceOrders === false ? 'Do not place orders.' : '',
    ...(config.rules.constraints.restrictedTerms || []).map((term) => `Avoid this term: ${term}.`),
  ].filter(Boolean);
  const rules = ruleLines.length
    ? `[BUSINESS RULES]\n${ruleLines.map((line) => `- ${line}`).join('\n')}`
    : '';
  const presentation = config.presentation.productPresentation;
  const presentationLines = [
    presentation.enabled && presentation.useStructuredCards ? 'Use the configured structured presentation surface.' : '',
    presentation.requireVerifiedInformation ? 'Only present verified information.' : '',
    presentation.requireIdentifier ? 'Only present items with verified identifiers.' : '',
    presentation.requirePrice ? 'Only present purchasable items with verified prices.' : '',
    presentation.preserveRetrievedValues ? 'Preserve retrieved values exactly.' : '',
    presentation.avoidRepeatingVisibleDetails ? 'Do not repeat details already visible on cards.' : '',
  ].filter(Boolean);
  const retrieval = config.retrieval;
  const retrievalLines = [
    retrieval.queryWordRange ? `Use focused queries of ${retrieval.queryWordRange.min}–${retrieval.queryWordRange.max} words.` : '',
    retrieval.maxSearchCallsPerTurn ? `Make no more than ${retrieval.maxSearchCallsPerTurn} retrieval calls per turn.` : '',
    retrieval.skipDuringDiscovery ? 'Avoid retrieval during pure discovery.' : '',
  ].filter(Boolean);
  const runtime = config.runtimeContext;
  return [
    identity,
    scope.length ? `[CONFIGURED BUSINESS SCOPE]\n${scope.join('. ')}` : '',
    renderBusinessProfile(config.scope.business),
    dimensions,
    intents,
    vocabularyLines.length ? `[CONFIGURED TERMINOLOGY]\n${vocabularyLines.join('\n')}` : '',
    journeyContext,
    renderJourneyGraph(persona),
    rules,
    renderPresentationContext(config),
    presentationLines.length ? `[PRESENTATION GUIDANCE]\n${presentationLines.map((line) => `- ${line}`).join('\n')}` : '',
    retrievalLines.length ? `[RETRIEVAL GUIDANCE]\n${retrievalLines.map((line) => `- ${line}`).join('\n')}` : '',
    runtime?.persona ? `[PROJECT PERSONA]\n${runtime.persona}` : '',
    runtime?.journeyGuidance ? `[JOURNEY GOALS]\n${runtime.journeyGuidance}` : '',
    runtime?.genericBusinessBehavior || '',
  ].filter(Boolean).join('\n\n');
}

export function assembleSystemPrompt(mode: 'business' | 'technical', stage: string, config?: EffectiveAgentConfig): string {
  const modeOverlay = mode === 'technical' ? TECHNICAL_OVERLAY : BUSINESS_OVERLAY;
  const stageDefinition = config?.stages.main.find((item) => item.name === stage || item.id === stage);
  const businessContext = config ? renderEffectiveAgentConfigContext(config) : '';
  return [BASE_PROMPT, businessContext, modeOverlay, stageDefinition?.systemPromptOverlay || ''].filter(Boolean).join('\n\n');
}

export { BASE_PROMPT };
