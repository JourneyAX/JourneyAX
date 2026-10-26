/**
 * A draft agent pack laid over the live one, in memory only, to try a change before publishing it.
 *
 * `overlayDraft(live, draft)` returns a copy of the live pack with the draft's agents, skills, quantity-helper and picture settings,
 * persona and profile in place, shaped the way the publication step shapes them. Nothing is written anywhere: the preview runtime
 * (scripts/dev/preview-runtime.ts) applies it to every pack it loads, so the live tenant and its database are untouched.
 */
type Json = Record<string, any>;

const isPlain = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const deepMerge = (base: Json, patch: Json): Json => {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch || {})) out[key] = isPlain(value) && isPlain(out[key]) ? deepMerge(out[key], value) : value;
  return out;
};

/** An agent of the draft as the published pack would carry it. */
export function compileAgent(agent: Json, live: Json, draft: Json): Json {
  const liveDefault = (live.agents || []).find((a: Json) => a.isDefault === true) || (live.agents || [])[0] || {};
  const liveSame = (live.agents || []).find((a: Json) => a.agentId === agent.agentId);
  return {
    agentId: agent.agentId,
    name: agent.name || agent.agentId,
    purpose: agent.purpose || agent.name || agent.agentId,
    systemPromptTemplate: String(agent.systemPromptTemplate || draft.persona?.systemPromptOverrides || '').trim(),
    inputSchema: agent.inputSchema || {},
    outputSchema: agent.outputSchema || {},
    allowedTools: Array.isArray(agent.allowedTools) ? agent.allowedTools : [],
    modelPolicyRef: agent.modelPolicyRef || liveDefault.modelPolicyRef || 'default',
    maxTurns: agent.maxTurns || 5,
    handoffConditions: Array.isArray(agent.handoffConditions) ? agent.handoffConditions : [],
    // The journey playbook is kept from the live agent of the same id: it is configured outside the instructions draft.
    ...(liveSame?.journeyPlaybook ? { journeyPlaybook: liveSame.journeyPlaybook } : {}),
    ...(Array.isArray(agent.skills) ? { skills: agent.skills } : {}),
    ...(agent.isDefault === true ? { isDefault: true } : {}),
    ...(typeof agent.toolFirst === 'boolean' ? { toolFirst: agent.toolFirst } : {}),
  };
}

export function overlayDraft(live: Json, draft: Json): Json {
  const pack: Json = structuredClone(live);
  if (Array.isArray(draft.agents) && draft.agents.length > 0) pack.agents = draft.agents.map((agent: Json) => compileAgent(agent, live, draft));
  pack.extensions = {
    ...(pack.extensions || {}),
    ...(Array.isArray(draft.skills) ? { skills: draft.skills } : {}),
    ...(draft.extensions?.quantityHelper ? { quantityHelper: draft.extensions.quantityHelper } : {}),
    ...(draft.extensions?.visualiser ? { visualiser: draft.extensions.visualiser } : {}),
    ...(draft.extensions?.eventPrefetch ? { eventPrefetch: draft.extensions.eventPrefetch } : {}),
    ...(draft.extensions?.productGuides ? { productGuides: draft.extensions.productGuides } : {}),
    ...(draft.extensions?.contentPages ? { contentPages: draft.extensions.contentPages } : {}),
    ...(draft.extensions?.checkoutReview ? { checkoutReview: draft.extensions.checkoutReview } : {}),
    ...(draft.extensions?.payment ? { payment: draft.extensions.payment } : {}),
    ...(draft.extensions?.brandTheme ? { brandTheme: draft.extensions.brandTheme } : {}),
    ...(draft.extensions?.voice ? { voice: draft.extensions.voice } : {}),
    ...(draft.persona ? { persona: draft.persona } : {}),
  };
  if (draft.profile) pack.profile = deepMerge(pack.profile || {}, draft.profile);
  if (draft.conversationPolicy) pack.conversationPolicy = deepMerge(pack.conversationPolicy || {}, draft.conversationPolicy);
  return pack;
}

/**
 * Tries another answering model in a preview, from a spec like `anthropic/claude-sonnet-5-5` or `google/gemini-2.5-flash:medium` (the part after
 * the colon is the thinking effort). The named model goes first for the policies that answer and choose tools; the live candidates stay behind
 * it as fallbacks. In memory only, like the rest of the overlay.
 */
export function withModel(pack: Json, spec: string): Json {
  const [route, effort] = spec.split(':');
  const [provider, ...rest] = route.split('/');
  const model = rest.join('/');
  if (!provider || !model || !pack.modelPolicy?.policies) return pack;
  const out: Json = structuredClone(pack);
  for (const policy of out.modelPolicy.policies) {
    if (!['complex_reasoning', 'response_generation', 'tool_selection'].includes(policy.policyId)) continue;
    const first = (policy.candidates || [])[0] || {};
    policy.candidates = [
      { provider, model, priority: 1, ...(first.temperature !== undefined ? { temperature: first.temperature } : {}), ...(effort ? { reasoningEffort: effort } : {}) },
      ...(policy.candidates || []).map((c: Json, i: number) => ({ ...c, priority: i + 2 })),
    ];
  }
  return out;
}

/** Shows demo prices (a made-up price for a product with no real one) in a preview, the way `pricing.demoFallback` does once published. In memory only. */
export function withDemoPrices(pack: Json): Json {
  if (!pack.catalogMapping?.pricing) return pack;
  const out: Json = structuredClone(pack);
  out.catalogMapping.pricing.demoFallback = { enabled: true, currency: 'NZD', min: 4.9, max: 480 };
  return out;
}
