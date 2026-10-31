/**
 * Changes only the model a tenant's assistant answers with, through the route the back office uses: project AI settings -> publication
 * gate -> a new pack release. Nothing else about the pack changes, and the script checks that: it rehearses the whole sequence on an
 * in-memory copy of the live project and refuses to write if anything other than the model policy (and the release's own manifest)
 * would differ from the pack that is live today. Nothing is written to the live databases without --apply.
 *
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/switch-model.ts <tenant>
 *        --provider anthropic --model claude-sonnet-5-5 [--fallback-provider anthropic --fallback-model claude-haiku-4-5]
 *        [--environment production] [--apply]
 *
 * To undo: apply-tenant-release.ts <tenant> --rollback <the config version printed as "live now"> --apply
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const PROVIDER = option('provider'); const MODEL = option('model');
const FALLBACK_PROVIDER = option('fallback-provider') ?? ''; const FALLBACK_MODEL = option('fallback-model') ?? '';
if (!TENANT || !PROVIDER || !MODEL) throw new Error('usage: switch-model.ts <tenant> --provider <p> --model <m> [--fallback-provider <p> --fallback-model <m>] [--environment production] [--apply]');
const ENVIRONMENT = (option('environment') || 'production') as 'dev' | 'test' | 'staging' | 'production';
const APPLY = flag('apply');
const ACTOR = 'process:claude-code';
const NOTE = `Model switched to ${PROVIDER}/${MODEL} by Claude Code on the owner's instruction in chat (mahaveer.it@gmail.com), ${new Date().toISOString().slice(0, 10)}; nothing else changed`;
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
const policies = (pack: any) => (pack?.modelPolicy?.policies ?? []).map((p: any) => `${p.policyId}: ${(p.candidates ?? []).map((c: any) => `${c.provider}/${c.model}${c.reasoningEffort ? ` (reasoning ${c.reasoningEffort})` : ''}`).join(' then ')}`);

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

const dto = { ai: { provider: PROVIDER, model: MODEL, fallbackProvider: FALLBACK_PROVIDER, fallbackModel: FALLBACK_MODEL } };

async function change(s: Services) {
  const updated = await s.projects.updateProject(TENANT, dto as any);
  if (!updated.success) throw new Error(`project settings were refused: ${updated.message}`);
  const publication = await s.projects.publishConfig(TENANT, { environmentId: ENVIRONMENT, publishedBy: ACTOR, note: NOTE });
  if (!publication.success) throw new Error(`pack was not published: ${publication.message}`);
  return publication;
}

async function main() {
  log(`switch-model  tenant=${TENANT}  environment=${ENVIRONMENT}  to ${PROVIDER}/${MODEL}${FALLBACK_MODEL ? ` (fallback ${FALLBACK_PROVIDER}/${FALLBACK_MODEL})` : ' (no fallback)'}  mode=${APPLY ? 'APPLY (writes)' : 'PLAN (reads only; rehearsal in memory)'}`);
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
  log(`  project AI settings: ${JSON.stringify(redact(project.ai))}`);
  log(`  live model policy:\n    ${policies(livePack).join('\n    ')}`);

  section('2. The change');
  log(`  project.ai.provider = ${PROVIDER}, project.ai.model = ${MODEL}, fallback = ${FALLBACK_MODEL ? `${FALLBACK_PROVIDER}/${FALLBACK_MODEL}` : 'none'}; every other setting is left as it is`);

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
    const result = await change(rehearsal);
    rehearsedPack = await new PackRepository(copyRuntime).loadActivePack(TENANT, ENVIRONMENT);
    log(`  ✓ published through the real publication gate as pack ${result.version ?? rehearsedPack?.manifest?.version}`);
    log(`  new model policy:\n    ${policies(rehearsedPack).join('\n    ')}`);
  } catch (error: any) {
    log(`  ✗ BLOCKER: the rehearsal failed: ${error.message}`);
    process.exitCode = 1; return;
  }

  section('4. Is anything else different from the live pack?');
  const keys = [...new Set([...Object.keys(livePack), ...Object.keys(rehearsedPack)])].sort();
  const differing = keys.filter((key) => stable(livePack[key]) !== stable(rehearsedPack[key]));
  const allowed = ['manifest', 'modelPolicy'];
  log(`  parts that differ: ${differing.join(', ') || 'none'}   (allowed: ${allowed.join(', ')})`);
  const unexpected = differing.filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    log(`  ✗ BLOCKER: ${unexpected.join(', ')} would also change. The live project settings have drifted from the live pack; nothing will be written.`);
    process.exitCode = 1; return;
  }
  log('  ✓ only the model policy and the release manifest differ');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(root, 'logs', 'backups', `${TENANT}-${ENVIRONMENT}-model-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(path.join(backupDir, 'before.json'), `${JSON.stringify(redact({ takenAt: new Date().toISOString(), project, pointer }), null, 1)}\n`);
  log(`\n  backup written to ${path.relative(root, backupDir)}/before.json`);
  if (!APPLY) { log('\n  Nothing was written to the live databases. Re-run with --apply to make the change.'); return; }

  section('5. Apply to the live databases');
  const live = wire(projectDb, runtimeDb, runtimeClient, memoryGate());
  const publication = await change(live);
  const after: any = await runtimeDb.collection('business_pack_pointers').findOne({ tenantId: TENANT, environmentId: ENVIRONMENT });
  const activation = await new ReleaseActivationRepository(async () => ({ db: runtimeDb, client: runtimeClient })).getReleaseActivation(TENANT, ENVIRONMENT);
  const newPack: any = await new PackRepository(runtimeDb).loadActivePack(TENANT, ENVIRONMENT);
  log(`  ✓ live pack is now ${after?.activeVersion} (checksum ${computePackChecksum(newPack).slice(0, 12)}…); activation ${activation?.status} for ${activation?.approvedReleaseVersion}`);
  log(`  model policy now:\n    ${policies(newPack).join('\n    ')}`);
  writeFileSync(path.join(backupDir, 'after.json'), `${JSON.stringify(redact({ takenAt: new Date().toISOString(), publication, pointer: after, activation }), null, 1)}\n`);
  log(`\n  To undo: npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/okf/apply-tenant-release.ts ${TENANT} --rollback ${project.activeVersion} --apply`);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => { console.error(`\n✗ ${error.message}`); process.exit(1); });
