/**
 * What the Customize page shows: the tenant's active agents, skills, knowledge and connectors, as the overview route
 * returns them. Everything here is read from the published pack; nothing is invented to fill a gap.
 */
export interface OverviewAgent {
  agentId: string;
  name: string;
  purpose: string;
  isDefault: boolean;
  allowedTools: string[];
  /** Ids of the skills this agent carries (pack `agents[].skills`); empty until the pack has any. */
  skills: string[];
  modelPolicyRef: string;
  handoffConditions: string[];
}

export interface OverviewSkill {
  skillId: string;
  name: string;
  description: string;
  tier: 'always' | 'on_demand';
  tools: string[];
  /** Only sent to people who can edit the configuration (it is prompt text). */
  instructions?: string;
}

export interface OverviewKnowledgeSource {
  id: string;
  label: string;
  /** How it is fed in (feed, document set, web layer...), as the pack names it. */
  kind: string;
  /** What it is for (product data, content...), as the pack names it. */
  role?: string;
  enabled: boolean;
}

export interface OverviewKnowledge {
  /** The knowledge release the active pack is bound to. */
  releaseId?: string;
  version?: string;
  /** Whether the pack refuses to answer without it. */
  required?: boolean;
  /** When the release was published and its state; only filled for people allowed to read knowledge releases. */
  publishedAt?: string;
  status?: string;
  conceptCount?: number;
  evidenceChunkCount?: number;
  categories?: string[];
  sources: OverviewKnowledgeSource[];
}

export interface OverviewConnector {
  id: string;
  name: string;
  description: string;
  /** 'platform_tool' = a built-in tool of the platform. */
  kind: 'platform_tool';
  /** Agents (ids) that may call it. */
  usedBy: string[];
}

export interface CustomizeOverview {
  tenantId: string;
  packVersion?: string;
  agents: OverviewAgent[];
  skills: OverviewSkill[];
  knowledge: OverviewKnowledge;
  /** Built-in tools: those some agent can call first, then the rest of the platform's tools. */
  connectors: OverviewConnector[];
  /** Whether the signed-in person can see skill instructions (and so edit configuration). */
  canViewInstructions: boolean;
}
