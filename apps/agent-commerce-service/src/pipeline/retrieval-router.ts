/** Generic retrieval policy builder. Business-specific routing belongs in the active pack. */
import { EffectiveAgentConfig } from '../runtime-config';
import { IntentResult } from './types';

export interface RetrievalPolicy {
  allowRetrieval: boolean;
  allowedTypes: string[];
  guidance: string;
}

export function buildRetrievalPolicy(intent: IntentResult, pack?: EffectiveAgentConfig): RetrievalPolicy {
  const availableTypes = pack?.retrieval?.types?.filter((type) => type !== 'none') || [];
  const configured = pack?.retrieval?.intentPolicies?.[intent.intent]
    || pack?.retrieval?.defaultPolicy;
  const requestedType = intent.retrievalType && intent.retrievalType !== 'none'
    ? intent.retrievalType
    : undefined;
  const allowRetrieval = configured?.allow ?? Boolean(intent.needsRetrieval);
  const allowedTypes = (configured?.allowedTypes?.length
    ? configured.allowedTypes
    : requestedType ? [requestedType] : availableTypes)
    .filter((type) => availableTypes.length === 0 || availableTypes.includes(type));
  const dimensionScopes = Object.entries(intent.dimensions || {})
    .filter(([, value]) => value && !['general', 'out_of_scope', 'unknown'].includes(String(value).toLowerCase()))
    .map(([key, value]) => `${key}=${value}`);
  const scopeGuidance = dimensionScopes.length
    ? ` Scope retrieval to the configured context: ${dimensionScopes.join(', ')}.`
    : '';
  const guidance = configured?.guidance
    || (allowRetrieval
      ? `Retrieve verified information using the most relevant available content type${allowedTypes.length === 1 ? '' : 's'}${allowedTypes.length ? ` (${allowedTypes.join(', ')})` : ''}. Reassess if the customer's goal changes.${scopeGuidance}`
      : 'This turn is for understanding the customer’s goal or missing context. Do not retrieve yet; ask only the most useful clarifying question(s).');

  return { allowRetrieval: allowRetrieval && allowedTypes.length > 0, allowedTypes, guidance };
}
