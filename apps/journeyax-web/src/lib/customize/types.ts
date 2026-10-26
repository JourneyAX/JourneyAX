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

/** One row of the pack's skill access table that names a skill (pack `extensions.skillAccess`). */
export interface SkillAccessEntry {
  audience: 'shopper' | 'staff';
  groups: string[];
  level: 'not_available' | 'available' | 'default' | 'required';
}

export interface OverviewSkill {
  skillId: string;
  name: string;
  description: string;
  tier: 'always' | 'on_demand';
  tools: string[];
  /** Who has this skill and how, from the pack's skill access table; empty when no row names it (it is carried as its own tier says). */
  access: SkillAccessEntry[];
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

/** A named bundle (pack `extensions.plugins`): the agents, skills, forms, connected systems and tools it switches on together, and who has it. */
export interface OverviewPlugin {
  pluginId: string;
  name: string;
  description: string;
  provides: { agents: string[]; skills: string[]; forms: string[]; connectors: string[]; tools: string[] };
  access: Array<{ audience: 'shopper' | 'staff'; groups: string[]; level: 'not_available' | 'available' | 'default' | 'required' }>;
}

/** Another system the assistant can reach (pack `extensions.connectors`), as the shop declared it. */
export interface OverviewSystem {
  connectorId: string;
  name: string;
  description: string;
  owner: string;
  sample: boolean;
  tools: number;
  /** Tools that change data in that system, and so ask first or are blocked unless a row says otherwise. */
  writes: number;
}

/** A team of the project (a staff group): `id` is the group id the pack's access rows use. */
export interface OverviewTeam { id: string; name: string }

export type ToolState = 'allow' | 'ask' | 'blocked';

/**
 * One tool a skill may name: a built-in tool of the platform, or a tool of a connected system (written `system.tool`, for example
 * `salesforce.list_cases`). For a connector tool, `states` says what each team may do with it under the pack's rules (`shopper` is
 * everyone who is not staff), so the editor can say "Customer Service cannot use this" before anything is published.
 */
export interface OverviewToolOption {
  id: string;
  label: string;
  systemId: string;
  system: string;
  summary: string;
  sideEffect?: 'read' | 'write';
  /** False when the system is switched off in the pack: naming its tools has no effect until it is switched on. */
  enabled: boolean;
  states?: Record<string, ToolState>;
}

/** A column of the rules table: a team of the project, the platform administrators, or a group the rules name that no team has. */
export interface RuleColumn { id: string; name: string; note?: string }

/** What the connection check (the connector server's own health answer) says about one system; absent when no check is configured. */
export interface SystemStatus { checked: true; connected: boolean; missing: string[] }

/**
 * One connected system with who may do what with each of its tools, for people who may change the rules. `grid` is the state each column
 * gets for each tool under the pack's rules (strictest row wins; a tool nobody has a row for is blocked); `base` is a fingerprint of the
 * system's settings and rows as read, so a save made on top of a change made elsewhere is refused instead of overwriting it.
 */
export interface OverviewConnectorRules {
  connectorId: string;
  name: string;
  description: string;
  owner: string;
  sample: boolean;
  enabled: boolean;
  tools: Array<{ name: string; label: string; summary: string; sideEffect: 'read' | 'write' }>;
  columns: RuleColumn[];
  grid: Record<string, Record<string, ToolState>>;
  /** Rules that the grid hides: default rows (every tool with no row of its own), rows for all staff, rows for everyone (shoppers too). */
  notes: { defaultRows: number; allStaffRows: number; everyoneRows: number };
  base: string;
  status?: SystemStatus;
}

export interface CustomizeOverview {
  tenantId: string;
  packVersion?: string;
  agents: OverviewAgent[];
  skills: OverviewSkill[];
  plugins: OverviewPlugin[];
  systems: OverviewSystem[];
  knowledge: OverviewKnowledge;
  /** Built-in tools: those some agent can call first, then the rest of the platform's tools. */
  connectors: OverviewConnector[];
  /** Whether the signed-in person can see skill instructions (and so edit configuration). */
  canViewInstructions: boolean;
  /** Whether the signed-in person may change skills and make them live (the publish permission). */
  canEdit: boolean;
  /** The project's teams, for choosing who has a skill. Empty when they could not be read. */
  teams: OverviewTeam[];
  /** Every tool a skill may name, built-in and connected, with what each team may do with it. */
  toolOptions: OverviewToolOption[];
  /** Every connected system, switched on or off, with its rules table. Only for people who may change them. */
  connectorRules: OverviewConnectorRules[];
}
