/** Tenant-neutral fallback. Published Backoffice values override these fields. */
import type { EffectiveAgentConfig } from './schema/agent-config';

export const PLATFORM_DEFAULT_AGENT_CONFIG: EffectiveAgentConfig = {
  tenant: { projectId: 'default', name: 'Platform Default', source: 'platform-default' },
  ai: { provider: 'openai', model: 'gpt-4o-mini', intentModel: 'gpt-4o-mini', temperature: 0.7 },
  persona: { systemName: 'Product and Service Advisor' },
  scope: { dimensions: { main: [] } },
  behavior: {
    personaBehavior: { tone: 'clear, helpful, and concise', expertise: 'general commerce assistance', supportiveMessage: 'Help the customer make an informed decision.' },
    conversationExperience: { reclassifyGoalEachTurn: true, preserveLatestCustomerGoal: true, clarifyOnlyMissingContext: true, avoidRepeatingCompletedQuestions: true },
    terminology: { genericConceptDefinitions: true, explainUnknownTerms: true, neverInferTenantTerms: true },
    vocabulary: {},
    conversationPolicy: { reclassifyGoalEachTurn: true, preserveLatestCustomerGoal: true, intentPrecedence: ['support', 'quote_or_order', 'recommendation', 'product_question', 'general_question'] },
    recommendationPolicy: { requireVerifiedMatch: true, explainWhyItMatches: true, distinguishAlternativesFromComplements: true, neverInventRelationships: true },
    supportPolicy: { answerFromConfiguredSources: true, discloseMissingCoverage: true, handoffWhenActionUnavailable: true },
    retrievalPolicy: { focusedQueries: true, maxSearchCallsPerTurn: 3, skipDuringDiscovery: true },
    presentationPolicy: { preserveRetrievedValues: true, doNotInventIdentifiers: true, doNotInventPrices: true, useConfiguredPresentationSurface: true },
    organizationResearch: { enabled: false, confirmDetailsBeforeUsing: true },
  },
  capabilities: { enabled: [] },
  skills: [],
  commerce: { mode: 'disabled', canQuotePrices: false, canPlaceOrders: false },
  integrations: {},
  presentation: { productPresentation: { enabled: true, useStructuredCards: true, requireVerifiedInformation: true, avoidRepeatingVisibleDetails: true, requireIdentifier: true, requirePrice: true, preserveRetrievedValues: true, useConfiguredPresentationSurface: true } },
  intents: { main: [
    { id: 'product_question', name: 'product_question', description: 'The customer asks about a configured product or service.', examples: [], priority: 70 },
    { id: 'recommendation', name: 'recommendation', description: 'The customer wants a suitable option for a stated goal.', examples: [], priority: 80 },
    { id: 'quote_or_order', name: 'quote_or_order', description: 'The customer wants pricing, a quote, or to order.', examples: [], priority: 90 },
    { id: 'support', name: 'support', description: 'The customer needs help using, installing, or troubleshooting an offering.', examples: [], priority: 75 },
    { id: 'general_question', name: 'general_question', description: 'The customer asks a general business question.', examples: [], priority: 50 },
    { id: 'unknown', name: 'unknown', description: 'The customer goal is unclear.', examples: [], priority: 0 },
  ], unknown: { name: 'unknown' } },
  journeys: { default: { id: 'standard', name: 'Standard customer journey', description: 'Understand the goal, collect missing context, recommend verified options, then close or hand off.', startStage: 'intro', stageSequence: ['intro', 'clarify', 'products', 'quote', 'support'], dimensionsToCollect: [], steps: [
    { id: 'understand_goal', name: 'Understand goal', stageName: 'intro', action: 'understand_customer_goal' },
    { id: 'collect_context', name: 'Collect context', stageName: 'clarify', action: 'ask_only_for_missing_context' },
    { id: 'recommend', name: 'Recommend', stageName: 'products', action: 'search_and_present_verified_options' },
    { id: 'close', name: 'Close', stageName: 'quote', action: 'use_configured_quote_or_cart_flow' },
  ] } },
  stages: { main: [
    { id: 'stage_intro', name: 'intro', sequence: 1, description: 'Understand the customer goal.', systemPromptOverlay: 'Understand the customer goal before taking action.', availableTools: ['setPhase'], nextStage: 'clarify' },
    { id: 'stage_clarify', name: 'clarify', sequence: 2, description: 'Collect only useful missing context.', systemPromptOverlay: 'Ask only questions that materially improve the next step.', availableTools: ['searchKnowledge', 'setPhase'], nextStage: 'products' },
    { id: 'stage_products', name: 'products', sequence: 3, description: 'Present verified configured offerings.', systemPromptOverlay: 'Use configured knowledge and preserve retrieved facts.', availableTools: ['searchKnowledge', 'showItems', 'setPhase'], nextStage: 'quote', canShowItems: true },
    { id: 'stage_quote', name: 'quote', sequence: 4, description: 'Use the project commerce mode to close.', systemPromptOverlay: 'Quote or add to cart only when project configuration and verified data allow it.', availableTools: ['updateQuote', 'setPhase'], nextStage: 'support', canQuote: true },
    { id: 'stage_support', name: 'support', sequence: 5, description: 'Answer from configured sources or hand off.', systemPromptOverlay: 'Disclose missing coverage and offer a handoff when needed.', availableTools: ['searchKnowledge', 'showGuide', 'setPhase'] },
  ] },
  rules: { business: [], constraints: { canQuotePrices: false, canPlaceOrders: false }, communication: {} },
  retrieval: { enabled: true, strategy: 'hybrid', collectionName: '', topK: 8, minScore: 0.25, systemPrompt: 'Retrieve verified information from the project\'s configured knowledge sources.', types: ['product', 'service', 'design', 'installation', 'faq', 'general', 'none'], maxSearchCallsPerTurn: 3, skipDuringDiscovery: true },
};
