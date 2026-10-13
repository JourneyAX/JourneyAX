/**
 * Offline. Builds an OKF draft from a taxonomy snapshot and a tenant ingest config, then proves it:
 * validates it, audits provenance, runs the server publication evaluation, and exports a reviewable bundle.
 *
 *   npx tsx scripts/okf/ingest-taxonomy.ts <snapshot.json> <ingest-config.json> <outDir>
 *
 * Writes <outDir>/draft.json, coverage.{json,md}, departments/<slug>.md and bundle.zip. It never touches a database;
 * saving the draft to MongoDB is a separate, explicit step.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  archiveOkfBundle, auditProvenance, buildCoverageReport, buildServerOwnedOkfContent, buildTaxonomyDraft, exportOkfBundle,
  renderCoverageMarkdown, renderDepartmentMarkdown, slugify, validateOkfDraftContent,
} from '../../packages/knowledge/src';

const [snapshotPath, configPath, outArg] = process.argv.slice(2);
if (!snapshotPath || !configPath || !outArg) throw new Error('usage: ingest-taxonomy.ts <snapshot.json> <ingest-config.json> <outDir>');
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const out = path.resolve(outArg);

const generated = buildTaxonomyDraft(snapshot, config);
const validation = validateOkfDraftContent(generated.draft, generated.config.tenantId);
const audit = auditProvenance(generated.draft, generated.config);
const report = buildCoverageReport(generated);

const evaluatedAt = generated.snapshot.snapshotAt;
const built = buildServerOwnedOkfContent(generated.draft, {
  tenantId: generated.config.tenantId, environmentId: 'production', releaseId: `draft-${evaluatedAt.slice(0, 10)}`, evaluatedAt,
});
const envelope: any = {
  releaseId: `draft-${evaluatedAt.slice(0, 10)}`, tenantId: generated.config.tenantId, environmentId: 'production', version: '0.0.0-draft',
  checksum: '0'.repeat(64), status: 'ready', content: built, publishedAt: new Date(evaluatedAt), publishedBy: 'process:okf-taxonomy-ingest',
};
const bundle = archiveOkfBundle(exportOkfBundle(envelope));

mkdirSync(path.join(out, 'departments'), { recursive: true });
writeFileSync(path.join(out, 'draft.json'), `${JSON.stringify(generated.draft)}\n`);
writeFileSync(path.join(out, 'coverage.json'), `${JSON.stringify(report, null, 1)}\n`);
writeFileSync(path.join(out, 'coverage.md'), renderCoverageMarkdown(report));
for (const department of report.departments) {
  writeFileSync(path.join(out, 'departments', `${slugify(department.name)}.md`), renderDepartmentMarkdown(report, department.name));
}
writeFileSync(path.join(out, 'bundle.zip'), bundle);

const sizeKb = Math.round(Buffer.byteLength(JSON.stringify(generated.draft)) / 1024);
console.log(JSON.stringify({
  out: path.relative(process.cwd(), out), draftKb: sizeKb, bundleKb: Math.round(bundle.length / 1024),
  validation: { valid: validation.valid, issues: validation.issues.length }, provenance: { ok: audit.ok, violations: audit.violations.length },
  evaluation: built.evaluation, reconciliation: report.reconciliation, totals: report.totals,
}, null, 1));
process.exitCode = validation.valid && audit.ok && report.reconciliation.ok && built.evaluation.passed ? 0 : 1;
if (!validation.valid) for (const issue of validation.issues.slice(0, 15)) console.log(`  validation: ${issue.code} ${issue.path ?? ''} ${issue.message}`);
if (!audit.ok) for (const v of audit.violations.slice(0, 10)) console.log(`  provenance: ${v.code} ${v.entity} ${v.message}`);
