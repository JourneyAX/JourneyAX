/**
 * Publishes the wording fixes from the hard-questions test, and nothing else, through the route the back office uses: project settings ->
 * publication gate -> a new pack release. It changes exactly:
 *   - the text of four skills (order-enquiry, case-queue-review, overdue-and-invoice-query, escalated-account-brief), taken from the draft file;
 *   - the customer service agent's prompt and hand-off conditions, and the sales agent's prompt, taken from the draft file;
 *   - the branch stock setting (extensions.branchStock), taken from the draft file.
 * It does NOT use apply-agent-pack.ts on purpose: that script writes the draft's whole `extensions` and the draft's model override, which would
 * replace the live connectors, dashboard and forms settings and put a model override back that the live pack no longer has.
 *
 * It rehearses the whole sequence on an in-memory copy of the live project and refuses to write if anything beyond those three things would
 * differ from the pack that is live today (the model policy included). Nothing is written to the live databases without --apply.
 *
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/publish-text-fixes.ts <tenant> [--environment production] [--apply]
 *
 * Run it from a checkout that already has this branch's code merged in (the project service must know the branchStock setting, which comes with
 * the business-pack package of the same checkout). From a side worktree the shared node_modules resolves @journeyax/business-pack to the main
 * checkout and the plan stops at 'Unknown pack extension branchStock'.
 *
 * To undo: apply-tenant-release.ts <tenant> --rollback <the config version printed as "live now"> --apply
 */
import 'reflect-metadata';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb } from '@journeyax/test-support';
import { PackRepository, computePackChecksum } from '@journeyax/business-pack';
import { ReleaseActivationRepository } from '@journeyax/database';
import { ProjectService } from '../../apps/project-service/src/project.service';
import { PublicationGateValidator } from '../../apps/project-service/src/publication-gate-validator';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const TENANT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : '').toLowerCase();
if (!TENANT) throw new Error('usage: publish-text-fixes.ts <tenant> [--environment production] [--apply]');
const ENVIRONMENT = (option('environment') || 'production') as 'dev' | 'test' | 'staging' | 'production';
const APPLY = flag('apply');
const ACTOR = 'process:claude-code';
const NOTE = `Wording fixes from the hard-questions test (three skills, the customer service prompt and hand-off lines, the branch stock setting), published by Claude Code on the owner's instruction in chat (mahaveer.it@gmail.com), ${new Date().toISOString().slice(0, 10)}; nothing else changed`;
const root = path.resolve(__dirname, '../..');
const log = (line = '') => console.log(line);
const section = (title: string) => log(`\n── ${title} ${'─'.repeat(Math.max(2, 78 - title.length))}`);
const redact = (value: any): any => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, /secret|token|password|api[-_]?key|credential|authorization/i.test(key) ? '[redacted]' : redact(inner)]));
  }
  return value;
};
/** Key order never matters when comparing two packs. */
const stable = (value: any): string => JSON.stringify(value, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner) && !(inner instanceof Date)
  ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner));
const policies = (pack: any) => (pack?.modelPolicy?.policies ?? []).map((p: any) => `${p.policyId}: ${(p.candidates ?? []).map((c: any) => `${c.provider}/${c.model}`).join(' then ')}`);

const SKILL_IDS = ['order-enquiry', 'case-queue-review', 'overdue-and-invoice-query', 'escalated-account-brief'];
/** The agents whose wording changes, and the only fields of each that may change. */
const AGENT_FIELDS: Record<string, string[]> = {
  placemakers_customer_service: ['systemPromptTemplate', 'handoffConditions'],
  placemakers_sales_quote: ['systemPromptTemplate'],
};
const draft =JSON.parse(readFileSync(path.join(root, `docs/agent-instructions/${TENANT}-draft.json`), 'utf8'));

interface Services { projects: ProjectService; runtimeDb: any; projectDb: any; runtimeClient: any }
function wire(projectDb: any, runtimeDb: any, runtimeClient: any, gate: PublicationGateValidator): Services {
  const projects = new ProjectService(gate);
  Object.assign(projects as any, {
    db: projectDb, runtimeDb, projectsCol: projectDb.collection('tenant_configs'), membersCol: projectDb.collection('project_members'),
    teamsCol: projectDb.collection('project_teams'), rulesCol: projectDb.collection('business_rules'), versionsCol: projectDb.collection('config_versions'),
    isConnected: true,
  });
  return { projects, runtimeDb, projectDb, runtimeClient };
}
const memoryGate = () => new PublicationGateValidator(async () => {
  const db = new MemoryDb();
  for (const [name, spec] of [['business_pack_releases', { tenantId: 1, environmentId: 1, version: 1 }]] as const) await db.collection(name).createIndex(spec as any, { unique: true });
  return { db: db as any, client: (db as any).client, cleanup: () => undefined };
});

/** The project settings after the change: the live project's own skills and agents with only the named text replaced, plus the branch stock setting. */
function settingsFor(project: any) {
  const skills: any[] = project?.extensions?.skills;
  const agents: any[] = project?.agents;
  if (!Array.isArray(skills) || !Array.isArray(agents)) throw new Error('the live project has no skills or agents list to change; nothing was done');
  const draftSkill = (id: string) => (draft.skills ?? []).find((s: any) => s.skillId === id);
  for (const id of SKILL_IDS) {
    if (!draftSkill(id)) throw new Error(`the draft has no skill '${id}'`);
    if (!skills.some((s) => s.skillId === id)) throw new Error(`the live project has no skill '${id}'`);
  }
  for (const id of Object.keys(AGENT_FIELDS)) {
    if (!(draft.agents ?? []).some((a: any) => a.agentId === id) || !agents.some((a) => a.agentId === id)) throw new Error(`agent '${id}' is missing from the draft or the live project`);
  }
  if (!draft.extensions?.branchStock) throw new Error('the draft has no extensions.branchStock');
  const fromDraft = (agent: any) => {
    const fields = AGENT_FIELDS[agent.agentId];
    if (!fields) return agent;
    const source = (draft.agents ?? []).find((a: any) => a.agentId === agent.agentId);
    return { ...agent, ...Object.fromEntries(fields.map((field) => [field, source[field]])) };
  };
  return {
    skills: skills.map((s) => (SKILL_IDS.includes(s.skillId) ? { ...s, description: draftSkill(s.skillId).description, instructions: draftSkill(s.skillId).instructions } : s)),
    agents: agents.map(fromDraft),
    extensions: { branchStock: draft.extensions.branchStock },
  };
}

async function change(s: Services, dto: Record<string, unknown>) {
  const updated = await s.projects.updateProject(TENANT, dto as any);
  if (!updated.success) throw new Error(`project settings were refused: ${updated.message}`);
  const publication = await s.projects.publishConfig(TENANT, { environmentId: ENVIRONMENT, publishedBy: ACTOR, note: NOTE });
  if (!publication.success) throw new Error(`pack was not published: ${publication.message}`);
  return publication;
}

/** What differs between two packs, as short paths: top-level parts, then the skills, agents and extension keys inside. */
function differences(before: any, after: any): string[] {
  const out: string[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    if (stable(before[key]) === stable(after[key])) continue;
    if (key === 'manifest' || key === 'modelPolicy') { out.push(key); continue; }
    if (key === 'agents') {
      const byId = (pack: any) => new Map<string, any>((pack ?? []).map((a: any) => [a.agentId, a]));
      const b = byId(before.agents); const a = byId(after.agents);
      for (const id of new Set([...b.keys(), ...a.keys()])) {
        if (stable(b.get(id)) === stable(a.get(id))) continue;
        const fields = Object.keys({ ...(b.get(id) ?? {}), ...(a.get(id) ?? {}) }).filter((f) => stable(b.get(id)?.[f]) !== stable(a.get(id)?.[f]));
        out.push(`agents.${id}.{${fields.join(',')}}`);
      }
      continue;
    }
    if (key === 'extensions') {
      for (const ext of new Set([...Object.keys(before.extensions ?? {}), ...Object.keys(after.extensions ?? {})])) {
        if (stable(before.extensions?.[ext]) === stable(after.extensions?.[ext])) continue;
        if (ext === 'skills') {
          const byId = (list: any) => new Map<string, any>((list ?? []).map((s: any) => [s.skillId, s]));
          const b = byId(before.extensions?.skills); const a = byId(after.extensions?.skills);
          for (const id of new Set([...b.keys(), ...a.keys()])) if (stable(b.get(id)) !== stable(a.get(id))) out.push(`extensions.skills.${id}`);
        } else out.push(`extensions.${ext}`);
      }
      continue;
    }
    out.push(key);
  }
  return out;
}
/** A difference is expected when it is the manifest, the branch stock setting, one of the named skills, or only the named fields of a named agent (any non-empty subset: a field already as in the draft is simply not listed). */
const ALLOWED_PLAIN = new Set(['manifest', 'extensions.branchStock', ...SKILL_IDS.map((id) => `extensions.skills.${id}`)]);
const isAllowed = (entry: string): boolean => {
  if (ALLOWED_PLAIN.has(entry)) return true;
  const m = /^agents\.([^.]+)\.\{([^}]*)\}$/.exec(entry);
  if (!m || !AGENT_FIELDS[m[1]]) return false;
  const fields = m[2].split(',').filter(Boolean);
  return fields.length > 0 && fields.every((field) => AGENT_FIELDS[m[1]].includes(field));
};

async function main() {
  log(`publish-text-fixes  tenant=${TENANT}  environment=${ENVIRONMENT}  mode=${APPLY ? 'APPLY (writes)' : 'PLAN (reads only; rehearsal in memory)'}`);
  const uri = process.env.MONGODB_URI; if (!uri) throw new Error('MONGODB_URI is required');
  const { connectToDatabase } = await import('@journeyax/database');
  const projectName = process.env.PROJECT_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyax';
  const runtimeName = process.env.RUNTIME_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx';
  const { db: projectDb } = await connectToDatabase(uri, projectName);
  const { db: runtimeDb, client: runtimeClient } = await connectToDatabase(uri, runtimeName);

  section('1. What is live now');
  const project: any = await projectDb.collection('tenant_configs').findOne({ projectId: TENANT });
  if (!project) throw new Error(`no project '${TENANT}' in ${projectName}.tenant_configs`);
  const pointer: any = await runtimeDb.collection('business_pack_pointers').findOne({ tenantId: TENANT, environmentId: ENVIRONMENT });
  const livePack: any = await new PackRepository(runtimeDb).loadActivePack(TENANT, ENVIRONMENT);
  log(`  config version live now: ${project.activeVersion}; active pack ${pointer?.activeVersion} (revision ${pointer?.revision})`);
  log(`  live model policy (left as it is):\n    ${policies(livePack).join('\n    ')}`);

  section('2. The change');
  const dto = settingsFor(project);
  log(`  skills with new text: ${SKILL_IDS.join(', ')}`);
  for (const [id, fields] of Object.entries(AGENT_FIELDS)) log(`  agent ${id}: ${fields.join(' and ')} from the draft`);
  log(`  extensions.branchStock: ${JSON.stringify({ connector: dto.extensions.branchStock.connector, tool: dto.extensions.branchStock.tool })}`);

  section('3. Rehearsal on an in-memory copy of the project');
  const copyProject = new MemoryDb(); const copyRuntime = new MemoryDb();
  for (const [name, spec] of [['business_pack_releases', { tenantId: 1, environmentId: 1, version: 1 }], ['config_versions', { projectId: 1, version: 1 }]] as const) await (name === 'config_versions' ? copyProject : copyRuntime).collection(name).createIndex(spec as any, { unique: true });
  const { _id: _ignored, ...projectCopy } = project;
  await copyProject.collection('tenant_configs').insertOne(JSON.parse(JSON.stringify(projectCopy)));
  // The pack points at an OKF release; the copy needs that release (read from the live database) so the gate can verify the reference.
  for (const name of ['okf_releases', 'okf_concepts', 'okf_relationships', 'okf_sources', 'okf_fact_definitions', 'okf_evidence_chunks', 'okf_verification_records', 'okf_evaluation_reports', 'okf_revocation_events', 'okf_verification_attestations']) {
    const docs = await runtimeDb.collection(name).find({ tenantId: TENANT, environmentId: ENVIRONMENT }).toArray().catch(() => []);
    if (docs.length) await (copyRuntime as any).collection(name).insertMany(JSON.parse(JSON.stringify(docs)).map(({ _id, ...rest }: any) => rest));
  }
  const rehearsal = wire(copyProject, copyRuntime, (copyRuntime as any).client, memoryGate());
  let rehearsedPack: any;
  try {
    const result = await change(rehearsal, dto);
    rehearsedPack = await new PackRepository(copyRuntime).loadActivePack(TENANT, ENVIRONMENT);
    log(`  ✓ published through the real publication gate as pack ${result.version ?? rehearsedPack?.manifest?.version}`);
  } catch (error: any) {
    log(`  ✗ BLOCKER: the rehearsal failed: ${error.message}`);
    process.exitCode = 1; return;
  }

  section('4. Is anything else different from the live pack?');
  const found = differences(livePack, rehearsedPack);
  log(`  parts that differ:\n    ${found.join('\n    ') || 'none'}`);
  const unexpected = found.filter((entry) => !isAllowed(entry));
  const missing = [...ALLOWED_PLAIN].filter((entry) => entry !== 'manifest' && !found.includes(entry));
  if (unexpected.length) {
    log(`  ✗ BLOCKER: ${unexpected.join(', ')} would also change. The live project settings have drifted from the live pack; nothing will be written.`);
    process.exitCode = 1; return;
  }
  if (missing.length) log(`  note: no change for ${missing.join(', ')} (already as in the draft)`);
  log('  ✓ only the named wording and the branch stock setting differ (the model policy is unchanged)');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(root, 'logs', 'backups', `${TENANT}-${ENVIRONMENT}-text-fixes-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(path.join(backupDir, 'before.json'), `${JSON.stringify(redact({ takenAt: new Date().toISOString(), project, pointer }), null, 1)}\n`);
  log(`\n  backup written to ${path.relative(root, backupDir)}/before.json`);
  if (!APPLY) { log('\n  Nothing was written to the live databases. Re-run with --apply to make the change.'); return; }

  section('5. Apply to the live databases');
  const live = wire(projectDb, runtimeDb, runtimeClient, memoryGate());
  const publication = await change(live, dto);
  const after: any = await runtimeDb.collection('business_pack_pointers').findOne({ tenantId: TENANT, environmentId: ENVIRONMENT });
  const activation = await new ReleaseActivationRepository(async () => ({ db: runtimeDb, client: runtimeClient })).getReleaseActivation(TENANT, ENVIRONMENT);
  const newPack: any = await new PackRepository(runtimeDb).loadActivePack(TENANT, ENVIRONMENT);
  log(`  ✓ live pack is now ${after?.activeVersion} (checksum ${computePackChecksum(newPack).slice(0, 12)}…); activation ${activation?.status} for ${activation?.approvedReleaseVersion}`);
  log(`  model policy now:\n    ${policies(newPack).join('\n    ')}`);
  writeFileSync(path.join(backupDir, 'after.json'), `${JSON.stringify(redact({ takenAt: new Date().toISOString(), publication, pointer: after, activation }), null, 1)}\n`);
  log(`\n  To undo: npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/okf/apply-tenant-release.ts ${TENANT} --rollback ${project.activeVersion} --apply`);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => { console.error(`\n✗ ${error.message}`); process.exit(1); });
