/**
 * Runs the public-path canary against the hermetic shop (storefront route → gateway → commerce → runtime → turn service, on the
 * real authored PlaceMakers release in an isolated in-memory store) and writes the sanitised transcript.
 *
 *   npx tsx --tsconfig tests/public-path/tsconfig.json scripts/canary/hermetic-run.ts [outDir]
 *
 * It touches no database and no deployed service. To run the same canary against a deployed shop, use
 *   CANARY_COOKIE='…' npx tsx packages/canary/src/cli.ts --spec scripts/canary/placemakers.canary.json --url <public chat stream url>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderCanaryMarkdown, runCanary } from '../../packages/canary/src';

/** Printed with the transcript so nobody mistakes a stand-in for the real thing. */
const HERMETIC_NOTES = [
  'This run is hermetic: every hop is the real code, but the store is in memory and the language model is a fixed stand-in. Sentences about safety, verified sources, compatibility and technical suitability are written by the platform from policy and are real; any other reply text is the stand-in model\'s and says nothing about production wording.',
  'It proves behaviour, not production readiness. The same spec must be run against the live public URL by someone holding a customer session (see docs/okf-platform-implementation.md).',
];
import { startPublicPath } from '../../tests/public-path/harness';

(async () => {
  const quiet = console.log;
  console.log = () => undefined;
  const publicPath = await startPublicPath();
  const spec = JSON.parse(readFileSync(path.resolve(__dirname, 'placemakers.canary.json'), 'utf8'));
  const report = await runCanary({ url: publicPath.chatStreamUrl, headers: publicPath.customerHeaders }, spec);
  await publicPath.stop();
  console.log = quiet;
  const out = path.resolve(process.argv[2] ?? 'docs/canary');
  mkdirSync(out, { recursive: true });
  const stamp = '2026-10-13-hermetic';
  writeFileSync(path.join(out, `placemakers-public-path-${stamp}.json`), `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(path.join(out, `placemakers-public-path-${stamp}.md`), renderCanaryMarkdown(report, { notes: HERMETIC_NOTES }));
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${report.totals.scenarios} scenarios, ${report.totals.turns} turns, ${report.totals.violations} violation(s) → ${path.relative(process.cwd(), out)}`);
  process.exit(report.passed ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
