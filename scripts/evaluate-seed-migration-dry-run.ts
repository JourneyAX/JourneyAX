/**
 * evaluate-seed-migration-dry-run.ts
 *
 * Canonical Parity Evaluation & Dry-Run Report Generator.
 *
 * Requirements:
 * 1. Loads ONLY canonically discovered Business Packs from the filesystem packs/
 *    directory via the existing BusinessPackLoader — no hardcoded SEED_TENANTS.
 * 2. Does NOT load .env, does NOT read MONGODB_URI, never connects to any database.
 * 3. Resolves branch and commit dynamically via child_process.execSync.
 * 4. Synthetic fixtures are explicitly excluded from readiness counts.
 * 5. Generates reports from the same canonical pack + checksum used by publication
 *    and inventory (computePackChecksum on the loader's output).
 * 6. No self-attestation. Report is labelled a dry-run evaluation — not a signed approval.
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

// ---------------------------------------------------------------------------
// Git context (dynamic — never hardcoded)
// ---------------------------------------------------------------------------
function resolveGitContext(): { branch: string; commit: string } {
  const run = (cmd: string, fallback = '(unknown)') => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
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
// Discover canonical filesystem packs (same logic as inventory-tenant-connectors)
// ---------------------------------------------------------------------------
const PACKS_ROOT = path.resolve(__dirname, '../packs');
const SYNTHETIC_FIXTURE_SUFFIX = '_fixture';

interface EvaluatedPack {
  tenantId: string;
  source: 'filesystem_pack' | 'not_discovered';
  isSyntheticFixture: boolean;
  schemaValid: boolean;
  semanticValid: boolean;
  checksum: string;
  packVersion: string;
  issues: string[];
  rawPack: BusinessPackRelease | null;
  validatedPack: BusinessPackRelease | null;
}

async function discoverCanonicalPacks(): Promise<EvaluatedPack[]> {
  const loader = new BusinessPackLoader({ localPacksRoot: PACKS_ROOT });
  const results: EvaluatedPack[] = [];

  if (!fs.existsSync(PACKS_ROOT)) {
    console.warn(`[evaluator] packs/ directory not found at ${PACKS_ROOT}. No packs to evaluate.`);
    return results;
  }

  const tenantDirs = fs.readdirSync(PACKS_ROOT).filter((d) => {
    const full = path.join(PACKS_ROOT, d);
    return fs.statSync(full).isDirectory();
  });

  for (const tenantId of tenantDirs) {
    const isSyntheticFixture = tenantId.endsWith(SYNTHETIC_FIXTURE_SUFFIX);
    const issues: string[] = [];

    // Load via canonical loader (same path as publication + inventory uses)
    let rawPack: BusinessPackRelease | null = null;
    try {
      rawPack = await loader.loadFromDisk(tenantId, 'production');
      if (!rawPack) {
        rawPack = await loader.loadFromDisk(tenantId, 'test');
      }
    } catch (err: any) {
      issues.push(`Loader error: ${err.message}`);
    }

    if (!rawPack) {
      results.push({
        tenantId,
        source: 'not_discovered',
        isSyntheticFixture,
        schemaValid: false,
        semanticValid: false,
        checksum: '',
        packVersion: '',
        issues: [...issues, 'Pack could not be loaded from filesystem'],
        rawPack: null,
        validatedPack: null,
      });
      continue;
    }

    // Schema validation via the canonical Zod schema
    const schemaParsed = BusinessPackReleaseSchema.safeParse(rawPack);
    const schemaValid = schemaParsed.success;
    if (!schemaValid) {
      issues.push(`Schema: ${JSON.stringify(schemaParsed.error?.format())}`);
    }

    // Semantic validation via validateBusinessPack (same function used by publishBusinessPack)
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
      // Compute checksum from the validated canonical pack — same as publishBusinessPack does
      checksum = computePackChecksum(validatedPack);
    }

    results.push({
      tenantId,
      source: 'filesystem_pack',
      isSyntheticFixture,
      schemaValid,
      semanticValid,
      checksum,
      packVersion: rawPack.manifest?.version ?? '(unknown)',
      issues,
      rawPack,
      validatedPack,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------
async function runEvaluation(): Promise<void> {
  console.log('🔍 Starting Canonical Pack Dry-Run Evaluation (offline, no DB)...\n');

  const { branch, commit } = resolveGitContext();
  const timestamp = new Date().toISOString();
  const allPacks = await discoverCanonicalPacks();

  // Split: real tenants vs synthetic fixtures
  const canonicalPacks = allPacks.filter((p) => !p.isSyntheticFixture);
  const fixturePacks = allPacks.filter((p) => p.isSyntheticFixture);

  const readyCount = canonicalPacks.filter((p) => p.schemaValid && p.semanticValid).length;
  const blockedCount = canonicalPacks.filter((p) => !p.schemaValid || !p.semanticValid).length;

  // Console summary table
  console.table(
    canonicalPacks.map((p) => ({
      Tenant: p.tenantId,
      Source: p.source,
      Schema: p.schemaValid ? 'PASS' : 'FAIL',
      Semantic: p.semanticValid ? 'PASS' : 'FAIL',
      Checksum: p.checksum ? p.checksum.slice(0, 16) + '...' : '—',
      Version: p.packVersion,
      Status: p.schemaValid && p.semanticValid ? 'DRY_RUN_PASSED' : 'REQUIRES_REMEDIATION',
    }))
  );

  if (fixturePacks.length > 0) {
    console.log(`\n[Synthetic Fixtures — EXCLUDED from readiness] (${fixturePacks.length} fixture(s)):`);
    console.table(
      fixturePacks.map((p) => ({
        Tenant: p.tenantId,
        Schema: p.schemaValid ? 'PASS' : 'FAIL',
        Checksum: p.checksum ? p.checksum.slice(0, 16) + '...' : '—',
        Note: 'FIXTURE_ONLY — not counted in readiness',
      }))
    );
  }

  // ---------------------------------------------------------------------------
  // Markdown report
  // ---------------------------------------------------------------------------
  const reportPath = path.resolve(__dirname, '../docs/seed-tenants-migration-dry-run-report.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  let md = `# JourneyAX — Canonical Pack Dry-Run Evaluation Report\n\n`;
  md += `**Generated At**: \`${timestamp}\`\n\n`;
  md += `**Branch / Commit**: \`${branch}\` / \`${commit}\`\n\n`;
  md += `**Evaluation Mode**: Offline Filesystem Dry-Run — schema compilation and canonical conformance.\n\n`;
  md += `**Scope**: Canonical discovered packs from \`packs/\` only. Synthetic fixtures are listed separately and excluded from readiness.\n\n`;
  md += `> **GOVERNANCE NOTICE**: Dry-run evaluation validates candidate Business Pack schema compilation and semantic integrity. `;
  md += `It does **not** grant cutover approval. Production routing strictly requires an approved, signed \`DurableCutoverRecord\` in \`tenant_cutovers\`.\n\n`;
  md += `---\n\n`;

  md += `## 1. Executive Summary\n\n`;
  md += `| Category | Count |\n`;
  md += `| :--- | :---: |\n`;
  md += `| Canonical packs discovered | ${canonicalPacks.length} |\n`;
  md += `| Dry-run passed (schema + semantic valid) | ${readyCount} |\n`;
  md += `| Requires remediation | ${blockedCount} |\n`;
  md += `| Synthetic fixtures (excluded from readiness) | ${fixturePacks.length} |\n\n`;

  md += `## 2. Canonical Pack Inventory\n\n`;
  md += `| Tenant ID | Version | Schema | Semantic | Checksum (SHA-256, first 16) | Status |\n`;
  md += `| :--- | :---: | :---: | :---: | :--- | :---: |\n`;
  for (const p of canonicalPacks) {
    const schema = p.schemaValid ? '✅ PASS' : '❌ FAIL';
    const sem = p.semanticValid ? '✅ PASS' : '❌ FAIL';
    const cs = p.checksum ? `\`${p.checksum.slice(0, 16)}...\`` : '—';
    const status = p.schemaValid && p.semanticValid ? '🟢 DRY_RUN_PASSED' : '🔴 BLOCKED';
    md += `| \`${p.tenantId}\` | \`${p.packVersion}\` | ${schema} | ${sem} | ${cs} | ${status} |\n`;
  }
  md += `\n`;

  md += `## 3. Validation Issues\n\n`;
  const withIssues = canonicalPacks.filter((p) => p.issues.length > 0);
  if (withIssues.length === 0) {
    md += `No validation issues found across all canonical packs.\n\n`;
  } else {
    for (const p of withIssues) {
      md += `### \`${p.tenantId}\`\n`;
      for (const iss of p.issues) {
        md += `- ${iss}\n`;
      }
      md += `\n`;
    }
  }

  md += `## 4. Synthetic Fixtures (Excluded from Readiness)\n\n`;
  if (fixturePacks.length === 0) {
    md += `No synthetic fixtures found.\n\n`;
  } else {
    md += `| Fixture ID | Schema | Checksum | Note |\n`;
    md += `| :--- | :---: | :--- | :--- |\n`;
    for (const p of fixturePacks) {
      const schema = p.schemaValid ? '✅ PASS' : '❌ FAIL';
      const cs = p.checksum ? `\`${p.checksum.slice(0, 16)}...\`` : '—';
      md += `| \`${p.tenantId}\` | ${schema} | ${cs} | FIXTURE_EVALUATION_ONLY — not counted |\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;
  md += `*This report was generated automatically from the canonical filesystem packs. It is a dry-run evaluation only — not a production cutover approval.*\n`;

  fs.writeFileSync(reportPath, md, 'utf8');
  console.log(`\n📄 Dry-run report written to:\n   ${reportPath}\n`);

  // Exit status
  if (blockedCount > 0) {
    console.error(`❌ ${blockedCount} canonical pack(s) failed dry-run validation. Review issues above.`);
    process.exit(1);
  } else if (canonicalPacks.length === 0) {
    console.warn('⚠️  No canonical packs discovered. Ensure packs/ directory is populated.');
    process.exit(0);
  } else {
    console.log(`✅ All ${readyCount} canonical pack(s) passed dry-run schema + semantic validation.`);
    process.exit(0);
  }
}

runEvaluation().catch((err) => {
  console.error('Fatal error during dry-run evaluation:', err);
  process.exit(1);
});
