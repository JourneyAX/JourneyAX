/**
 * Loads a tenant's authored OKF release and catalogue mapping into the environment its services run against, the way the back office
 * would, in small checked steps. It never runs a write without `--apply`.
 *
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/okf/apply-tenant-release.ts <tenant> [--environment production] [--version 1.1.0] [--apply]
 *
 * Without `--apply` (the plan) it only READS the live cluster, then rehearses the whole sequence — mapping, draft, immutable release,
 * Business Pack publication through the real publication gate — on an in-memory copy of the tenant's project document, and writes a
 * backup of what is there now to logs/backups/. With `--apply` it repeats the sequence against the live databases, then verifies the
 * result by reading it back: the stored release, the pack the runtime would load, the activation record, and the full coverage
 * evaluation run on the stored release.
 *
 * Inputs are the tenant's committed files: scripts/okf/tenants/<tenant>.{ingest,authoring,scenarios}.json, the newest
 * docs/inventory/<tenant>-taxonomy-snapshot-*.json and docs/migrations/<tenant>-{catalog-mapping,component-category-rules}.json.
 */
import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb } from '@journeyax/test-support';
import { PackRepository, computePackChecksum } from '@journeyax/business-pack';
import { ReleaseActivationRepository } from '@journeyax/database';
import {
  applyAuthoring, attachAcceptanceScenarios, buildTaxonomyDraft, evaluateCoverage, loadPinnedOkfRelease, resolveOkfGate,
} from '@journeyax/knowledge';
import { ProjectService } from '../../apps/project-service/src/project.service';
import { OkfAuthoringService } from '../../apps/project-service/src/okf-authoring.service';
import { KnowledgeInsightService } from '../../apps/project-service/src/knowledge-insight.service';
import { PublicationGateValidator } from '../../apps/project-service/src/publication-gate-validator';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const TENANT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : '').toLowerCase();
if (!TENANT) throw new Error('usage: apply-tenant-release.ts <tenant> [--environment production] [--version x.y.z] [--apply]');
const ENVIRONMENT = (option('environment') || 'production') as 'dev' | 'test' | 'staging' | 'production';
const APPLY = flag('apply');
const ACTOR = 'process:claude-code';
const NOTE = 'Applied by Claude Code on the owner\'s explicit approval in chat (mahaveer.it@gmail.com), 2026-10-13';
const root = path.resolve(__dirname, '../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const log = (line = '') => console.log(line);
const section = (title: string) => log(`\n── ${title} ${'─'.repeat(Math.max(2, 78 - title.length))}`);

const blockers: string[] = [];
const warnings: string[] = [];
const block = (message: string) => { blockers.push(message); log(`  ✗ BLOCKER: ${message}`); };
const warn = (message: string) => { warnings.push(message); log(`  ! ${message}`); };
const ok = (message: string) => log(`  ✓ ${message}`);

/** Keeps a backup useful without copying credentials into a file. */
const redact = (value: any): any => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, /secret|token|password|api[-_]?key|credential|authorization/i.test(key) ? '[redacted]' : redact(inner)]));
  }
  return value;
};

const isPlain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const deepMerge = (...parts: Array<Record<string, unknown> | undefined>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const part of parts) for (const [key, value] of Object.entries(part ?? {})) out[key] = isPlain(value) && isPlain(out[key]) ? deepMerge(out[key] as any, value) : value;
  return out;
};

const newestFile = (dir: string, pattern: RegExp) => {
  const names = readdirSync(path.join(root, dir)).filter((name) => pattern.test(name)).sort();
  if (!names.length) throw new Error(`no ${pattern} in ${dir}`);
  return `${dir}/${names[names.length - 1]}`;
};

// ── The tenant's inputs, exactly as the tests use them ───────────────────────────────────────────────
const snapshotFile = newestFile('docs/inventory', new RegExp(`^${TENANT}-taxonomy-snapshot-.*\\.json$`));
const snapshot = read(snapshotFile);
const ingest = read(`scripts/okf/tenants/${TENANT}.ingest.json`);
const authoringSpec = read(`scripts/okf/tenants/${TENANT}.authoring.json`);
const scenarioFile = read(`scripts/okf/tenants/${TENANT}.scenarios.json`);
const mappingFile = existsSync(path.join(root, `docs/migrations/${TENANT}-catalog-mapping.json`)) ? read(`docs/migrations/${TENANT}-catalog-mapping.json`) : { catalogMapping: {} };
const rulesFile = existsSync(path.join(root, `docs/migrations/${TENANT}-component-category-rules.json`)) ? read(`docs/migrations/${TENANT}-component-category-rules.json`) : { catalogMapping: {} };
const routingFile: { routingPolicy?: { defaultJourneyId: string; fallbackOnCatalogSearch?: boolean } } = existsSync(path.join(root, `docs/migrations/${TENANT}-routing-policy.json`)) ? read(`docs/migrations/${TENANT}-routing-policy.json`) : {};

function authoredDraft() {
  const authored = applyAuthoring(buildTaxonomyDraft(snapshot, ingest), authoringSpec);
  if (authored.errors?.length) throw new Error(`authoring spec has errors: ${JSON.stringify(authored.errors.slice(0, 3))}`);
  const attached = attachAcceptanceScenarios(authored.draft, scenarioFile);
  if (attached.errors?.length) throw new Error(`scenarios have errors: ${JSON.stringify(attached.errors.slice(0, 3))}`);
  return { ...authored.draft, acceptanceScenarios: attached.scenarios } as any;
}

const nextVersion = (existing: string[]): string => {
  const parsed = existing.map((version) => version.split('.').map(Number)).filter((parts) => parts.length === 3 && parts.every(Number.isFinite));
  if (!parsed.length) return '1.0.0';
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [major, minor] = parsed[parsed.length - 1];
  return `${major}.${minor + 1}.0`;
};

interface Services { projects: ProjectService; authoring: OkfAuthoringService; insight: KnowledgeInsightService; runtimeDb: any; projectDb: any; runtimeClient: any }

/** The real services, wired as project.module.ts wires them, over the given databases. */
function wire(projectDb: any, runtimeDb: any, runtimeClient: any, gate: PublicationGateValidator): Services {
  const projects = new ProjectService(gate);
  Object.assign(projects as any, {
    db: projectDb, runtimeDb, projectsCol: projectDb.collection('tenant_configs'), membersCol: projectDb.collection('project_members'),
    teamsCol: projectDb.collection('project_teams'), rulesCol: projectDb.collection('business_rules'), versionsCol: projectDb.collection('config_versions'),
    isConnected: true,
  });
  const authoring = new OkfAuthoringService(async () => runtimeDb, (pid, update) => projects.updateProject(pid, update as any));
  const insight = new KnowledgeInsightService(async () => runtimeDb, (pid) => projects.getProject(pid), authoring);
  return { projects, authoring, insight, runtimeDb, projectDb, runtimeClient };
}

const memoryGate = () => new PublicationGateValidator(async () => {
  const db = new MemoryDb();
  for (const [name, spec] of [['business_pack_releases', { tenantId: 1, environmentId: 1, version: 1 }]] as const) await db.collection(name).createIndex(spec as any, { unique: true });
  return { db: db as any, client: (db as any).client, cleanup: () => undefined };
});

/** The sequence a person would follow in the back office. The same function rehearses and applies. */
async function release(services: Services, version: string, mapping: Record<string, unknown>, draft: any, routingPolicy?: Record<string, unknown>) {
  const { projects, authoring } = services;
  const existing = await authoring.getDraft(TENANT, ENVIRONMENT);
  const saved = await authoring.saveDraft({ projectId: TENANT, environmentId: ENVIRONMENT, expectedRevision: existing?.revision ?? 0, content: draft, updatedBy: ACTOR });
  if (!saved.validation.valid) throw new Error(`draft is not valid: ${JSON.stringify(saved.validation.issues.slice(0, 3))}`);
  const okf = await authoring.publishDraft({ projectId: TENANT, environmentId: ENVIRONMENT, expectedRevision: saved.revision, version, publishedBy: ACTOR, notes: NOTE });
  // The mapping is saved last, immediately before the publication that consumes it, so a failure earlier leaves the project untouched.
  const mapped = await projects.updateProject(TENANT, { catalogMapping: mapping, ...(routingPolicy ? { routingPolicy } : {}) } as any);
  if (!mapped.success) throw new Error(`catalogue mapping / default journey were not saved: ${mapped.message}`);
  const publication = await projects.publishConfig(TENANT, { environmentId: ENVIRONMENT, publishedBy: ACTOR, note: NOTE });
  if (!publication.success) throw new Error(`Business Pack was not published: ${publication.message}`);
  return { saved, okf, publication };
}

/** Reads back what was stored and proves it, without writing. */
async function verify(services: Services, expected: { releaseChecksum: string }, label: string) {
  section(`Verify ${label}`);
  const { runtimeDb } = services;
  const packs = new PackRepository(runtimeDb);
  const pack: any = await packs.loadActivePack(TENANT, ENVIRONMENT);
  const packChecksum = computePackChecksum(pack);
  ok(`the runtime loads pack ${pack.manifest.version} (checksum ${packChecksum.slice(0, 12)}…) through its own verifier`);
  const reference = pack.knowledgeModel;
  if (reference?.checksum === expected.releaseChecksum && reference.required === true && reference.failurePolicy === 'fail_closed') ok(`it is bound to the new OKF release ${reference.releaseId} (${reference.checksum.slice(0, 12)}…), required and fail-closed`);
  else block(`the pack's knowledge reference is not the new release: ${JSON.stringify(reference && { releaseId: reference.releaseId, required: reference.required })}`);
  ok(`it carries ${Object.keys(pack.factRegistry?.facts ?? {}).length} facts and a catalogue mapping (${pack.catalogMapping ? 'present' : 'ABSENT'})`);
  if (!pack.catalogMapping) block('the pack has no catalogue mapping');

  const activation = await new ReleaseActivationRepository(async () => ({ db: runtimeDb, client: services.runtimeClient })).getReleaseActivation(TENANT, ENVIRONMENT);
  if (!activation) warn('there is no release activation record for this environment: the runtime will refuse every request until a person approves the release');
  else if (activation.approvedReleaseChecksum === packChecksum && activation.approvedReleaseVersion === pack.manifest.version && ['migrated', 'canary'].includes(activation.status)) ok(`activation is ${activation.status} for exactly this release (revision ${activation.revision})`);
  else warn(`activation does not serve this release (status ${activation.status}, approves ${activation.approvedReleaseVersion}): approve it explicitly before testing`);

  const { release: stored } = await loadPinnedOkfRelease(runtimeDb, { tenantId: TENANT, environmentId: ENVIRONMENT, releaseId: reference.releaseId, version: reference.version, checksum: reference.checksum });
  ok(`the stored OKF release verifies (${stored.content.concepts.length} concepts, ${stored.content.relationships.length} relationships, ${stored.content.verifications.length} verified claims)`);
  const evaluated = evaluateCoverage(stored.content, {
    tenantId: TENANT, now: new Date(), catalogue: snapshot.rows.map((row: any) => ({ path: row.path, category: row.category, products: row.productCount })),
    acceptedRoutingCollisions: scenarioFile.acceptedRoutingCollisions,
  });
  if (evaluated.report.totals.failed === 0 && evaluated.report.gaps.length === 0) ok(`coverage evaluation on the stored release: ${evaluated.report.totals.passed} of ${evaluated.report.totals.scenarios} scenarios hold, no gaps`);
  else block(`coverage evaluation on the stored release: ${evaluated.report.totals.failed} failing, ${evaluated.report.gaps.length} gaps`);
  for (const message of ['wood screws', 'my bathroom is leaking', 'how do i install a vanity', 'i want to build a deck']) {
    const decision: any = resolveOkfGate(stored.content, { tenantId: TENANT, environmentId: ENVIRONMENT, releaseId: reference.releaseId, now: new Date(), message, knowledgeAvailability: { available: true, required: true, failurePolicy: 'fail_closed' } } as any);
    log(`    "${message}" → ${decision.mode}; products ${decision.retrieval.permission}; checkout ${decision.commerce.checkout}`);
  }
  return { pack, packChecksum, activation };
}

async function main() {
  log(`apply-tenant-release  tenant=${TENANT}  environment=${ENVIRONMENT}  mode=${APPLY ? 'APPLY (writes)' : 'PLAN (reads only; rehearsal in memory)'}`);
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const { connectToDatabase } = await import('@journeyax/database');
  const projectName = process.env.PROJECT_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyax';
  const runtimeName = process.env.RUNTIME_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx';
  const { db: projectDb } = await connectToDatabase(uri, projectName);
  const { db: runtimeDb, client: runtimeClient } = await connectToDatabase(uri, runtimeName);
  log(`databases: project=${projectName}  runtime=${runtimeName}  (cluster host: ${uri.match(/@([^/?]+)/)?.[1] ?? 'unknown'})`);

  // ── 1. What is there now (read-only) ───────────────────────────────────────────────────────────────
  section('1. What is live now');
  const project: any = await projectDb.collection('tenant_configs').findOne({ projectId: TENANT });
  if (!project) { block(`no project '${TENANT}' in ${projectName}.tenant_configs`); throw new Error(blockers.join('; ')); }
  ok(`project '${TENANT}' found (config version ${project.activeVersion ?? '—'}, updated ${project.updatedAt})`);
  if (project.pricing?.currency) ok(`pricing.currency is ${project.pricing.currency}`); else block('the project does not state pricing.currency: publication would fail');
  if (project.ai?.provider && project.ai?.model) ok(`ai model is ${project.ai.provider}/${project.ai.model}`); else block('the project does not state ai.provider / ai.model');
  log(`  catalogue mapping now: ${project.catalogMapping ? 'present' : 'absent'}; knowledge reference now: ${project.knowledgeModel ? `${project.knowledgeModel.releaseId} (${project.knowledgeModel.version})` : 'none'}`);

  const pointer: any = await runtimeDb.collection('business_pack_pointers').findOne({ tenantId: TENANT, environmentId: ENVIRONMENT });
  const activation = await new ReleaseActivationRepository(async () => ({ db: runtimeDb, client: runtimeClient })).getReleaseActivation(TENANT, ENVIRONMENT);
  ok(`active pack: ${pointer ? `${pointer.activeVersion} (revision ${pointer.revision})` : 'none'}; activation: ${activation ? `${activation.status} for ${activation.approvedReleaseVersion}, revision ${activation.revision}` : 'no record'}`);
  if (!activation) warn('there is no activation record, so the runtime serves nothing until a person approves a release');
  else if (!['migrated', 'canary'].includes(activation.status)) warn(`activation status is '${activation.status}': a publication will not restart it; an explicit approval is needed`);

  const liveDraft: any = await runtimeDb.collection('okf_drafts').findOne({ tenantId: TENANT, environmentId: ENVIRONMENT });
  if (liveDraft) {
    const names = (liveDraft.content?.concepts ?? []).map((concept: any) => concept.name);
    log(`  OKF draft now: revision ${liveDraft.revision}, ${names.length} concepts (${names.join(', ')}), ${liveDraft.content?.verifications?.length ?? 0} verification records, last edited by ${liveDraft.updatedBy}`);
    if ((liveDraft.content?.verifications ?? []).length) block('the live draft holds verification records written by people; replacing it would discard them');
  } else log('  OKF draft now: none');
  const releases: any[] = await runtimeDb.collection('okf_releases').find({ tenantId: TENANT, environmentId: ENVIRONMENT }).toArray();
  const version = option('version') || nextVersion(releases.map((entry) => entry.version));
  if (releases.some((entry) => entry.version === version)) block(`OKF release version ${version} already exists`);
  ok(`the new OKF release will be version ${version} (existing: ${releases.map((entry) => entry.version).join(', ') || 'none'})`);
  const products = await runtimeDb.collection('products').countDocuments({ $or: [{ projectId: TENANT }, { tenantId: TENANT }] });
  ok(`${products} products belong to this tenant in ${runtimeName}.products`);

  // ── 2. The change ──────────────────────────────────────────────────────────────────────────────────
  section('2. The change');
  const mapping = deepMerge(project.catalogMapping, mappingFile.catalogMapping, rulesFile.catalogMapping);
  const draft = authoredDraft();
  // A routing policy the project already states is never overridden; only a missing one is filled from the tenant's file.
  const routingPolicy = project.routingPolicy?.defaultJourneyId ? undefined : routingFile.routingPolicy;
  if (project.routingPolicy?.defaultJourneyId) ok(`the project already states its default journey (${project.routingPolicy.defaultJourneyId}); it is kept`);
  else if (routingPolicy) warn(`the project states no default journey; this will set it to '${routingPolicy.defaultJourneyId}' from docs/migrations/${TENANT}-routing-policy.json — requests no other journey matches go there. Edit that file first if you want a different one.`);
  else log('  the project states no default journey and the tenant has no routing-policy file: publication will be refused if it has several journeys');
  log(`  catalogue mapping: ${Object.keys(mapping).join(', ')} (merged with the saved mapping, the repo's price/currency mapping and category rules)`);
  log(`  authored draft: ${draft.concepts.length} concepts, ${draft.relationships.length} relationships, ${draft.factRegistry.length} facts, ${draft.acceptanceScenarios.length} acceptance scenarios, 0 verified claims`);
  const replaced = (liveDraft?.content?.concepts ?? []).map((concept: any) => concept.name);
  const authoredNames = new Set(draft.concepts.map((concept: any) => String(concept.name).toLowerCase()));
  const dropped = replaced.filter((name: string) => !authoredNames.has(String(name).toLowerCase()));
  if (dropped.length) warn(`the existing draft's concept(s) ${dropped.join(', ')} have no concept of that name in the new draft (they are backed up)`); else if (replaced.length) ok(`every concept of the existing draft has a counterpart of the same name in the new one`);

  // ── 3. The catalogue mapping against the real products (read-only) ──────────────────────────────────
  section('3. Does the mapping read the real products?');
  const readOnly = wire(projectDb, runtimeDb, runtimeClient, memoryGate());
  const check = await readOnly.insight.checkCatalogMapping(TENANT, mapping, { sample: 400 });
  log(`  sample of ${check.sampleSize} of ${check.catalogueProducts} products; readable: ${Object.entries(check.readable).map(([key, share]) => `${key} ${Math.round((share as number) * 100)}%`).join(', ')}`);
  log(`  currencies: ${JSON.stringify(check.currencies)}; availability: ${JSON.stringify(check.availability)}`);
  const priceFields = (check.fields as any[]).filter((field) => /price|msrp|cost|amount|rrp|sell/i.test(String(field.path))).slice(0, 8);
  if (priceFields.length) log(`  price-like fields found on these products: ${priceFields.map((field) => `${field.path} (${field.count ?? field.products ?? '?'})`).join(', ')}`);
  for (const issue of check.issues) log(`  ${issue.severity === 'error' ? '✗' : '!'} [${issue.severity}] ${issue.message} (${issue.affected} products${issue.examples?.length ? `; e.g. ${issue.examples.join(', ')}` : ''})`);
  if (check.ok) ok('the mapping has no error-level issue'); else block('the catalogue mapping has error-level issues');

  // ── 4. Rehearsal on a copy (in memory) ──────────────────────────────────────────────────────────────
  section('4. Rehearsal on an in-memory copy of the project');
  const copyProject = new MemoryDb();
  const copyRuntime = new MemoryDb();
  for (const [name, spec] of [['business_pack_releases', { tenantId: 1, environmentId: 1, version: 1 }], ['config_versions', { projectId: 1, version: 1 }]] as const) {
    await (name === 'config_versions' ? copyProject : copyRuntime).collection(name).createIndex(spec as any, { unique: true });
  }
  const { _id: _ignored, ...projectCopy } = project;
  await copyProject.collection('tenant_configs').insertOne(JSON.parse(JSON.stringify(projectCopy)));
  const rehearsal = wire(copyProject, copyRuntime, (copyRuntime as any).client, memoryGate());
  try {
    const rehearsed = await release(rehearsal, version, mapping, draft, routingPolicy);
    ok(`published OKF release ${rehearsed.okf.release.releaseId} (${rehearsed.okf.release.checksum.slice(0, 12)}…) and Business Pack through the real publication gate`);
    await verify(rehearsal, { releaseChecksum: rehearsed.okf.release.checksum }, 'the rehearsal');
  } catch (error: any) {
    block(`the rehearsal failed: ${error.message}`);
  }

  // ── 5. Backup (read-only on the cluster) ────────────────────────────────────────────────────────────
  const backupDir = path.join(root, 'logs', 'backups', `${TENANT}-${ENVIRONMENT}-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  const configVersions = await projectDb.collection('config_versions').find({ projectId: TENANT }).sort({ version: -1 }).limit(3).toArray();
  const backup: Record<string, unknown> = {
    note: 'Taken immediately before a change; credentials are redacted. Restore the touched fields (catalogMapping, knowledgeModel, factRegistry), the OKF draft and the pack pointer from here.',
    takenAt: new Date().toISOString(), tenant: TENANT, environment: ENVIRONMENT,
    project, pointer, activation, okfDraft: liveDraft, okfReleases: releases.map(({ content, ...rest }) => rest), configVersions: configVersions.map(({ config, ...rest }: any) => rest),
  };
  writeFileSync(path.join(backupDir, 'before.json'), `${JSON.stringify(redact(backup), null, 1)}\n`);
  section('5. Backup');
  ok(`written to ${path.relative(root, backupDir)}/before.json`);
  const rollbackTarget = configVersions[0]?.version;

  section('Plan result');
  log(`  blockers: ${blockers.length}   warnings: ${warnings.length}`);
  if (!APPLY) { log('\n  Nothing was written to the live databases. Re-run with --apply to make the change.'); return; }
  if (blockers.length) throw new Error(`refusing to apply with blockers:\n  - ${blockers.join('\n  - ')}`);

  // ── 6. Apply ───────────────────────────────────────────────────────────────────────────────────────
  section('6. Apply to the live databases');
  const live = wire(projectDb, runtimeDb, runtimeClient, memoryGate());
  const result = await release(live, version, mapping, draft, routingPolicy);
  ok(`saved the draft (revision ${result.saved.revision}), published OKF release ${result.okf.release.releaseId} ${version} (${result.okf.release.checksum.slice(0, 12)}…)`);
  ok(`published the Business Pack as config version ${result.publication.version}`);
  blockers.length = 0;
  const after = await verify(live, { releaseChecksum: result.okf.release.checksum }, 'the live result');
  writeFileSync(path.join(backupDir, 'after.json'), `${JSON.stringify(redact({ takenAt: new Date().toISOString(), version, releaseChecksum: result.okf.release.checksum, packVersion: after.pack.manifest.version, packChecksum: after.packChecksum, activation: after.activation }), null, 1)}\n`);
  section('Done');
  log(`  Backup and result: ${path.relative(root, backupDir)}/`);
  log(`  A running service may keep the previous pack for a few minutes (its cache); restart it to see the change at once.`);
  log(`  To undo: roll the project back to config version ${rollbackTarget ?? '(previous)'} in the Studio (Versions → Roll back), or run`);
  log(`    projects.rollbackConfig('${TENANT}', ${rollbackTarget ?? '<previous>'}, '<you>', '${ENVIRONMENT}')`);
  if (blockers.length) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => { console.error(`\n✗ ${error.message}`); process.exit(1); });
