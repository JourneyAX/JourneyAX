/** Temporary migration defaults for behavior fields that are not yet exposed
 * in Backoffice. Tenant values will override these and this file is removed
 * once agentBehavior is fully managed by Backoffice. */
export interface GenericBusinessConfig {
  /** Temporary universal persona fallback; move to Backoffice when exposed there. */
  personaBehavior: {
    tone: string;
    expertise: string;
    supportiveMessage: string;
  };
  /** Temporary universal conversation rules; move to Backoffice when exposed there. */
  conversationExperience: {
    reclassifyGoalEachTurn: boolean;
    preserveLatestCustomerGoal: boolean;
    clarifyOnlyMissingContext: boolean;
    avoidRepeatingCompletedQuestions: boolean;
  };
  terminology: {
    genericConceptDefinitions: boolean;
    explainUnknownTerms: boolean;
    neverInferTenantTerms: boolean;
  };
  conversationPolicy: {
    reclassifyGoalEachTurn: boolean;
    preserveLatestCustomerGoal: boolean;
    intentPrecedence: string[];
  };
  recommendationPolicy: {
    requireVerifiedMatch: boolean;
    explainWhyItMatches: boolean;
    distinguishAlternativesFromComplements: boolean;
    neverInventRelationships: boolean;
  };
  supportPolicy: {
    answerFromConfiguredSources: boolean;
    discloseMissingCoverage: boolean;
    handoffWhenActionUnavailable: boolean;
  };
  retrievalPolicy: {
    focusedQueries: boolean;
    maxSearchCallsPerTurn: number;
    skipDuringDiscovery: boolean;
  };
  presentationPolicy: {
    preserveRetrievedValues: boolean;
    doNotInventIdentifiers: boolean;
    doNotInventPrices: boolean;
    useConfiguredPresentationSurface: boolean;
  };
  /** Reserved for a future Backoffice-controlled research workflow. Disabled by default. */
  organizationResearch: {
    enabled: boolean;
    confirmDetailsBeforeUsing: boolean;
  };
}

export const GENERIC_BUSINESS_CONFIG: GenericBusinessConfig = {
  personaBehavior: {
    tone: 'clear, helpful, and concise',
    expertise: 'general commerce assistance',
    supportiveMessage: 'Help the customer make an informed decision.',
  },
  conversationExperience: {
    reclassifyGoalEachTurn: true,
    preserveLatestCustomerGoal: true,
    clarifyOnlyMissingContext: true,
    avoidRepeatingCompletedQuestions: true,
  },
  terminology: { genericConceptDefinitions: true, explainUnknownTerms: true, neverInferTenantTerms: true },
  conversationPolicy: {
    reclassifyGoalEachTurn: true,
    preserveLatestCustomerGoal: true,
    intentPrecedence: ['support', 'quote_or_order', 'recommendation', 'product_question', 'general_question'],
  },
  recommendationPolicy: {
    requireVerifiedMatch: true,
    explainWhyItMatches: true,
    distinguishAlternativesFromComplements: true,
    neverInventRelationships: true,
  },
  supportPolicy: { answerFromConfiguredSources: true, discloseMissingCoverage: true, handoffWhenActionUnavailable: true },
  retrievalPolicy: {
    focusedQueries: true,
    maxSearchCallsPerTurn: 3,
    skipDuringDiscovery: true,
  },
  presentationPolicy: { preserveRetrievedValues: true, doNotInventIdentifiers: true, doNotInventPrices: true, useConfiguredPresentationSurface: true },
  organizationResearch: { enabled: false, confirmDetailsBeforeUsing: true },
};

export function mergeGenericBusinessConfig(override?: any): GenericBusinessConfig {
  return {
    personaBehavior: { ...GENERIC_BUSINESS_CONFIG.personaBehavior, ...(override?.personaBehavior || {}) },
    conversationExperience: { ...GENERIC_BUSINESS_CONFIG.conversationExperience, ...(override?.conversationExperience || {}) },
    terminology: { ...GENERIC_BUSINESS_CONFIG.terminology, ...(override?.terminology || {}) },
    conversationPolicy: { ...GENERIC_BUSINESS_CONFIG.conversationPolicy, ...(override?.conversationPolicy || {}) },
    recommendationPolicy: { ...GENERIC_BUSINESS_CONFIG.recommendationPolicy, ...(override?.recommendationPolicy || {}) },
    supportPolicy: { ...GENERIC_BUSINESS_CONFIG.supportPolicy, ...(override?.supportPolicy || {}) },
    retrievalPolicy: { ...GENERIC_BUSINESS_CONFIG.retrievalPolicy, ...(override?.retrievalPolicy || {}) },
    presentationPolicy: { ...GENERIC_BUSINESS_CONFIG.presentationPolicy, ...(override?.presentationPolicy || {}) },
    organizationResearch: { ...GENERIC_BUSINESS_CONFIG.organizationResearch, ...(override?.organizationResearch || {}) },
  };
}

export function renderGenericBusinessConfig(config: GenericBusinessConfig): string {
  const lines = [
    `Use a ${config.personaBehavior.tone} tone and provide ${config.personaBehavior.expertise}.`,
    config.personaBehavior.supportiveMessage,
    config.terminology.genericConceptDefinitions ? 'Define generic concepts when useful.' : '',
    config.terminology.explainUnknownTerms ? 'Explain unknown terms instead of guessing.' : '',
    config.terminology.neverInferTenantTerms ? 'Never infer tenant-specific terminology without evidence.' : '',
    config.recommendationPolicy.requireVerifiedMatch ? 'Recommend only verified matches.' : '',
    config.conversationPolicy.reclassifyGoalEachTurn ? 'Reassess the customer goal on every turn.' : '',
    config.conversationPolicy.preserveLatestCustomerGoal ? 'Preserve the latest stated customer goal when it changes.' : '',
    config.conversationExperience.clarifyOnlyMissingContext ? 'Ask only for context that is missing and useful for the next step.' : '',
    config.conversationExperience.avoidRepeatingCompletedQuestions ? 'Do not repeat questions that the customer has already answered.' : '',
    config.recommendationPolicy.explainWhyItMatches ? 'Briefly explain why a verified recommendation fits the stated goal.' : '',
    config.recommendationPolicy.distinguishAlternativesFromComplements ? 'Distinguish alternatives from complementary add-ons.' : '',
    config.recommendationPolicy.neverInventRelationships ? 'Never invent product relationships.' : '',
    config.supportPolicy.answerFromConfiguredSources ? 'Answer support questions from configured sources.' : '',
    config.supportPolicy.discloseMissingCoverage ? 'Disclose when configured coverage is missing.' : '',
    config.supportPolicy.handoffWhenActionUnavailable ? 'Offer a handoff when the requested action is unavailable.' : '',
    config.retrievalPolicy.focusedQueries ? `Use focused retrieval queries and no more than ${config.retrievalPolicy.maxSearchCallsPerTurn} searches per turn.` : '',
    config.retrievalPolicy.skipDuringDiscovery ? 'Avoid retrieval during pure discovery until the customer goal is understood.' : '',
    config.presentationPolicy.preserveRetrievedValues ? 'Preserve retrieved values exactly.' : '',
    config.presentationPolicy.doNotInventIdentifiers ? 'Do not invent identifiers.' : '',
    config.presentationPolicy.doNotInventPrices ? 'Do not invent prices.' : '',
    config.presentationPolicy.useConfiguredPresentationSurface ? 'Use the configured presentation surface.' : '',
    config.organizationResearch.enabled ? 'Research organization details only under the configured research policy.' : '',
    config.organizationResearch.enabled && config.organizationResearch.confirmDetailsBeforeUsing ? 'Confirm researched organization details before relying on them.' : '',
  ].filter(Boolean);
  return lines.length ? `[GENERIC BUSINESS BEHAVIOR]\n${lines.map((line) => `- ${line}`).join('\n')}` : '';
}
