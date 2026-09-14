/**
 * Skill loader (v3 Card CMS, docs/v3-card-cms-architecture.md) — modelled on
 * anthropics/commerce-agents' SKILL.md convention: front-matter `name` +
 * `description` (the description ends with "Not needed when …" so the model
 * can rule a skill out from its one-line summary alone), body is the
 * technique itself, loaded on demand via the `loadSkill` tool rather than
 * always sitting in the system prompt.
 *
 * Layout on disk (siblings of `dist`/`src`, so the same relative path works
 * in both `tsx watch src/main.ts` and `node dist/main.js`):
 *   apps/agent-commerce-service/skills/_platform/<name>/SKILL.md   — every tenant
 *   apps/agent-commerce-service/skills/<projectId>/<name>/SKILL.md — tenant-specific
 */
import fs from 'fs';
import path from 'path';

const SKILLS_ROOT = path.join(__dirname, '..', '..', 'skills');

interface SkillMeta {
  name: string;
  description: string;
  path: string;
  mtimeMs: number;
}

interface SkillFile extends SkillMeta {
  body: string;
}

const cache = new Map<string, SkillFile>();

function parseFrontMatter(raw: string): { name?: string; description?: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: raw };
  const [, fm, body] = m;
  const out: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { name: out.name, description: out.description, body: body.trim() };
}

function readSkillDir(dir: string): SkillFile[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: SkillFile[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = path.join(dir, ent.name, 'SKILL.md');
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { continue; }
    const cacheKey = file;
    const cached = cache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs) { out.push(cached); continue; }
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const { name, description, body } = parseFrontMatter(raw);
    const skill: SkillFile = { name: name || ent.name, description: description || '', body, path: file, mtimeMs: stat.mtimeMs };
    cache.set(cacheKey, skill);
    out.push(skill);
  }
  return out;
}

/** Every skill available to this tenant: platform skills, then the tenant's own. */
function listSkills(projectId: string): SkillFile[] {
  const platform = readSkillDir(path.join(SKILLS_ROOT, '_platform'));
  const tenant = projectId ? readSkillDir(path.join(SKILLS_ROOT, projectId)) : [];
  // A tenant skill with the same name overrides the platform one, matching
  // how ProjectConfig overrides generally work in this codebase.
  const byName = new Map<string, SkillFile>();
  for (const s of [...platform, ...tenant]) byName.set(s.name, s);
  return [...byName.values()];
}

/**
 * The system-prompt block: name + description only (never the body — that's
 * what `loadSkill` is for, so a rarely-needed technique doesn't sit in every
 * turn's context). Empty string when no skills exist yet for this tenant.
 */
export function skillIndexBlock(projectId: string): string {
  const skills = listSkills(projectId);
  if (!skills.length) return '';
  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`).join('\n');
  return `\n\n## Skills (load by name with loadSkill when the description applies to this turn)\n${lines}\n`;
}

/** The full technique for one named skill, for the `loadSkill` tool's result. */
export function loadSkillBody(projectId: string, name: string): string | null {
  const skill = listSkills(projectId).find((s) => s.name === name);
  return skill ? skill.body : null;
}

/** Names only — for validating the `loadSkill` tool's `name` argument. */
export function skillNames(projectId: string): string[] {
  return listSkills(projectId).map((s) => s.name);
}
