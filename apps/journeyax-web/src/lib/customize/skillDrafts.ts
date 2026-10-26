/**
 * Skill drafts made on the Customize page.
 *
 * Like agent drafts, a skill draft is NOT part of the live pack: it lives in this browser, per tenant, until "Make live" sends it to the
 * server (skillPublish.ts), which writes it and publishes through the publication gate. A draft of a change to a live skill remembers
 * which skill it replaces and the fingerprint of that skill as it was when the draft was started, so a change made elsewhere meanwhile is
 * noticed instead of overwritten.
 */
import { readStoredJson, writeStoredJson } from '../shell/storage';
import { fingerprintOf, type AccessRowInput, type SkillInput } from './skillEdit';
import type { OverviewAgent, OverviewSkill } from './types';

export interface SkillDraft extends Omit<SkillInput, 'skillId'> {
  draftId: string;
  /** The live skill this draft changes; absent for a new skill. */
  replaces?: string;
  /** The fingerprint of that skill when the draft was started. */
  base?: string;
  createdAt: number;
  updatedAt: number;
}

export type SkillDraftInput = Omit<SkillDraft, 'draftId' | 'createdAt' | 'updatedAt'>;

export const skillDraftsKey = (tenantId: string | undefined) => `ax:skill-drafts:${tenantId || 'default'}`;

const isDraft = (value: unknown): value is SkillDraft => {
  const v = value as SkillDraft | null;
  return !!v && typeof v.draftId === 'string' && typeof v.name === 'string' && Array.isArray(v.tools) && Array.isArray(v.access) && Array.isArray(v.agents);
};

export function loadSkillDrafts(tenantId: string | undefined): SkillDraft[] {
  const raw = readStoredJson<unknown>(skillDraftsKey(tenantId), []);
  return (Array.isArray(raw) ? raw.filter(isDraft) : []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveSkillDrafts(tenantId: string | undefined, drafts: SkillDraft[]): boolean {
  return writeStoredJson(skillDraftsKey(tenantId), drafts);
}

export const newSkillDraftId = (): string => `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** Adds a draft or replaces the one with `draftId` (newest first). */
export function upsertSkillDraft(list: SkillDraft[], input: SkillDraftInput, draftId?: string, now: number = Date.now()): { list: SkillDraft[]; draft: SkillDraft } {
  const existing = draftId ? list.find((d) => d.draftId === draftId) : undefined;
  const draft: SkillDraft = {
    ...input,
    name: input.name.trim(), description: input.description.trim(), instructions: input.instructions.trim(),
    tools: [...new Set(input.tools)], agents: [...new Set(input.agents)],
    draftId: existing?.draftId || newSkillDraftId(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return { list: [draft, ...list.filter((d) => d.draftId !== draft.draftId)], draft };
}

export function removeSkillDraft(list: SkillDraft[], draftId: string): SkillDraft[] {
  return list.filter((d) => d.draftId !== draftId);
}

/** The form's values for a draft. */
export function draftToInput(draft: SkillDraft): SkillInput {
  const { draftId: _id, replaces, base: _base, createdAt: _c, updatedAt: _u, ...rest } = draft;
  return { ...rest, ...(replaces ? { skillId: replaces } : {}) };
}

/** The agents of the overview that carry a skill. */
export const agentsCarrying = (agents: OverviewAgent[], skillId: string): string[] => agents.filter((agent) => agent.skills.includes(skillId)).map((agent) => agent.agentId);

/** The fingerprint of a live skill as the overview shows it (needs the skill's instructions, which only people who can edit are sent). */
export function fingerprintOfOverviewSkill(skill: OverviewSkill, agents: OverviewAgent[]): string {
  return fingerprintOf({
    name: skill.name, description: skill.description, tier: skill.tier, instructions: skill.instructions ?? '', tools: skill.tools,
    rows: skill.access.map((entry) => ({ audience: entry.audience, groups: entry.groups, level: entry.level })),
    agents: agentsCarrying(agents, skill.skillId),
  });
}

/** A draft for changing a live skill, started from how it is now. */
export function draftFromSkill(skill: OverviewSkill, agents: OverviewAgent[]): SkillDraftInput {
  return {
    name: skill.name, description: skill.description, tier: skill.tier, instructions: skill.instructions ?? '', tools: skill.tools,
    access: skill.access.filter((entry) => entry.level !== 'not_available').map((entry): AccessRowInput => ({ audience: entry.audience, groups: entry.groups.filter((g) => g !== 'administrators'), level: entry.level as AccessRowInput['level'] })),
    agents: agentsCarrying(agents, skill.skillId),
    replaces: skill.skillId,
    base: fingerprintOfOverviewSkill(skill, agents),
  };
}

export const EMPTY_SKILL: SkillDraftInput = {
  name: '', description: '', tier: 'on_demand', instructions: '', tools: [], access: [], agents: [],
};
