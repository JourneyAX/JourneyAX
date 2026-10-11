#!/usr/bin/env node
/**
 * Sequential test runner with per-suite logs.
 *
 *   node scripts/run-all-tests.mjs [--group core|typecheck|extended|all] [--only id,id] [--fail-fast]
 *
 * Each run writes logs/test-runs/<timestamp>/ with one <suite>.log (stdout+stderr), the structured
 * <suite>.jsonl files emitted by @journeyax/test-support (JOURNEYAX_TEST_LOG_DIR), summary.json and
 * summary.md. Exit status is non-zero when any suite fails.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(path.join(root, 'scripts/test-suites.json'), 'utf8'));

function parseArgs(argv) {
  const options = { group: 'core+typecheck', only: undefined, failFast: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--group') options.group = argv[++i];
    else if (argv[i] === '--only') options.only = argv[++i].split(',').filter(Boolean);
    else if (argv[i] === '--fail-fast') options.failFast = true;
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  return options;
}

function selectSuites(options) {
  if (options.only) return options.only;
  const groups = options.group === 'all'
    ? Object.keys(registry.groups)
    : options.group.split('+');
  const ids = [];
  for (const group of groups) {
    if (!registry.groups[group]) throw new Error(`Unknown group '${group}'`);
    ids.push(...registry.groups[group]);
  }
  return [...new Set(ids)];
}

function runSuite(id, runDir) {
  const suite = registry.suites[id];
  if (!suite) throw new Error(`Unknown suite '${id}'`);
  const safe = id.replace(/[^a-z0-9._-]+/gi, '_');
  const logPath = path.join(runDir, `${safe}.log`);
  const log = createWriteStream(logPath);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(suite.command, {
      cwd: path.join(root, suite.cwd),
      shell: true,
      env: { ...process.env, JOURNEYAX_TEST_LOG_DIR: path.join(runDir, 'structured'), FORCE_COLOR: '0', NODE_ENV: 'test' },
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', (code) => {
      log.end();
      resolve({ id, cwd: suite.cwd, command: suite.command, exitCode: code ?? 1, durationMs: Date.now() - started, log: path.relative(root, logPath) });
    });
    child.on('error', (error) => {
      log.end(`spawn error: ${error.message}\n`);
      resolve({ id, cwd: suite.cwd, command: suite.command, exitCode: 1, durationMs: Date.now() - started, log: path.relative(root, logPath) });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ids = selectSuites(options);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(root, 'logs', 'test-runs', stamp);
  mkdirSync(path.join(runDir, 'structured'), { recursive: true });
  console.log(`Test run ${stamp}: ${ids.length} suites → ${path.relative(root, runDir)}`);

  const results = [];
  for (const id of ids) {
    process.stdout.write(`  • ${id} ... `);
    const result = await runSuite(id, runDir);
    results.push(result);
    console.log(`${result.exitCode === 0 ? 'PASS' : 'FAIL'} (${(result.durationMs / 1000).toFixed(1)}s)`);
    if (result.exitCode !== 0 && options.failFast) break;
  }

  const failed = results.filter((result) => result.exitCode !== 0);
  const summary = {
    startedAt: stamp, node: process.version, suites: results.length, passed: results.length - failed.length, failed: failed.length,
    results,
  };
  writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const lines = [
    `# Test run ${stamp}`, '',
    `${summary.passed}/${summary.suites} suites passed.`, '',
    '| Suite | Result | Seconds | Log |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.exitCode === 0 ? 'PASS' : 'FAIL'} | ${(r.durationMs / 1000).toFixed(1)} | ${r.log} |`),
  ];
  writeFileSync(path.join(runDir, 'summary.md'), `${lines.join('\n')}\n`);
  console.log(`\n${summary.passed}/${summary.suites} suites passed. Summary: ${path.relative(root, path.join(runDir, 'summary.md'))}`);
  if (failed.length) {
    console.error(`Failed: ${failed.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
