/**
 * Editing the pack's skills from the Customize page, as pure functions over the project's settings.
 *
 * A skill touches four places: the skill itself (`extensions.skills`), who has it (`extensions.skillAccess` rows), which agents carry it
 * (`agents[].skills`) and the plugins that bundle it (`extensions.plugins[].provides.skills`). Saving or deleting one has to keep all four
 * in step, or the publication gate refuses the result (a row for a skill that is gone, an agent carrying a skill nobody defines).
 * These functions return the NEW values for those places and touch nothing else; the caller writes them through the project's own update
 * and publish routes, which run the gate. See `skillPublish.ts`.
 *
 * Rules kept here, because the model reads this text on every turn it applies:
 *  - an id is made once, from the first name, and never changes (agents and rows refer to it);
 *  - a skill with any access row is governed only by its rows; a skill with none is carried as its own tier says, by everyone;
 *  - a shopper row never names groups; a staff row that names groups always includes the reserved `administrators` group, as the pack's
 *    other rows do, so the platform admin (who is in no team) is not shut out.
 */
import { ADMIN_GROUP, normaliseGroupId } from '@journeyax/shared-types';
import type { OverviewToolOption, ToolState } from './types';

export const SKILL_LIMITS = { name: 80, description: 400, instructions: 20000, tools: 60, rows: 10 } as const;

export type SkillTier = 'always' | 'on_demand';
export type SkillLevel = 'available' | 'default' | 'required';
export interface AccessRowInput { audience: 'shopper' | 'staff'; groups: string[]; level: SkillLevel }

/** What the form holds. `skillId` is present when an existing skill is edited. */
export interface SkillInput {
  skillId?: string;
  name: string;
  description: string;
  tier: SkillTier;
  instructions: string;
  /** Tool ids: a built-in tool (`present_card`) or a tool of a connected system (`salesforce.list_cases`). */
  tools: string[];
  access: AccessRowInput[];
  /** Ids of the agents that carry the skill. */
  agents: string[];
}

type Rec = Record<string, any>;

/** The parts of a project's settings a skill touches, as the project service returns them. */
export interface ProjectSkillState {
  skills: Rec[];
  agents: Rec[];
  accessRows: Rec[];
  plugins?: { plugins: Rec[]; access?: Rec[] };
}

/** What the project's own settings say exists, for checking a form. */
export interface EditContext {
  platformTools: string[];
  connectorTools: string[];
  agentIds: string[];
}

/** The values to write. A key is present only when it changed, so a save never rewrites what it did not touch. */
export interface SkillPatch {
  skills?: Rec[];
  agents?: Rec[];
  extensions?: { skillAccess?: { rows: Rec[] }; plugins?: { plugins: Rec[]; access: Rec[] } };
}

const asList = (value: unknown): Rec[] => (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : []);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const uniq = <T,>(list: T[]): T[] => [...new Set(list)];

/** A skill id from a name: lower case, digits and hyphens, new within `taken` (a second "Greeting" becomes `greeting-2`). */
export function slugifySkillId(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '') || 'skill';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Access rows as the form wrote them, made into the shape the pack keeps: valid group ids, the admin group added, no duplicates. */
export function cleanAccessRows(rows: AccessRowInput[]): AccessRowInput[] {
  const out: AccessRowInput[] = [];
  for (const row of rows) {
    if (row.level !== 'available' && row.level !== 'default' && row.level !== 'required') continue;
    const audience = row.audience === 'staff' ? 'staff' : 'shopper';
    let groups: string[] = [];
    if (audience === 'staff') {
      groups = uniq((row.groups || []).map((group) => normaliseGroupId(group)).filter(Boolean));
      if (groups.length > 0 && !groups.includes(ADMIN_GROUP)) groups = [...groups, ADMIN_GROUP];
    }
    const next: AccessRowInput = { audience, groups, level: row.level };
    if (!out.some((entry) => same(entry, next))) out.push(next);
  }
  return out;
}

export interface SkillCheck { ok: boolean; errors: string[] }

/** Everything wrong with a form, in plain words (empty when it is fine). */
export function validateSkill(input: SkillInput, context: EditContext): SkillCheck {
  const errors: string[] = [];
  const name = input.name.trim();
  if (!name) errors.push('Give the skill a name.');
  if (name.length > SKILL_LIMITS.name) errors.push(`The name is longer than ${SKILL_LIMITS.name} characters.`);
  const description = input.description.trim();
  if (!description) errors.push('Say in a sentence when the assistant should use this skill.');
  if (description.length > SKILL_LIMITS.description) errors.push(`The description is longer than ${SKILL_LIMITS.description} characters.`);
  const instructions = input.instructions.trim();
  if (!instructions) errors.push('Write the instructions the assistant should follow.');
  if (instructions.length > SKILL_LIMITS.instructions) errors.push(`The instructions are longer than ${SKILL_LIMITS.instructions} characters.`);
  if (input.tier !== 'always' && input.tier !== 'on_demand') errors.push('Choose whether the skill is always on or opened on demand.');
  const tools = uniq(input.tools);
  if (tools.length > SKILL_LIMITS.tools) errors.push(`A skill can name at most ${SKILL_LIMITS.tools} tools.`);
  const known = new Set([...context.platformTools, ...context.connectorTools]);
  for (const tool of tools) if (!known.has(tool)) errors.push(`The pack has no tool called "${tool}".`);
  for (const agent of uniq(input.agents)) if (!context.agentIds.includes(agent)) errors.push(`The pack has no agent called "${agent}".`);
  if (input.access.length > SKILL_LIMITS.rows) errors.push(`A skill can have at most ${SKILL_LIMITS.rows} rows saying who has it.`);
  for (const row of input.access) {
    if (row.audience === 'shopper' && row.groups.length > 0) errors.push('A row for everyone cannot name teams.');
    if (row.level !== 'available' && row.level !== 'default' && row.level !== 'required') errors.push('Every row needs a level: on demand, always on or required.');
  }
  return { ok: errors.length === 0, errors };
}

export type SaveResult = { ok: true; skillId: string; skill: Rec; patch: SkillPatch } | { ok: false; errors: string[] };

/** The settings after saving a new skill (`create`) or changing an existing one (`update`). Nothing is written here. */
export function applySkillSave(state: ProjectSkillState, input: SkillInput, context: EditContext, mode: 'create' | 'update'): SaveResult {
  const checked = validateSkill(input, context);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const existingIds = state.skills.map((skill) => String(skill?.skillId || ''));
  let skillId: string;
  if (mode === 'create') {
    skillId = slugifySkillId(input.name, existingIds);
  } else {
    skillId = String(input.skillId || '');
    if (!skillId || !existingIds.includes(skillId)) return { ok: false, errors: [`The pack has no skill called "${skillId || '(none)'}" to change.`] };
  }

  const previous = state.skills.find((skill) => skill?.skillId === skillId);
  const skill: Rec = {
    ...(previous ?? {}),
    skillId,
    name: input.name.trim(),
    description: input.description.trim(),
    tier: input.tier,
    instructions: input.instructions.trim(),
    tools: uniq(input.tools),
  };
  const skills = previous ? state.skills.map((entry) => (entry?.skillId === skillId ? skill : entry)) : [...state.skills, skill];

  const wanted = new Set(input.agents);
  const agents = state.agents.map((agent) => {
    const carried: string[] = Array.isArray(agent?.skills) ? agent.skills : [];
    const has = carried.includes(skillId);
    const should = wanted.has(String(agent?.agentId));
    if (has === should) return agent;
    return { ...agent, skills: should ? [...carried, skillId] : carried.filter((id) => id !== skillId) };
  });

  const others = state.accessRows.filter((row) => row?.skillId !== skillId);
  const mine = cleanAccessRows(input.access).map((row) => ({ skillId, audience: row.audience, groups: row.groups, level: row.level }));
  const rows = [...others, ...mine];

  const patch: SkillPatch = { skills };
  if (!same(agents, state.agents)) patch.agents = agents;
  if (!same(rows, state.accessRows)) patch.extensions = { skillAccess: { rows } };
  return { ok: true, skillId, skill, patch };
}

export interface DeleteResult {
  ok: true;
  patch: SkillPatch;
  /** What the deletion touched, for the confirmation: agents that carried it, plugins that bundled it, rows that named it. */
  affected: { agents: string[]; plugins: string[]; rows: number };
}

/** The settings after deleting a skill, with every reference to it removed so the publication gate has nothing to refuse. */
export function applySkillDelete(state: ProjectSkillState, skillId: string): DeleteResult | { ok: false; errors: string[] } {
  if (!state.skills.some((skill) => skill?.skillId === skillId)) return { ok: false, errors: [`The pack has no skill called "${skillId}".`] };
  const skills = state.skills.filter((skill) => skill?.skillId !== skillId);
  const carriedBy = state.agents.filter((agent) => Array.isArray(agent?.skills) && agent.skills.includes(skillId)).map((agent) => String(agent.agentId));
  const agents = state.agents.map((agent) => (carriedBy.includes(String(agent?.agentId)) ? { ...agent, skills: agent.skills.filter((id: string) => id !== skillId) } : agent));
  const rows = state.accessRows.filter((row) => row?.skillId !== skillId);
  const bundledIn = asList(state.plugins?.plugins).filter((plugin) => Array.isArray(plugin?.provides?.skills) && plugin.provides.skills.includes(skillId));
  const patch: SkillPatch = { skills };
  if (carriedBy.length > 0) patch.agents = agents;
  if (rows.length !== state.accessRows.length) patch.extensions = { skillAccess: { rows } };
  if (bundledIn.length > 0 && state.plugins) {
    const plugins = asList(state.plugins.plugins).map((plugin) => (bundledIn.includes(plugin) ? { ...plugin, provides: { ...plugin.provides, skills: plugin.provides.skills.filter((id: string) => id !== skillId) } } : plugin));
    patch.extensions = { ...(patch.extensions ?? {}), plugins: { plugins, access: asList(state.plugins.access) } };
  }
  return { ok: true, patch, affected: { agents: carriedBy, plugins: bundledIn.map((plugin) => String(plugin.pluginId)), rows: state.accessRows.length - rows.length } };
}

// ── Noticing a change made elsewhere ────────────────────────────────────────────────────────────
// The page edits what it read from the published pack; the server edits the project's settings. If someone changed the same skill in between
// (the back office, a second editor), saving would overwrite their work. A fingerprint of the skill as it was read, checked by the server
// against the skill as it is now, turns that into a clear "reload first" instead of a silent overwrite.

interface FingerprintParts { name: string; description: string; tier: string; instructions: string; tools: string[]; rows: Array<{ audience: string; groups: string[]; level: string }>; agents: string[] }

export function hashText(text: string): string {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) { x ^= text.charCodeAt(i); x = Math.imul(x, 16777619); }
  return `${(x >>> 0).toString(16)}-${text.length}`;
}

export function fingerprintOf(parts: FingerprintParts): string {
  const rows = parts.rows.map((row) => ({ audience: row.audience === 'staff' ? 'staff' : 'shopper', groups: [...row.groups].sort(), level: row.level })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return hashText(JSON.stringify({ n: parts.name.trim(), d: parts.description.trim(), t: parts.tier, i: parts.instructions.trim(), x: [...parts.tools].sort(), r: rows, a: [...parts.agents].sort() }));
}

/** The fingerprint of a skill in the project's settings; undefined when there is no such skill. */
export function fingerprintInState(state: ProjectSkillState, skillId: string): string | undefined {
  const skill = state.skills.find((entry) => entry?.skillId === skillId);
  if (!skill) return undefined;
  return fingerprintOf({
    name: String(skill.name ?? ''), description: String(skill.description ?? ''), tier: skill.tier === 'on_demand' ? 'on_demand' : 'always', instructions: String(skill.instructions ?? ''),
    tools: Array.isArray(skill.tools) ? skill.tools.map(String) : [],
    rows: state.accessRows.filter((row) => row?.skillId === skillId).map((row) => ({ audience: String(row.audience), groups: Array.isArray(row.groups) ? row.groups.map(String) : [], level: String(row.level) })),
    agents: state.agents.filter((agent) => Array.isArray(agent?.skills) && agent.skills.includes(skillId)).map((agent) => String(agent.agentId)),
  });
}

// ── Helpers for the form ────────────────────────────────────────────────────────────────────────

/** Rows from the overview (as the published pack states them) turned into form rows: the admin group is hidden, it is always added back. */
export function formRowsFromEntries(entries: Array<{ audience: 'shopper' | 'staff'; groups: string[]; level: 'not_available' | 'available' | 'default' | 'required' }>): AccessRowInput[] {
  const rows: AccessRowInput[] = [];
  for (const entry of entries) {
    if (entry.level === 'not_available') continue;
    rows.push({ audience: entry.audience, groups: entry.groups.filter((group) => group !== ADMIN_GROUP), level: entry.level });
  }
  return rows;
}

export const ACCESS_PRESETS = {
  'staff-on-demand': 'Selected teams, opened when a request fits',
  'staff-always': 'Selected teams, always on',
  everyone: 'Everyone, as the skill\'s own setting says',
} as const;
export type AccessPreset = keyof typeof ACCESS_PRESETS;

/** The rows a preset stands for (`everyone` is no rows at all: the skill is carried as its own tier says, by everyone). */
export function presetRows(preset: AccessPreset, teams: string[]): AccessRowInput[] {
  if (preset === 'everyone') return [];
  return [{ audience: 'staff', groups: teams, level: preset === 'staff-always' ? 'default' : 'available' }];
}

/** Which preset a set of rows is, or undefined when it is something custom. */
export function presetOf(rows: AccessRowInput[]): AccessPreset | undefined {
  if (rows.length === 0) return 'everyone';
  if (rows.length === 1 && rows[0].audience === 'staff') return rows[0].level === 'default' ? 'staff-always' : rows[0].level === 'available' ? 'staff-on-demand' : undefined;
  return undefined;
}

export interface ToolWarning { tool: string; who: string; state: ToolState | 'off'; text: string }

/**
 * What would go wrong for the people who get the skill: a tool of a connected system that some team may not use (the skill would send them
 * to something the assistant must refuse), a system that is switched off, and any connector tool at all for shoppers (they have no
 * connectors). `teams` names the project's teams so a row for "all staff" can be checked team by team.
 */
export function toolWarnings(tools: string[], rows: AccessRowInput[], options: OverviewToolOption[], teams: Array<{ id: string; name: string }>): ToolWarning[] {
  const byId = new Map(options.map((option) => [option.id, option]));
  const nameOf = (id: string) => (id === ADMIN_GROUP ? 'Administrators' : teams.find((team) => team.id === id)?.name ?? id);
  const warnings: ToolWarning[] = [];
  const staffGroups = new Set<string>();
  let shoppers = rows.length === 0;
  for (const row of cleanAccessRows(rows)) {
    if (row.audience === 'shopper') { shoppers = true; continue; }
    if (row.groups.length === 0) teams.forEach((team) => staffGroups.add(team.id));
    else row.groups.filter((group) => group !== ADMIN_GROUP).forEach((group) => staffGroups.add(group));
  }
  for (const tool of uniq(tools)) {
    const option = byId.get(tool);
    if (!option || !option.states) continue; // built-in tools are not governed by team rules
    if (!option.enabled) warnings.push({ tool, who: option.system, state: 'off', text: `${option.system} is switched off in the pack, so "${option.label}" does nothing until it is switched on.` });
    for (const group of staffGroups) {
      const state = option.states[group] ?? 'blocked';
      if (state === 'blocked') warnings.push({ tool, who: nameOf(group), state, text: `${nameOf(group)} cannot use "${option.label}" (${option.system}): the assistant will skip that step for them.` });
    }
    if (shoppers) warnings.push({ tool, who: 'Shoppers', state: 'blocked', text: `Shoppers cannot use any connected system, so "${option.label}" (${option.system}) will not work for them.` });
  }
  return warnings;
}
