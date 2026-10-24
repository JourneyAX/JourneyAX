/**
 * Builds the Customize overview from a published project config (the document project-service serves at `/published`).
 *
 * Pure and defensive: the published document is loose JSON, so every field is checked and anything missing is simply left
 * out. Nothing is derived to fill an empty tab — a pack with no skills gets an empty skills list, and the page says so.
 * Agent system prompts are never part of the overview.
 */
import { describeTool, PLATFORM_TOOLS } from './tool-catalog';
import type { CustomizeOverview, OverviewAgent, OverviewConnector, OverviewKnowledge, OverviewSkill } from './types';

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(str).filter(Boolean) : []);
type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const rec = (value: unknown): Json => (isRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function readAgents(published: Json): OverviewAgent[] {
  const agents = list(published.agents).filter(isRecord).map((a, index): OverviewAgent => {
    const agentId = str(a.agentId) || `agent_${index + 1}`;
    return {
      agentId,
      name: str(a.name) || agentId,
      purpose: str(a.purpose),
      isDefault: a.isDefault === true,
      allowedTools: strings(a.allowedTools),
      skills: strings(a.skills),
      modelPolicyRef: str(a.modelPolicyRef),
      handoffConditions: strings(a.handoffConditions),
    };
  });
  // A pack names its default explicitly (`isDefault` or `defaultAgentId`); with neither and a single agent, that one is the default.
  const explicit = str(published.defaultAgentId);
  if (explicit && !agents.some((a) => a.isDefault)) for (const a of agents) a.isDefault = a.agentId === explicit;
  if (!agents.some((a) => a.isDefault) && agents.length === 1) agents[0].isDefault = true;
  return agents;
}

/** Skills live in the pack's `extensions.skills` (or a top-level `skills`); an entry without an id, name and description is skipped. */
export function readSkills(published: Json, includeInstructions: boolean): OverviewSkill[] {
  const raw: unknown[] = Array.isArray(published.skills) ? published.skills : list(rec(published.extensions).skills);
  const seen = new Set<string>();
  const out: OverviewSkill[] = [];
  for (const s of raw) {
    if (!isRecord(s)) continue;
    const skillId = str(s.skillId);
    const name = str(s.name);
    if (!skillId || !name || seen.has(skillId)) continue;
    seen.add(skillId);
    const instructions = str(s.instructions);
    out.push({
      skillId,
      name,
      description: str(s.description),
      tier: s.tier === 'on_demand' ? 'on_demand' : 'always',
      tools: strings(s.tools),
      ...(includeInstructions && instructions ? { instructions } : {}),
    });
  }
  return out;
}

export function readKnowledge(published: Json): OverviewKnowledge {
  const model = rec(published.knowledgeModel);
  const sources = list(rec(published.knowledgeSource).sources).filter(isRecord).map((s, i) => ({
    id: str(s.id) || `source_${i + 1}`,
    label: str(s.label) || str(s.id) || `Source ${i + 1}`,
    kind: str(s.type) || 'source',
    ...(str(s.role) ? { role: str(s.role) } : {}),
    enabled: s.enabled !== false,
  }));
  const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const categories = strings(model.categories);
  return {
    ...(str(model.releaseId) ? { releaseId: str(model.releaseId) } : {}),
    ...(str(model.version) ? { version: str(model.version) } : {}),
    ...(typeof model.required === 'boolean' ? { required: model.required } : {}),
    ...(count(model.conceptCount) !== undefined ? { conceptCount: count(model.conceptCount) } : {}),
    ...(count(model.evidenceChunkCount) !== undefined ? { evidenceChunkCount: count(model.evidenceChunkCount) } : {}),
    ...(categories.length ? { categories } : {}),
    sources,
  };
}

/** The built-in tools: every one an agent may call (in the order agents list them), then the platform's remaining tools. */
export function buildConnectors(agents: OverviewAgent[]): OverviewConnector[] {
  const usedBy = new Map<string, string[]>();
  for (const agent of agents) {
    for (const tool of agent.allowedTools) {
      if (tool.includes('*')) continue; // a wildcard names no single tool
      usedBy.set(tool, [...(usedBy.get(tool) || []), agent.agentId]);
    }
  }
  const ids = [...usedBy.keys(), ...Object.keys(PLATFORM_TOOLS).filter((id) => !usedBy.has(id))];
  return ids.map((id) => ({ id, ...describeTool(id), kind: 'platform_tool' as const, usedBy: usedBy.get(id) || [] }));
}

export function buildOverview(tenantId: string, published: Json, opts: { canViewInstructions: boolean }): CustomizeOverview {
  const agents = readAgents(published);
  const version = str(published.packVersion);
  return {
    tenantId,
    ...(version ? { packVersion: version } : {}),
    agents,
    skills: readSkills(published, opts.canViewInstructions),
    knowledge: readKnowledge(published),
    connectors: buildConnectors(agents),
    canViewInstructions: opts.canViewInstructions,
  };
}
