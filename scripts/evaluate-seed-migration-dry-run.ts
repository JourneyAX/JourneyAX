/**
 * evaluate-seed-migration-dry-run.ts
 *
 * Canonical Parity Evaluation & Dry-Run Report Generator.
 *
 * Requirements:
 * 1. Loads the portfolio from config/portfolio-manifest.json — the same
 *    manifest consumed by inventory-tenant-connectors. No separate tenant list.
 * 2. Discovers canonical Business Packs from packs/ via BusinessPackLoader.
 *    No hardcoded SEED_TENANTS.
 * 3. Does NOT load .env, does NOT read MONGODB_URI, never connects to any DB.
 * 4. Classifies discovered packs using the same portfolio manifest:
 *      ACTIVE_PORTFOLIO  — in activePortfolio list
 *      PARKED            — in parked list (excluded from active readiness)
 *      SYNTHETIC_FIXTURE — tenantId ends with the manifest's syntheticFixtureSuffix
 * 5. Parked tenants do not affect active-portfolio readiness counts.
 * 6. Resolves branch and commit dynamically via child_process.execSync.
 * 7. Generates checksum from computePackChecksum on the loader's validated output
 *    (same path as publication and inventory).
 * 8. No self-attestation. Report is labelled a dry-run evaluation — not a signed approval.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import {
  BusinessPackReleaseSchema,
  validateBusinessPack,
  computePackChecksum,
  BusinessPackRelease,
  BusinessPackLoader,
} from '@journeyax/business-pack';

import {
  loadPortfolioManifest,
  classifyTenant,
  PackClassification,
  DEFAULT_PORTFOLIO_MANIFEST_PATH,
  PortfolioManifest,
} from './inventory-tenant-connectors';

// ---------------------------------------------------------------------------
// Git context (dynamic — never hardcoded)
// ---------------------------------------------------------------------------
function resolveGitContext(): { branch: string; commit: string } {
  const run = (cmd: string, fallback = '(unknown)') => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return fallback;
    }
  };
  return {
    branch: run('git rev-parse --abbrev-ref HEAD'),
    commit: run('git rev-parse HEAD'),
  };
}

// ---------------------------------------------------------------------------
// Per-pack evaluation record
// ---------------------------------------------------------------------------
interface EvaluatedPack {
  tenantId: string;
  classification: PackClassification;
  source: 'filesystem_pack' | 'not_discovered';
  schemaValid: boolean;
  semanticValid: boolean;
  checksum: string;
  packVersion: string;
  issues: string[];
  rawPack: BusinessPackRelease | null;
  validatedPack: BusinessPackRelease | null;
}

// ---------------------------------------------------------------------------
// Pack discovery — aligned with portfolio manifest
// ---------------------------------------------------------------------------
async function discoverAndEvaluatePacks(manifest: PortfolioManifest): Promise<EvaluatedPack[]> {
  const packsRelPath = manifest.packsRoot ?? 'packs';
  const PACKS_ROOT = path.resolve(__dirname, '..', packsRelPath);
  const loader = new BusinessPackLoader({ localPacksRoot: PACKS_ROOT });
  const results: EvaluatedPack[] = [];
  const discovered = new Set<string>();

  // 1. Scan filesystem packs/
  if (fs.existsSync(PACKS_ROOT)) {
    const tenantDirs = fs.readdirSync(PACKS_ROOT).filter((d) => {
      const full = path.join(PACKS_ROOT, d);
      return fs.statSync(full).isDirectory();
    });

    for (const tenantId of tenantDirs) {
      discovered.add(tenantId);
      const classification = classifyTenant(tenantId, manifest);
      const issues: string[] = [];

      let rawPack: BusinessPackRelease | null = null;
      try {
        rawPack = await loader.loadFromDisk(tenantId, 'production');
        if (!rawPack) rawPack = await loader.loadFromDisk(tenantId, 'test');
      } catch (err: any) {
        issues.push(`Loader error: ${err.message}`);
      }

      if (!rawPack) {
        results.push({ tenantId, classification, source: 'not_discovered', schemaValid: false, semanticValid: false, checksum: '', packVersion: '', issues: [...issues, 'Pack could not be loaded from filesystem'], rawPack: null, validatedPack: null });
        continue;
      }

      const schemaParsed = BusinessPackReleaseSchema.safeParse(rawPack);
      const schemaValid = schemaParsed.success;
      if (!schemaValid) issues.push(`Schema: ${JSON.stringify(schemaParsed.error?.format())}`);

      let semanticValid = false;
      let checksum = '';
      let validatedPack: BusinessPackRelease | null = null;
      if (schemaValid && schemaParsed.data) {
        validatedPack = schemaParsed.data;
        const validation = validateBusinessPack(validatedPack);
        semanticValid = validation.valid;
        if (!semanticValid) {
          for (const iss of validation.issues.filter((i) => i.severity === 'error')) {
            issues.push(`[${iss.path}] ${iss.message}`);
          }
        }
        checksum = computePackChecksum(validatedPack);
      }

      results.push({ tenantId, classification, source: 'filesystem_pack', schemaValid, semanticValid, checksum, packVersion: rawPack.manifest?.version ?? '(unknown)', issues, rawPack, validatedPack });
    }
  } else {
    console.warn(`[evaluator] packs/ directory not found at ${PACKS_ROOT}. No packs to evaluate.`);
  }

  // 2. Active-portfolio tenants not found on disk → not_discovered
  for (const entry of manifest.activePortfolio) {
    if (!discovered.has(entry.tenantId)) {
      results.push({ tenantId: entry.tenantId, classification: 'ACTIVE_PORTFOLIO', source: 'not_discovered', schemaValid: false, semanticValid: false, checksum: '', packVersion: '', issues: ['Pack not found on filesystem'], rawPack: null, validatedPack: null });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main evaluation runner
// ---------------------------------------------------------------------------
async function runEvaluation(): Promise<void> {
  console.log('🔍 Starting Canonical Pack Dry-Run Evaluation (offline, no DB)...\n');

  const manifest = loadPortfolioManifest(DEFAULT_PORTFOLIO_MANIFEST_PATH);
  const { branch, commit } = resolveGitContext();
  const timestamp = new Date().toISOString();
  const allPacks = await discoverAndEvaluatePacks(manifest);

  // Split by classification (same as inventory)
  const activePacks = allPacks.filter((p) => p.classification === 'ACTIVE_PORTFOLIO');
  const parkedPacks = allPacks.filter((p) => p.classification === 'PARKED');
  const fixturePacks = allPacks.filter((p) => p.classification === 'SYNTHETIC_FIXTURE');

  const readyCount = activePacks.filter((p) => p.schemaValid && p.semanticValid).length;
  const blockedCount = activePacks.filter((p) => !p.schemaValid || !p.semanticValid).length;

  // Active portfolio table
  console.log(`Active Portfolio (${activePacks.length} tenants):`);
  console.table(
    activePacks.map((p) => ({
      Tenant: p.tenantId,
      Class: p.classification,
      Source: p.source,
      Schema: p.schemaValid ? 'PASS' : 'FAIL',
      Semantic: p.semanticValid ? 'PASS' : 'FAIL',
      Checksum: p.checksum ? p.checksum.slice(0, 16) + '...' : '—',
      Version: p.packVersion,
      Status: p.schemaValid && p.semanticValid ? 'DRY_RUN_PASSED' : 'REQUIRES_REMEDIATION',
    }))
  );

  if (parkedPacks.length > 0) {
    console.log(`\n[Parked Tenants — EXCLUDED from active readiness] (${parkedPacks.length}):`);
    console.table(parkedPacks.map((p) => ({ Tenant: p.tenantId, Class: p.classification, Note: 'PARKED — not counted in readiness' })));
  }

  if (fixturePacks.length > 0) {
    console.log(`\n[Synthetic Fixtures — EXCLUDED from readiness] (${fixturePacks.length} fixture(s)):`);
    console.table(fixturePacks.map((p) => ({ Tenant: p.tenantId, Schema: p.schemaValid ? 'PASS' : 'FAIL', Checksum: p.checksum ? p.checksum.slice(0, 16) + '...' : '—', Note: 'FIXTURE_ONLY — not counted in readiness' })));
  }

  // ---------------------------------------------------------------------------
  // Markdown report
  // ---------------------------------------------------------------------------
  const reportPath = path.resolve(__dirname, '../docs/seed-tenants-migration-dry-run-report.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  let md = `# JourneyAX — Canonical Pack Dry-Run Evaluation Report\n\n`;
  md += `**Generated At**: \`${timestamp}\`\n\n`;
  md += `**Branch / Commit**: \`${branch}\` / \`${commit}\`\n\n`;
  md += `**Portfolio Manifest Version**: \`${manifest.version}\`\n\n`;
  md += `**Evaluation Mode**: Offline Filesystem Dry-Run — schema compilation and canonical conformance.\n\n`;
  md += `**Active Portfolio**: ${manifest.activePortfolio.map((e) => e.tenantId).join(', ')}\n\n`;
  md += `**Parked (excluded)**: ${manifest.parked.map((e) => e.tenantId).join(', ')}\n\n`;
  md += `> **GOVERNANCE NOTICE**: Dry-run evaluation validates candidate Business Pack schema compilation and semantic integrity. `;
  md += `It does **not** grant cutover approval. Production routing strictly requires an approved, signed \`DurableCutoverRecord\` in \`tenant_cutovers\`.\n\n---\n\n`;

  md += `## 1. Executive Summary\n\n`;
  md += `| Category | Count |\n| :--- | :---: |\n`;
  md += `| Active portfolio tenants | ${activePacks.length} |\n`;
  md += `| Dry-run passed (schema + semantic valid) | ${readyCount} |\n`;
  md += `| Requires remediation | ${blockedCount} |\n`;
  md += `| Parked tenants (excluded) | ${parkedPacks.length} |\n`;
  md += `| Synthetic fixtures (excluded) | ${fixturePacks.length} |\n\n`;

  md += `## 2. Active Portfolio Dry-Run Results\n\n`;
  md += `| Tenant ID | Version | Schema | Semantic | Checksum (SHA-256, first 16) | Status |\n`;
  md += `| :--- | :---: | :---: | :---: | :--- | :---: |\n`;
  for (const p of activePacks) {
    const schema = p.schemaValid ? '✅ PASS' : '❌ FAIL';
    const sem = p.semanticValid ? '✅ PASS' : '❌ FAIL';
    const cs = p.checksum ? `\`${p.checksum.slice(0, 16)}...\`` : '—';
    const status = p.schemaValid && p.semanticValid ? '🟢 DRY_RUN_PASSED' : '🔴 BLOCKED';
    md += `| \`${p.tenantId}\` | \`${p.packVersion}\` | ${schema} | ${sem} | ${cs} | ${status} |\n`;
  }
  md += `\n`;

  md += `## 3. Validation Issues\n\n`;
  const withIssues = activePacks.filter((p) => p.issues.length > 0);
  if (withIssues.length === 0) {
    md += `No validation issues found across all active-portfolio packs.\n\n`;
  } else {
    for (const p of withIssues) {
      md += `### \`${p.tenantId}\`\n`;
      for (const iss of p.issues) md += `- ${iss}\n`;
      md += `\n`;
    }
  }

  md += `## 4. Parked Tenants (Excluded)\n\n`;
  if (parkedPacks.length === 0) { md += `No parked tenants encountered in this scan.\n\n`; }
  else {
    md += `| Tenant ID | Reason |\n| :--- | :--- |\n`;
    for (const p of parkedPacks) {
      const entry = manifest.parked.find((e) => e.tenantId === p.tenantId);
      md += `| \`${p.tenantId}\` | ${entry?.reason ?? 'Parked'} |\n`;
    }
    md += `\n`;
  }

  md += `## 5. Synthetic Fixtures (Excluded from Readiness)\n\n`;
  if (fixturePacks.length === 0) { md += `No synthetic fixtures found.\n\n`; }
  else {
    md += `| Fixture ID | Schema | Checksum | Note |\n| :--- | :---: | :--- | :--- |\n`;
    for (const p of fixturePacks) {
      const schema = p.schemaValid ? '✅ PASS' : '❌ FAIL';
      const cs = p.checksum ? `\`${p.checksum.slice(0, 16)}...\`` : '—';
      md += `| \`${p.tenantId}\` | ${schema} | ${cs} | FIXTURE_EVALUATION_ONLY — not counted |\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;
  md += `*This report was generated automatically from the canonical filesystem packs. It is a dry-run evaluation only — not a production cutover approval.*\n`;

  fs.writeFileSync(reportPath, md.trimEnd() + '\n', 'utf8');
  console.log(`\n📄 Dry-run report written to:\n   ${reportPath}\n`);

  if (blockedCount > 0) {
    console.error(`❌ ${blockedCount} active-portfolio pack(s) failed dry-run validation. Review issues above.`);
    process.exit(1);
  } else if (activePacks.length === 0) {
    console.warn('⚠️  No active-portfolio packs discovered. Ensure packs/ directory is populated.');
    process.exit(0);
  } else {
    console.log(`✅ All ${readyCount} active-portfolio pack(s) passed dry-run schema + semantic validation.`);
    process.exit(0);
  }
}

runEvaluation().catch((err) => {
  console.error('Fatal error during dry-run evaluation:', err);
  process.exit(1);
});
