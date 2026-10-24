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
    ...(draft.persona ? { persona: draft.persona } : {}),
  };
  if (draft.profile) pack.profile = deepMerge(pack.profile || {}, draft.profile);
  if (draft.conversationPolicy) pack.conversationPolicy = deepMerge(pack.conversationPolicy || {}, draft.conversationPolicy);
  return pack;
}
