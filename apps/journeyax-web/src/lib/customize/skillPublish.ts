/**
 * Saving or deleting a skill from the Customize page, safely.
 *
 * The same route the agent "Make live" uses: read the project's settings, work out the new values (skillEdit.ts), write them with the
 * project's own update route, publish through the publication gate, and if the gate refuses put every setting back exactly as it was.
 * Nothing here talks to the database or the runtime directly, and nothing is written unless the caller has already checked the
 * person's permission to publish.
 *
 * A change made elsewhere since the page loaded (the back office, a second editor) is noticed by a fingerprint of the skill as the
 * page read it, and answered with 409 instead of an overwrite.
 */
import { applySkillDelete, applySkillSave, fingerprintInState, type AccessRowInput, type EditContext, type ProjectSkillState, type SkillInput, type SkillPatch } from './skillEdit';
import { BUILT_IN_TOOL_IDS, connectorToolIds } from './toolOptions';
import { fail, ok, readProjectSettings, saveAndPublish, type ChangeResult, type WriteDeps } from './projectWrite';

type Rec = Record<string, any>;

export type SkillOp =
  | { kind: 'save'; mode: 'create' | 'update'; input: SkillInput; base?: string }
  | { kind: 'delete'; skillId: string; base?: string };

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const strings = (value: unknown, max = 100): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()).slice(0, max) : []);

/** The request body as an operation, or what is wrong with it. Every field is checked again by `skillEdit`; this only fixes the shapes. */
export function readSkillOp(body: unknown): SkillOp | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'The request had no body.' };
  const b = body as Rec;
  const base = typeof b.base === 'string' && b.base ? b.base : undefined;
  if (b.op === 'delete') {
    const skillId = text(b.skillId, 80);
    if (!skillId) return { error: 'Say which skill to delete.' };
    if (!base) return { error: 'Reload the page: it did not say which version of the skill it was showing.' };
    return { kind: 'delete', skillId, base };
  }
  if (b.op !== 'save') return { error: 'Say whether to save or delete a skill.' };
  const s = (b.skill && typeof b.skill === 'object' ? b.skill : {}) as Rec;
  const mode = b.mode === 'update' ? 'update' : 'create';
  const access: AccessRowInput[] = (Array.isArray(s.access) ? s.access : []).filter((row: unknown) => row && typeof row === 'object').map((row: Rec) => ({
    audience: row.audience === 'staff' ? 'staff' : 'shopper',
    groups: strings(row.groups, 50),
    level: row.level === 'default' || row.level === 'required' ? row.level : 'available',
  }));
  const input: SkillInput = {
    ...(typeof s.skillId === 'string' && s.skillId ? { skillId: s.skillId.slice(0, 80) } : {}),
    name: text(s.name, 400), description: text(s.description, 2000), tier: s.tier === 'on_demand' ? 'on_demand' : 'always',
    instructions: text(s.instructions, 100000), tools: strings(s.tools, 200), access, agents: strings(s.agents, 50),
  };
  if (mode === 'update' && !base) return { error: 'Reload the page: it did not say which version of the skill it was showing.' };
  return { kind: 'save', mode, input, ...(base ? { base } : {}) };
}

export type ChangeDeps = WriteDeps;
export type { ChangeResult };



function stateOf(project: Rec): ProjectSkillState {
  const ext = (project?.extensions && typeof project.extensions === 'object' ? project.extensions : {}) as Rec;
  const plugins = ext.plugins && typeof ext.plugins === 'object' && Array.isArray(ext.plugins.plugins) ? { plugins: ext.plugins.plugins as Rec[], access: Array.isArray(ext.plugins.access) ? ext.plugins.access as Rec[] : [] } : undefined;
  return {
    skills: Array.isArray(ext.skills) ? ext.skills : [],
    agents: Array.isArray(project?.agents) ? project.agents : [],
    accessRows: Array.isArray(ext.skillAccess?.rows) ? ext.skillAccess.rows : [],
    ...(plugins ? { plugins } : {}),
  };
}

/** The request that puts back what a patch changed. */
function undoOf(patch: SkillPatch, before: ProjectSkillState): Rec {
  return {
    ...(patch.skills ? { skills: before.skills } : {}),
    ...(patch.agents ? { agents: before.agents } : {}),
    ...(patch.extensions ? { extensions: {
      ...(patch.extensions.skillAccess ? { skillAccess: { rows: before.accessRows } } : {}),
      ...(patch.extensions.plugins && before.plugins ? { plugins: { plugins: before.plugins.plugins, access: before.plugins.access ?? [] } } : {}),
    } } : {}),
  };
}

export async function changeSkill(deps: ChangeDeps, op: SkillOp): Promise<ChangeResult> {
  const read = await readProjectSettings(deps);
  if ('error' in read) return read.error;
  const project = read.project;
  const before = stateOf(project);
  const ext = (project?.extensions && typeof project.extensions === 'object' ? project.extensions : {}) as Rec;
  const context: EditContext = {
    platformTools: BUILT_IN_TOOL_IDS,
    connectorTools: connectorToolIds(ext.connectors),
    agentIds: before.agents.map((agent) => String(agent?.agentId || '')).filter(Boolean),
  };

  const target = op.kind === 'delete' ? op.skillId : op.mode === 'update' ? String(op.input.skillId || '') : '';
  if (target && op.base) {
    const now = fingerprintInState(before, target);
    if (now === undefined) return fail(409, 'That skill is no longer in the settings. Reload the page.', { conflict: true });
    if (now !== op.base) return fail(409, 'This skill was changed somewhere else since you opened it (for example in the back office). Reload the page to see the latest, then make your change again.', { conflict: true });
  }

  const done = op.kind === 'delete' ? applySkillDelete(before, op.skillId) : applySkillSave(before, op.input, context, op.mode);
  if (done.ok === false) return fail(400, done.errors.join(' '));
  const patch = done.patch;
  const skillId = op.kind === 'delete' ? op.skillId : (done as { skillId: string }).skillId;

  const body: Rec = { ...(patch.skills ? { skills: patch.skills } : {}), ...(patch.agents ? { agents: patch.agents } : {}), ...(patch.extensions ? { extensions: patch.extensions } : {}) };
  const name = op.kind === 'delete' ? skillId : op.input.name.trim();
  const written = await saveAndPublish(deps, {
    patch: body, undo: undoOf(patch, before), subject: 'skill',
    note: `Skill "${name}" ${op.kind === 'delete' ? 'deleted' : op.mode === 'create' ? 'added' : 'changed'} from the Customize page`,
  });
  if (written.ok === false) return written.result;
  return ok({ ok: true, skillId, ...(written.version ? { version: written.version } : {}), ...(op.kind === 'delete' ? { affected: (done as { affected: Rec }).affected } : {}) });
}
