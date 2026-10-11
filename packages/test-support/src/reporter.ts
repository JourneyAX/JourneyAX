import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface SuiteReporter {
  test(name: string, fn: () => void | Promise<void>): Promise<void>;
  /** Prints the summary, writes it to the log, and sets a failing exit code when needed. */
  finish(): { passed: number; failed: number };
}

interface LogLine {
  ts: string;
  suite: string;
  event: 'test' | 'summary';
  name?: string;
  status?: 'passed' | 'failed';
  durationMs?: number;
  error?: string;
  passed?: number;
  failed?: number;
}

/**
 * Structured test reporter.
 *
 * Human output goes to stdout. When JOURNEYAX_TEST_LOG_DIR is set, every result is
 * also appended as a JSON line to `<dir>/<suite>.jsonl`, so a runner (or CI) can
 * collect per-test timings and failures without parsing console text.
 */
export function createSuite(suiteName: string): SuiteReporter {
  let passed = 0;
  let failed = 0;
  const logDir = process.env.JOURNEYAX_TEST_LOG_DIR;
  const logFile = logDir ? path.join(logDir, `${suiteName.replace(/[^a-z0-9._-]+/gi, '_')}.jsonl`) : undefined;
  if (logDir) mkdirSync(logDir, { recursive: true });

  const write = (line: LogLine) => { if (logFile) appendFileSync(logFile, `${JSON.stringify(line)}\n`); };
  console.log(`🧪 ${suiteName}`);

  return {
    async test(name, fn) {
      const started = Date.now();
      try {
        await fn();
        passed++;
        const durationMs = Date.now() - started;
        console.log(`  ✓ ${passed + failed}. ${name} (${durationMs}ms)`);
        write({ ts: new Date().toISOString(), suite: suiteName, event: 'test', name, status: 'passed', durationMs });
      } catch (error: any) {
        failed++;
        const durationMs = Date.now() - started;
        console.error(`  ✗ ${passed + failed}. ${name} (${durationMs}ms)\n      ${String(error?.stack || error).split('\n').slice(0, 6).join('\n      ')}`);
        write({ ts: new Date().toISOString(), suite: suiteName, event: 'test', name, status: 'failed', durationMs, error: String(error?.message || error) });
      }
    },
    finish() {
      console.log(`${failed === 0 ? '✅' : '❌'} ${suiteName}: ${passed} passed, ${failed} failed`);
      write({ ts: new Date().toISOString(), suite: suiteName, event: 'summary', passed, failed });
      if (failed > 0) process.exitCode = 1;
      return { passed, failed };
    },
  };
}
