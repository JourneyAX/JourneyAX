/**
 * Turns the agent on for a tenant through the route the back office uses: project settings -> publication gate -> pack.
 * Because the settings live on the project, the next ordinary publish keeps them (a pack written straight to the
 * database would be undone by it). Nothing is written to the live databases without --apply; the plan rehearses the
 * whole sequence on an in-memory copy of the project and prints what would change.
 *
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/apply-agent-pack.ts <tenant>
 *        [--environment production] [--apply] [--demo-prices] [--okf-draft <file> --okf-version <x.y.z>]
 *
 * Inputs are data files: docs/agent-instructions/<tenant>-draft.json (agents, persona, profile, conversation policy),
 * docs/agent-instructions/<tenant>-agent-settings.json (reply style, agent mode, routing), and
 * docs/migrations/<tenant>-catalog-mapping.json.
 */
import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb } from '@journeyax/test-support';
import { PackRepository, computePackChecksum } from '@journeyax/business-pack';
import { ReleaseActivationRepository } from '@journeyax/database';
import { ProjectService } from '../../apps/project-service/src/project.service';
import { OkfAuthoringService } from '../../apps/project-service/src/okf-authoring.service';
import { PublicationGateValidator } from '../../apps/project-service/src/publication-gate-validator';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const TENANT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : '').toLowerCase();
if (!TENANT) throw new Error('usage: apply-agent-pack.ts <tenant> [--environment production] [--apply] [--okf-draft <file> --okf-version <x.y.z>]');
const ENVIRONMENT = (option('environment') || 'production') as 'dev' | 'test' | 'staging' | 'production';
const APPLY = flag('apply');
/** Demo project only: a product with no real price gets a made-up, always-the-same one (never "Price on request"). Off unless asked for; see docs/migrations/DEMO-PRICES.md. */
const DEMO_PRICES = flag('demo-prices');
const ACTOR = 'process:claude-code';
const NOTE = `Agent pack applied by Claude Code on the owner's instruction in chat (mahaveer.it@gmail.com), ${new Date().toISOString().slice(0, 10)}`;
const root = path.resolve(__dirname, '../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const log = (line = '') => console.log(line);
const section = (title: string) => log(`\n── ${title} ${'─'.repeat(Math.max(2, 78 - title.length))}`);
const isPlain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const deepMerge = (...parts: Array<Record<string, unknown> | undefined>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const part of parts) for (const [key, value] of Object.entries(part ?? {})) out[key] = isPlain(value) && isPlain(out[key]) ? deepMerge(out[key] as any, value) : value;
  return out;
};
const redact = (value: any): any => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, /secret|token|password|api[-_]?key|credential|authorization/i.test(key) ? '[redacted]' : redact(inner)]));
  }
  return value;
};

interface Services { projects: ProjectService; authoring: OkfAuthoringService; runtimeDb: any; projectDb: any; runtimeClient: any }
function wire(projectDb: any, runtimeDb: any, runtimeClient: any, gate: PublicationGateValidator): Services {
  const projects = new ProjectService(gate);
  Object.assign(projects as any, {
    db: projectDb, runtimeDb, projectsCol: projectDb.collection('tenant_configs'), membersCol: projectDb.collection('project_members'),
    teamsCol: projectDb.collection('project_teams'), rulesCol: projectDb.collection('business_rules'), versionsCol: projectDb.collection('config_versions'),
    isConnected: true,
  });
  const authoring = new OkfAuthoringService(async () => runtimeDb, (pid, update) => projects.updateProject(pid, update as any));
  return { projects, authoring, runtimeDb, projectDb, runtimeClient };
}
const memoryGate = () => new PublicationGateValidator(async () => {
  const db = new MemoryDb();
  for (const [name, spec] of [['business_pack_releases', { tenantId: 1, environmentId: 1, version: 1 }]] as const) await db.collection(name).createIndex(spec as any, { unique: true });
  return { db: db as any, client: (db as any).client, cleanup: () => undefined };
});

/** What the project should say after this run, built only from the tenant's data files. */
function buildSettings(project: any) {
  const draft = read(`docs/agent-instructions/${TENANT}-draft.json`);
  const settingsFile = existsSync(path.join(root, `docs/agent-instructions/${TENANT}-agent-settings.json`)) ? read(`docs/agent-instructions/${TENANT}-agent-settings.json`) : {};
  const mappingFile = existsSync(path.join(root, `docs/migrations/${TENANT}-catalog-mapping.json`)) ? read(`docs/migrations/${TENANT}-catalog-mapping.json`) : { catalogMapping: {} };
  const dto: Record<string, unknown> = {
    agents: draft.agents.map((agent: any) => (settingsFile.journeyPlaybook && agent.agentId === draft.defaultAgentId ? { ...agent, journeyPlaybook: settingsFile.journeyPlaybook } : agent)),
    profile: deepMerge(project.profile, draft.profile),
    persona: draft.persona,
    ...(Array.isArray(draft.skills) ? { skills: draft.skills } : {}),
    ...(draft.extensions && typeof draft.extensions === 'object' ? { extensions: draft.extensions } : {}),
    conversationPolicy: deepMerge(project.conversationPolicy, draft.conversationPolicy),
    catalogMapping: deepMerge(project.catalogMapping, mappingFile.catalogMapping, settingsFile.catalogMapping, DEMO_PRICES ? { pricing: { demoFallback: { enabled: true, currency: 'NZD', min: 4.9, max: 480 } } } : undefined),
    agentMode: settingsFile.agentMode ?? true,
    ...(settingsFile.modelPolicyOverrides ? { ai: { policyOverrides: deepMerge(project.ai?.policyOverrides, settingsFile.modelPolicyOverrides) } } : {}),
    ...(settingsFile.interpretationPolicy ? { interpretationPolicy: settingsFile.interpretationPolicy } : {}),
    ...(settingsFile.routingPolicy ? { routingPolicy: deepMerge(project.routingPolicy, settingsFile.routingPolicy) } : {}),
  };
  return { dto, draft };
}

async function change(s: Services, dto: Record<string, unknown>, okf?: { content: any; version: string }) {
  if (okf) {
    const existing = await s.authoring.getDraft(TENANT, ENVIRONMENT);
    const saved = await s.authoring.saveDraft({ projectId: TENANT, environmentId: ENVIRONMENT, expectedRevision: existing?.revision ?? 0, content: okf.content, updatedBy: ACTOR });
    if (!saved.validation.valid) throw new Error(`OKF draft is not valid: ${JSON.stringify(saved.validation.issues.slice(0, 3))}`);
    const released = await s.authoring.publishDraft({ projectId: TENANT, environmentId: ENVIRONMENT, expectedRevision: saved.revision, version: okf.version, publishedBy: ACTOR, notes: NOTE });
    log(`  OKF release ${released.release.releaseId} published (${released.release.checksum.slice(0, 12)}…)`);
  }
  const updated = await s.projects.updateProject(TENANT, dto as any);
  if (!updated.success) throw new Error(`project settings were refused: ${updated.message}`);
  const publication = await s.projects.publishConfig(TENANT, { environmentId: ENVIRONMENT, publishedBy: ACTOR, note: NOTE });
  if (!publication.success) throw new Error(`pack was not published: ${publication.message}`);
  return publication;
}

const brief = (pack: any) => ({
  version: pack?.manifest?.version,
  agentMode: pack?.extensions?.agentMode ?? pack?.extensions?.dialoguePolicy?.agentMode ?? false,
  agents: (pack?.agents ?? []).map((a: any) => `${a.agentId}${a.isDefault ? '*' : ''}${a.toolFirst ? ' toolFirst' : ''} (${(a.allowedTools ?? []).length} tools)`),
  defaultAgentId: pack?.defaultAgentId ?? pack?.routingPolicy?.defaultAgentId ?? null,
  replyStyle: pack?.extensions?.interpretationPolicy?.replyStyle ? { maxSentences: pack.extensions.interpretationPolicy.replyStyle.maxSentences, maxQuestions: pack.extensions.interpretationPolicy.replyStyle.maxQuestions, dropListLines: pack.extensions.interpretationPolicy.replyStyle.dropListLines } : '(platform defaults)',
  mapping: Object.keys(pack?.catalogMapping ?? {}),
  calculators: (pack?.calculators ?? []).map((c: any) => c.calculatorId),
  knowledge: pack?.knowledgeModel ? `${pack.knowledgeModel.releaseId}` : null,
  conversationPolicyKeys: Object.keys(pack?.conversationPolicy ?? {}),
});

async function main() {
  log(`apply-agent-pack  tenant=${TENANT}  environment=${ENVIRONMENT}  mode=${APPLY ? 'APPLY (writes)' : 'PLAN (reads only; rehearsal in memory)'}`);
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
  const packs = new PackRepository(runtimeDb);
  let livePack: any = null;
  try { livePack = await packs.loadActivePack(TENANT, ENVIRONMENT); } catch (error: any) { log(`  ! the active pack ${pointer?.activeVersion} cannot be loaded by the runtime: ${String(error.message).slice(0, 300)}`); }
  log(`  config version ${project.activeVersion}; active pack ${pointer?.activeVersion} (revision ${pointer?.revision})`);
  log(`  before: ${JSON.stringify(brief(livePack))}`);

  section('2. The change');
  const { dto } = buildSettings(project);
  const okfFile = option('okf-draft'); const okfVersion = option('okf-version');
  const okf = okfFile ? { content: JSON.parse(readFileSync(path.resolve(okfFile), 'utf8')), version: okfVersion! } : undefined;
  if (okfFile && !okfVersion) throw new Error('--okf-draft needs --okf-version');
  log(`  project settings to set: ${Object.keys(dto).join(', ')}${okf ? `; OKF release ${okfVersion} (${okf.content.concepts.length} concepts, ${okf.content.evidenceChunks.length} evidence chunks)` : ''}`);

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
    const result = await change(rehearsal, dto, okf);
    rehearsedPack = await new PackRepository(copyRuntime).loadActivePack(TENANT, ENVIRONMENT);
    log(`  ✓ published through the real publication gate as pack ${result.version ?? rehearsedPack?.manifest?.version}`);
    log(`  after:  ${JSON.stringify(brief(rehearsedPack))}`);
  } catch (error: any) {
    log(`  ✗ BLOCKER: the rehearsal failed: ${error.message}`);
    process.exitCode = 1; return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(root, 'logs', 'backups', `${TENANT}-${ENVIRONMENT}-agent-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(path.join(backupDir, 'before.json'), `${JSON.stringify(redact({ takenAt: new Date().toISOString(), project, pointer }), null, 1)}\n`);
  log(`\n  backup written to ${path.relative(root, backupDir)}/before.json`);
  if (!APPLY) { log('\n  Nothing was written to the live databases. Re-run with --apply to make the change.'); return; }

  section('4. Apply to the live databases');
  const live = wire(projectDb, runtimeDb, runtimeClient, memoryGate());
  const publication = await change(live, dto, okf);
  const after: any = await runtimeDb.collection('business_pack_pointers').findOne({ tenantId: TENANT, environmentId: ENVIRONMENT });
  const activation = await new ReleaseActivationRepository(async () => ({ db: runtimeDb, client: runtimeClient })).getReleaseActivation(TENANT, ENVIRONMENT);
  const newPack: any = await new PackRepository(runtimeDb).loadActivePack(TENANT, ENVIRONMENT);
  log(`  ✓ live pack is now ${after?.activeVersion} (checksum ${computePackChecksum(newPack).slice(0, 12)}…); activation ${activation?.status} for ${activation?.approvedReleaseVersion}`);
  log(`  after:  ${JSON.stringify(brief(newPack))}`);
  writeFileSync(path.join(backupDir, 'after.json'), `${JSON.stringify(redact({ takenAt: new Date().toISOString(), publication, pointer: after, activation }), null, 1)}\n`);
  log(`\n  To undo: npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/okf/apply-tenant-release.ts ${TENANT} --rollback ${project.activeVersion} --apply`);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => { console.error(`\n✗ ${error.message}`); process.exit(1); });
