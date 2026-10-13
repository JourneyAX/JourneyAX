/**
 * READ-ONLY evidence inventory for one tenant. It never writes to the database.
 *
 *   node --env-file=.env --import tsx scripts/inventory/placemakers-inventory.ts [tenantId]
 *
 * Output: docs/inventory/<tenant>-inventory-<snapshot-date>.md (+ .json). Every figure names its source collection
 * and carries the snapshot timestamp so counts can be reconciled and re-run later.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectToDatabase } from '@journeyax/database';

const TENANT = (process.argv[2] || 'placemakers').toLowerCase();
const snapshotAt = new Date();
const stamp = snapshotAt.toISOString().slice(0, 10);

type Row = Record<string, unknown>;
const lines: string[] = [];
const out: Row = { tenant: TENANT, snapshotAt: snapshotAt.toISOString() };
const h = (text: string) => lines.push('', `## ${text}`, '');
const p = (text: string) => lines.push(text);
const table = (head: string[], rows: Array<Array<unknown>>) => {
  lines.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
  for (const row of rows) lines.push(`| ${row.map((cell) => String(cell ?? '—').replace(/\|/g, '\\|')).join(' | ')} |`);
  lines.push('');
};
const short = (value: unknown) => (typeof value === 'string' && value.length > 20 ? `${value.slice(0, 16)}…` : value);

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required (read-only use)');
  const runtimeName = process.env.RUNTIME_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx';
  const projectName = process.env.PROJECT_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyax';
  const { db: rdb } = await connectToDatabase(uri, runtimeName);
  const { db: pdb } = await connectToDatabase(uri, projectName);
  const owner = { $or: [{ projectId: TENANT }, { tenantId: TENANT }] };

  lines.push(`# ${TENANT} evidence inventory`, '', `Snapshot: **${snapshotAt.toISOString()}** (read-only). Databases: runtime=\`${runtimeName}\`, project=\`${projectName}\`.`);

  // ── Business Pack ────────────────────────────────────────────────
  h('1. Business Pack (source: `business_pack_pointers`, `business_pack_releases`)');
  const pointers = [
    ...(await rdb.collection('business_pack_pointers').find({ tenantId: TENANT }).toArray()).map((row: any) => ({ db: runtimeName, ...row })),
    ...(await pdb.collection('business_pack_pointers').find({ tenantId: TENANT }).toArray()).map((row: any) => ({ db: projectName, ...row })),
  ];
  table(['database', 'environment', 'active version', 'revision', 'status'], pointers.map((row: any) => [row.db, row.environmentId, row.activeVersion, row.revision, row.status]));
  out.pointers = pointers.map(({ _id, ...row }: any) => row);

  const runtimePointer: any = pointers.find((row: any) => row.db === runtimeName && row.environmentId === 'production');
  const active: any = runtimePointer
    ? await rdb.collection('business_pack_releases').findOne({ tenantId: TENANT, environmentId: 'production', version: runtimePointer.activeVersion })
    : null;
  if (active) {
    const content = active.packData || active;
    const journeys: any[] = Array.isArray(content.journeys) ? content.journeys : Object.values(content.journeys || {});
    p(`Active production pack: **${active.version}**, checksum \`${short(active.checksum)}\`, published ${active.publishedAt?.toISOString?.() ?? active.publishedAt} by ${active.publishedBy}.`);
    p(`OKF reference in the active pack: **${content.knowledgeModel ? JSON.stringify({ releaseId: content.knowledgeModel.releaseId, checksum: short(content.knowledgeModel.checksum), required: content.knowledgeModel.required }) : 'none'}**.`);
    p(`Fact registry facts in the active pack: **${Object.keys(content.factRegistry?.facts || {}).length}**. Catalogue mapping in the active pack: **${content.catalogMapping ? 'present' : 'absent'}**.`);
    p('');
    table(['journey', 'stages', 'stages with required facts', 'capabilities used'], journeys.map((journey: any) => {
      const stages: any[] = Array.isArray(journey.stages) ? journey.stages : Object.values(journey.stages || {});
      return [journey.journeyId, stages.length, stages.filter((stage) => (stage.requiredFacts || []).length > 0).length,
        [...new Set(stages.flatMap((stage) => stage.allowedCapabilities || []))].join(', ') || '—'];
    }));
    const cards = content.experience?.cards || {};
    p(`Cards: allowed types = ${JSON.stringify(cards.allowedCardTypes || [])}; templates = ${JSON.stringify(Object.keys(cards.templates || {}))}.`);
    p(`Tools defined: ${(content.capabilities?.toolDefinitions || []).map((tool: any) => tool.toolId).join(', ') || '—'}.`);
    p(`Evaluation suites in pack: **${(content.evaluations || []).length}**.`);
    out.activePack = { version: active.version, checksum: active.checksum, journeys: journeys.map((j: any) => j.journeyId), knowledgeModel: content.knowledgeModel ?? null };
  } else {
    p('No active production pack found in the runtime database.');
  }

  // ── Project draft ────────────────────────────────────────────────
  h('2. Project draft (source: project database `tenant_configs`)');
  const project: any = await pdb.collection('tenant_configs').findOne({ projectId: TENANT });
  if (project) {
    table(['field', 'value'], [
      ['config version', project.version], ['activeVersion', project.activeVersion], ['packVersion', project.packVersion],
      ['environmentVersions', JSON.stringify(project.environmentVersions ?? null)],
      ['knowledgeModel reference', project.knowledgeModel ? JSON.stringify({ releaseId: project.knowledgeModel.releaseId, version: project.knowledgeModel.version, checksum: short(project.knowledgeModel.checksum), required: project.knowledgeModel.required, failurePolicy: project.knowledgeModel.failurePolicy }) : 'none'],
      ['factRegistry facts', Object.keys(project.factRegistry?.facts || {}).join(', ') || '—'],
      ['catalogMapping', project.catalogMapping ? 'present' : 'absent'],
      ['ai', project.ai ? `${project.ai.provider}/${project.ai.model}` : '—'],
      ['pricing currency (the pack takes its currency from here)', project.pricing?.currency ?? '— (publication is blocked until stated)'],
      ['profile (locale / extra currencies)', project.profile ? JSON.stringify(project.profile) : '—'],
      ['updatedAt', project.updatedAt],
    ]);
    out.project = { version: project.version, activeVersion: project.activeVersion, packVersion: project.packVersion, knowledgeModel: project.knowledgeModel ?? null, pricingCurrency: project.pricing?.currency ?? null, profile: project.profile ?? null };
  } else p('No project record.');

  // ── OKF ──────────────────────────────────────────────────────────
  h('3. OKF releases and drafts (source: `okf_releases`, `okf_drafts`, `okf_*` collections)');
  const releases: any[] = await rdb.collection('okf_releases').find({ tenantId: TENANT }).toArray();
  table(['releaseId', 'environment', 'version', 'status', 'checksum', 'artifact', 'published'], releases.map((r) => [r.releaseId, r.environmentId, r.version, r.status, short(r.checksum), `${r.artifact?.status ?? '—'}${r.artifact?.error ? ` (${r.artifact.error})` : ''}`, `${r.publishedBy} @ ${r.publishedAt?.toISOString?.() ?? r.publishedAt}`]));
  const drafts: any[] = await rdb.collection('okf_drafts').find({ tenantId: TENANT }).toArray();
  table(['draft environment', 'revision', 'valid', 'concepts', 'checksum', 'updated'], drafts.map((d) => [d.environmentId, d.revision, d.validation?.valid, d.content?.concepts?.length, short(d.checksum), `${d.updatedBy} @ ${d.updatedAt?.toISOString?.() ?? d.updatedAt}`]));
  const okfCounts: Row = {};
  for (const name of ['okf_concepts', 'okf_relationships', 'okf_sources', 'okf_evidence_chunks', 'okf_verification_records', 'okf_fact_definitions', 'okf_revocation_events']) {
    okfCounts[name] = await rdb.collection(name).countDocuments({ tenantId: TENANT }).catch(() => 'n/a');
  }
  p(`Row counts for this tenant: ${JSON.stringify(okfCounts)}.`);
  out.okf = { releases: releases.map((r) => ({ releaseId: r.releaseId, environmentId: r.environmentId, version: r.version, checksum: r.checksum, status: r.status, artifact: r.artifact ?? null })), drafts: drafts.map((d) => ({ environmentId: d.environmentId, revision: d.revision, checksum: d.checksum })), counts: okfCounts };

  // ── Catalogue ────────────────────────────────────────────────────
  h('4. Catalogue (source: runtime database `products`)');
  const products = rdb.collection('products');
  const totalAll = await products.estimatedDocumentCount();
  const ownership: any[] = await products.aggregate([{ $match: owner }, { $group: { _id: { projectId: '$projectId', tenantId: '$tenantId' }, n: { $sum: 1 } } }]).toArray();
  const total = ownership.reduce((sum, row) => sum + row.n, 0);
  p(`Whole collection: **${totalAll}** documents (all tenants). ${TENANT}: **${total}** = ${ownership.map((row) => `${row.n} (projectId=${row._id.projectId ?? '∅'}, tenantId=${row._id.tenantId ?? '∅'})`).join(' + ')}.`);
  out.catalogue = { collectionTotal: totalAll, tenantTotal: total, ownership: ownership.map((row) => ({ ...row._id, n: row.n })) };

  const departments: any[] = await products.aggregate([
    { $match: owner },
    { $group: { _id: { d: { $arrayElemAt: ['$categoryPath', 0] }, g: { $arrayElemAt: ['$categoryPath', 1] }, c: '$category' }, n: { $sum: 1 } } },
  ]).toArray();
  const byDept = new Map<string, { n: number; groups: Set<string>; cats: Set<string> }>();
  for (const row of departments) {
    const key = row._id.d ?? '(no department)';
    const entry = byDept.get(key) ?? { n: 0, groups: new Set(), cats: new Set() };
    entry.n += row.n; if (row._id.g) entry.groups.add(row._id.g); if (row._id.c) entry.cats.add(row._id.c);
    byDept.set(key, entry);
  }
  table(['department', 'products', 'groups', 'leaf categories'], [...byDept.entries()].sort((a, b) => b[1].n - a[1].n).map(([name, v]) => [name, v.n, v.groups.size, v.cats.size]));
  const leafCategories = new Set(departments.map((row) => row._id.c).filter(Boolean));
  p(`Departments: **${byDept.size}** (including any without a department). Distinct leaf categories: **${leafCategories.size}**. Products without a category: **${departments.filter((row) => !row._id.c).reduce((s, row) => s + row.n, 0)}**.`);
  out.taxonomy = { departments: [...byDept.entries()].map(([name, v]) => ({ name, products: v.n, groups: [...v.groups], categories: [...v.cats] })) };

  const q = async (filter: Row) => products.countDocuments({ $and: [owner, filter] });
  const quality = {
    'priced via priceUSD.min > 0': await q({ 'priceUSD.min': { $gt: 0 } }),
    'priced via variants[0].msrpUSD > 0': await q({ 'variants.0.msrpUSD': { $gt: 0 } }),
    'priced via priceCents > 0': await q({ priceCents: { $gt: 0 } }),
    'declares a currency': await q({ currency: { $type: 'string' } }),
    'discontinued = true': await q({ discontinued: true }),
    'has stock.availableBranchCount': await q({ 'stock.availableBranchCount': { $type: 'number' } }),
    'availability = true': await q({ availability: true }),
    'has images': await q({ 'images.0': { $exists: true } }),
  };
  table(['measure (source: products)', 'count'], Object.entries(quality));
  out.catalogueQuality = quality;

  // ── Crawl documents, glossary ────────────────────────────────────
  h('5. Crawl documents and glossary (source: `documents`, `placemakers_domain_glossary`, `placemakers_domain_keywords`)');
  const docs = rdb.collection('documents');
  const docChunks = await docs.countDocuments({ projectId: TENANT });
  const docPages: any[] = await docs.aggregate([{ $match: { projectId: TENANT } }, { $group: { _id: '$sourceUrl' } }, { $count: 'n' }]).toArray();
  const docTotal = await docs.estimatedDocumentCount();
  p(`\`documents\`: **${docChunks}** chunks for ${TENANT} across **${docPages[0]?.n ?? 0}** distinct source URLs (collection total ${docTotal}, all tenants). These are crawl chunks — evidence candidates only, never verified claims.`);
  p(`Glossary documents: ${await rdb.collection(`${TENANT}_domain_glossary`).estimatedDocumentCount().catch(() => 0)}; domain keywords: ${await rdb.collection(`${TENANT}_domain_keywords`).estimatedDocumentCount().catch(() => 0)}.`);
  out.documents = { chunks: docChunks, distinctUrls: docPages[0]?.n ?? 0, collectionTotal: docTotal };

  // ── Reconciliation ───────────────────────────────────────────────
  h('6. Reconciliation of conflicting totals');
  table(['figure seen earlier', 'what it actually measures', 'reconciled'], [
    ['49,938 products', 'every tenant in `products`', `${total} belong to ${TENANT}`],
    ['134,696 documents', 'every tenant in `documents`', `${docChunks} ${TENANT} chunks`],
    ['42,436 products', `${TENANT} across three ownership shapes`, ownership.map((row) => row.n).join(' + ') + ` = ${total}`],
    ['377 categories', 'distinct leaf `category` values', `${leafCategories.size} now`],
  ]);
  p('Counts above are a point-in-time read; re-run the script to refresh them.');

  const dir = path.resolve(__dirname, '../../docs/inventory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${TENANT}-inventory-${stamp}.md`), `${lines.join('\n')}\n`);
  writeFileSync(path.join(dir, `${TENANT}-inventory-${stamp}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote docs/inventory/${TENANT}-inventory-${stamp}.{md,json}`);
  process.exit(0);
})().catch((error) => { console.error('ERR', error.message); process.exit(1); });
