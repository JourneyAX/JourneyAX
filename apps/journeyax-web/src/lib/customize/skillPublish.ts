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

export interface ChangeDeps {
  /** `<project api>/api/v1/projects/<tenant>` */
  base: string;
  /** Authorization and tenant headers (and the JSON content type). */
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  environmentId?: string;
}

export interface ChangeResult { status: number; body: Rec }

const ok = (body: Rec): ChangeResult => ({ status: 200, body });
const fail = (status: number, error: string, extra: Rec = {}): ChangeResult => ({ status, body: { error, ...extra } });

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
  const call = deps.fetchImpl ?? fetch;
  let project: Rec;
  try {
    const current = await call(deps.base, { headers: deps.headers, signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (!current.ok) return fail(502, 'The project could not be read.');
    project = await current.json();
  } catch {
    return fail(502, 'The project could not be read: the service did not answer.');
  }
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
  const put = async (payload: Rec) => call(deps.base, { method: 'PATCH', headers: deps.headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });

  let saved: Response;
  try { saved = await put(body); } catch { return fail(502, 'The skill could not be saved: the service did not answer.'); }
  if (!saved.ok) {
    const detail: Rec = await saved.json().catch(() => ({}));
    return fail(saved.status === 400 || saved.status === 422 ? 422 : 502, `The skill could not be saved to the project${detail?.message ? `: ${String(detail.message).slice(0, 300)}` : '.'}`);
  }

  const name = op.kind === 'delete' ? skillId : op.input.name.trim();
  try {
    const published = await call(`${deps.base}/publish`, {
      method: 'POST', headers: deps.headers, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ environmentId: deps.environmentId ?? 'production', note: `Skill "${name}" ${op.kind === 'delete' ? 'deleted' : op.mode === 'create' ? 'added' : 'changed'} from the Customize page` }),
    });
    if (published.ok) {
      const result: Rec = await published.json().catch(() => ({}));
      return ok({ ok: true, skillId, ...(result?.version ? { version: result.version } : {}), ...(op.kind === 'delete' ? { affected: (done as { affected: Rec }).affected } : {}) });
    }
    const detail: Rec = await published.json().catch(() => ({}));
    const restored = await restore(put, patch, before);
    return fail(422, `The configuration was not published: ${String(detail?.message || published.status)}${restored ? '' : ' The settings could not be put back; check them in the back office.'}`);
  } catch {
    const restored = await restore(put, patch, before);
    return fail(502, `The configuration could not be published: the service did not answer.${restored ? '' : ' The settings could not be put back; check them in the back office.'}`);
  }
}

async function restore(put: (payload: Rec) => Promise<Response>, patch: SkillPatch, before: ProjectSkillState): Promise<boolean> {
  try { return (await put(undoOf(patch, before))).ok; } catch { return false; }
}
