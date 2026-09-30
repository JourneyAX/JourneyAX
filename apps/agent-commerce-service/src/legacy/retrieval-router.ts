/**
 * @deprecated FROZEN LEGACY RETRIEVAL ROUTER
 * Preserved strictly for legacy unmigrated tenants.
 * Canonical runtime uses published Business Pack retrieval bindings and stage policies.
 */
import { IntentResult } from '../pipeline/types';

export interface RetrievalPolicy {
  allowRetrieval: boolean;
  allowedTypes: string[];
  guidance: string;
}

export function buildRetrievalPolicy(intent: IntentResult): RetrievalPolicy {
  if (
    intent.intent === 'general_question' ||
    intent.retrievalType === 'faq' ||
    intent.space === 'policy' ||
    intent.stage === 'faq'
  ) {
    return {
      allowRetrieval: true,
      allowedTypes: ['faq', 'policy', 'general', 'product'],
      guidance:
        'RETRIEVAL POLICY: The customer is asking a direct question (policy, return, warranty, shipping, store info, FAQ). ' +
        'Call searchKnowledge with type:"faq" or type:"general" to retrieve the authoritative answer. ' +
        'Answer their question directly, concisely, and warmly. Do NOT call setPhase("clarify").',
    };
  }

  const classifierDown = intent.confidence === 0 && intent.intent === 'unknown';
  if (!classifierDown && (!intent.needsRetrieval || intent.stage === 'intro')) {
    return {
      allowRetrieval: false,
      allowedTypes: [],
      guidance:
        'RETRIEVAL POLICY: This is a discovery turn — do NOT call searchKnowledge yet. ' +
        'You MUST call setPhase("clarify") with 3-5 selectable questions (each with 3-4 options) ' +
        'so they render as chips on the RIGHT panel. In the CHAT, be a warm, consultative stylist: ' +
        'acknowledge their goal, and where you can, sketch a style direction and the reasoning ' +
        '(a couple of short paragraphs is great — like a real showroom expert). ' +
        'The ONE thing you must NOT do is type the clarifying questions or their options into the ' +
        'chat text — those belong on the right. Close by pointing them to the questions on the right.',
    };
  }

  let allowedTypes: string[];
  let lead: string;
  switch (intent.intent) {
    case 'leak_repair':
      allowedTypes = ['troubleshooting', 'installation', 'product'];
      lead = 'LEAD with a type:"troubleshooting" search for the specific symptom (e.g. "mixer leaking base"). Only search type:"product" if a replacement part is genuinely needed.';
      break;
    case 'installation_help':
      allowedTypes = ['installation', 'troubleshooting', 'product'];
      lead = 'LEAD with a type:"installation" search for that product\'s install/rough-in guide.';
      break;
    case 'bathroom_remodel':
    case 'design_inspiration':
      allowedTypes = ['design', 'collection', 'product'];
      lead = 'LEAD with a type:"design" search to anchor the style/concept the customer described (or type:"collection" for a coordinated matching range across fixtures), THEN type:"product" for the individual fixtures inside that look. Do NOT skip the design/collection search — it is what makes a remodel feel curated rather than a parts list.';
      break;
    case 'product_recommendation':
      allowedTypes = ['product', 'collection', 'design', 'installation', 'faq'];
      lead = 'Search type:"product" for the fixtures the customer wants (add type:"collection" for a matching range). Once a product is chosen, you MAY also search type:"installation" for its fitting guide and type:"faq" for its warranty/care before quoting.';
      break;
    case 'quote_order':
      allowedTypes = ['product', 'installation', 'faq'];
      lead = 'Search type:"product" to confirm exact SKUs/prices; you MAY also pull type:"faq" (warranty) and type:"installation" so the quote includes accurate warranty and fitting guidance.';
      break;
    default:
      allowedTypes = ['product', 'faq', 'general'];
      lead = 'Search type:"faq" for policy/warranty/care questions, otherwise type:"product".';
  }

  const scoped = Object.entries(intent.dimensions || {})
    .filter(([, v]) => v && !['general', 'out_of_scope', 'unknown'].includes(String(v).toLowerCase()));
  const dimScope = scoped.length
    ? ` SCOPE every search to: ${scoped.map(([k, v]) => `${k}=${v}`).join(', ')} (include those terms in the query).`
    : '';

  return {
    allowRetrieval: true,
    allowedTypes,
    guidance:
      `RETRIEVAL POLICY: Allowed content types this turn: [${allowedTypes.join(', ')}].${dimScope} ${lead} ` +
      `Re-classify if the customer's intent shifts. Use short 2-4 word queries.`,
  };
}
