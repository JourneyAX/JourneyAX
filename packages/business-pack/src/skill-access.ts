/**
 * Which skills a person has, and whether each is always in the prompt or opened on demand, from who they are and the pack's skill
 * access table. Pure and small like `resolveAccess`: the prompt builder, `use_skill`, the publication check and the "view as" preview
 * all ask this one function, so they cannot disagree. See `schemas/skill-access.schema.ts` for the rules.
 */
import type { Principal } from '@journeyax/shared-types';
import { AGENT_ACCESS_LEVELS, type AgentAccessLevel } from './schemas/access.schema';
import type { SkillAccess, SkillAccessRow } from './schemas/skill-access.schema';
import { rowApplies } from './access';

const RANK: Record<AgentAccessLevel, number> = Object.fromEntries(AGENT_ACCESS_LEVELS.map((level, index) => [level, index])) as Record<AgentAccessLevel, number>;

export interface EffectiveSkill<S extends { skillId: string }> {
  skill: S;
  /** `always`: its instructions are in the prompt; `on_demand`: its description is, and `use_skill` opens it. */
  tier: 'always' | 'on_demand';
  /** The level a row gave; `null` when no row governs the skill and its own tier applies. */
  level: Exclude<AgentAccessLevel, 'not_available'> | null;
  via: 'own' | 'row';
}

/** The skills this person has, in the order given; a skill the person may not have is left out. */
export function resolveSkillTiers<S extends { skillId: string; tier?: 'always' | 'on_demand' }>(
  skills: S[],
  access: SkillAccess | undefined,
  principal: Pick<Principal, 'audience' | 'groups'>,
): Array<EffectiveSkill<S>> {
  const rowsBySkill = new Map<string, SkillAccessRow[]>();
  for (const row of access?.rows ?? []) {
    const list = rowsBySkill.get(row.skillId);
    if (list) list.push(row); else rowsBySkill.set(row.skillId, [row]);
  }
  const out: Array<EffectiveSkill<S>> = [];
  for (const skill of skills) {
    const rows = rowsBySkill.get(skill.skillId);
    if (!rows) {
      out.push({ skill, tier: skill.tier === 'on_demand' ? 'on_demand' : 'always', level: null, via: 'own' });
      continue;
    }
    const applicable = rows.filter((row) => rowApplies(row, principal));
    if (applicable.length === 0) continue;
    const best = applicable.reduce((top, row) => (RANK[row.level] > RANK[top] ? row.level : top), 'not_available' as AgentAccessLevel);
    if (best === 'not_available') continue;
    out.push({ skill, tier: best === 'available' ? 'on_demand' : 'always', level: best, via: 'row' });
  }
  return out;
}
