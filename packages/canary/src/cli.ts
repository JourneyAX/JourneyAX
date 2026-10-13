/**
 * Public-path canary. Sends read-only, sanitised customer questions to a shop's public chat stream and checks every turn.
 *
 *   CANARY_COOKIE='jxs_at=…' npx tsx packages/canary/src/cli.ts --spec scripts/canary/placemakers.canary.json \
 *     --url https://shop.example/api/chat/stream?project=placemakers --out logs/canary
 *
 * Credentials come from the environment only (CANARY_COOKIE or CANARY_BEARER) and are never written to the report.
 * It performs no purchase: the forbidden-capability and forbidden-card rules fail the run if one happens.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderCanaryMarkdown, runCanary } from './run';

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined; };

(async () => {
  const specPath = arg('spec');
  const url = arg('url');
  if (!specPath || !url) throw new Error('usage: --spec <canary.json> --url <public chat stream url> [--out <dir>]');
  const headers: Record<string, string> = {};
  if (process.env.CANARY_COOKIE) headers.Cookie = process.env.CANARY_COOKIE;
  if (process.env.CANARY_BEARER) headers.Authorization = `Bearer ${process.env.CANARY_BEARER}`;
  const report = await runCanary({ url, headers }, JSON.parse(readFileSync(specPath, 'utf8')));
  const out = path.resolve(arg('out') ?? 'logs/canary');
  mkdirSync(out, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  writeFileSync(path.join(out, `canary-${report.tenantId}-${stamp}.json`), `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(path.join(out, `canary-${report.tenantId}-${stamp}.md`), renderCanaryMarkdown(report));
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${report.totals.scenarios} scenarios, ${report.totals.turns} turns, ${report.totals.violations} violation(s), ${report.totals.warnings} warning(s) → ${path.relative(process.cwd(), out)}`);
  process.exitCode = report.passed ? 0 : 1;
})().catch((error) => { console.error(error.message || error); process.exit(1); });
