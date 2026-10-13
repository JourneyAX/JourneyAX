import { checkTurn, type TurnSummary, type Violation } from './invariants';
import { readSse } from './sse';
import { makeAliaser, sanitizeText, sanitizeValue } from './sanitize';
import { CanarySpecSchema, type CanarySpec } from './spec';

export interface CanaryTarget {
  /** The public chat stream, e.g. https://shop.example/api/chat/stream?project=placemakers. */
  url: string;
  /** Credentials for the canary customer. Supplied by the caller at run time; never read from files, never printed. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Abandon a turn after this long. */
  timeoutMs?: number;
}

export interface TurnReport {
  message: string;
  status: number;
  elapsedMs: number;
  reply: string;
  cardTypes: string[];
  capabilities: string[];
  events: string[];
  violations: Violation[];
  /** The sanitised frames, for the transcript. */
  transcript: unknown[];
}

export interface ScenarioReport { id: string; description: string; passed: boolean; turns: TurnReport[] }
export interface CanaryReport {
  tenantId: string;
  specVersion: string;
  startedAt: string;
  durationMs: number;
  passed: boolean;
  totals: { scenarios: number; turns: number; violations: number; warnings: number };
  scenarios: ScenarioReport[];
}

/** Runs each scenario as one conversation against the public chat stream and checks every turn. */
export async function runCanary(target: CanaryTarget, specInput: unknown): Promise<CanaryReport> {
  const spec: CanarySpec = CanarySpecSchema.parse(specInput);
  const doFetch = target.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const scenarios: ScenarioReport[] = [];
  const aliasSession = makeAliaser('session');

  for (const scenario of spec.scenarios) {
    // One session per scenario, chosen by the canary: a stable, recognisable, disposable conversation.
    const sessionId = `canary-${scenario.id}-${Date.now().toString(36)}`;
    const turns: TurnReport[] = [];
    for (const [index, turn] of scenario.turns.entries()) {
      const sent = Date.now();
      let observation;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? 60_000);
        const response = await doFetch(target.url, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(target.headers ?? {}) },
          body: JSON.stringify({ message: turn.message, sessionId, workspaceId: sessionId, turnId: `${sessionId}-t${index + 1}`, correlationId: `${sessionId}-c${index + 1}` }),
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        const isStream = (headers['content-type'] ?? '').toLowerCase().startsWith('text/event-stream');
        const read = isStream ? await readSse(response, sent) : { frames: [], truncated: false };
        const bodyText = isStream ? undefined : await response.text().catch(() => '');
        clearTimeout(timer);
        observation = { status: response.status, headers, frames: read.frames, truncated: read.truncated, elapsedMs: Date.now() - sent, bodyText };
      } catch (error: any) {
        observation = { status: 0, headers: {}, frames: [], truncated: true, elapsedMs: Date.now() - sent, bodyText: String(error?.message ?? error) };
      }
      const { violations, summary } = checkTurn(observation, spec, turn.expect);
      if (observation.status === 0) violations.push({ id: 'unreachable', severity: 'error', message: `the chat stream could not be reached: ${sanitizeText(observation.bodyText ?? '')}` });
      if (observation.status !== 200 && observation.bodyText) {
        // A non-stream answer must still be free of internal content.
        const leak = /MongoServerError|mongodb:\/\/|\n\s+at\s+\S+\s+\(|concept:\/\/|knowledgeGate|releaseId/.exec(observation.bodyText);
        if (leak) violations.push({ id: 'leak:error_body', severity: 'error', message: `an error response exposed internals ("${leak[0].slice(0, 30)}")` });
      }
      for (const violation of violations) violation.message = sanitizeText(violation.message);
      turns.push({
        message: turn.message, status: observation.status, elapsedMs: observation.elapsedMs, reply: sanitizeText(summary.reply), cardTypes: summary.cardTypes,
        capabilities: summary.capabilities, events: summary.events, violations,
        transcript: observation.frames.map((frame) => ({ event: frame.event, data: sanitizeValue(frame.json ?? frame.data, aliasSession), atMs: frame.atMs })),
      });
    }
    scenarios.push({ id: scenario.id, description: scenario.description, passed: turns.every((turn) => !turn.violations.some((violation) => violation.severity === 'error')), turns });
  }

  const all = scenarios.flatMap((scenario) => scenario.turns.flatMap((turn) => turn.violations));
  return {
    tenantId: spec.tenantId, specVersion: spec.version, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt,
    passed: scenarios.every((scenario) => scenario.passed),
    totals: { scenarios: scenarios.length, turns: scenarios.reduce((n, s) => n + s.turns.length, 0), violations: all.filter((v) => v.severity === 'error').length, warnings: all.filter((v) => v.severity === 'warning').length },
    scenarios,
  };
}

/** `notes` are caveats the person running the canary wants printed with the result (for example, that the model is a stand-in). */
export function renderCanaryMarkdown(report: CanaryReport, options: { notes?: string[] } = {}): string {
  const lines = [
    `# ${report.tenantId} public-path canary`, '',
    `Spec ${report.specVersion}, ${report.startedAt}, ${report.durationMs} ms. **${report.passed ? 'PASS' : 'FAIL'}** — ${report.totals.scenarios} scenarios, ${report.totals.turns} turns, ${report.totals.violations} violation(s), ${report.totals.warnings} warning(s).`,
    '', 'The transcript is sanitised: contact details, tokens, cookies and long identifiers are replaced and session ids are aliased.', '',
    ...(options.notes ?? []).flatMap((note) => [`> **Note:** ${note}`, '']),
    '| Scenario | Result | Turns | Cards shown |', '|---|---|---:|---|',
    ...report.scenarios.map((s) => `| ${s.id} | ${s.passed ? 'pass' : '**fail**'} | ${s.turns.length} | ${[...new Set(s.turns.flatMap((t) => t.cardTypes))].join(', ') || '—'} |`), '',
  ];
  for (const scenario of report.scenarios) {
    lines.push(`## ${scenario.id}`, '', scenario.description, '');
    scenario.turns.forEach((turn, index) => {
      lines.push(`**Turn ${index + 1}** — customer: “${turn.message}” (${turn.elapsedMs} ms, HTTP ${turn.status})`, '', `> ${turn.reply.replace(/\n+/g, '\n> ') || '(no text)'}`, '',
        `Events: ${turn.events.join(' → ') || '—'}. Cards: ${turn.cardTypes.join(', ') || '—'}. Steps: ${turn.capabilities.join(', ') || '—'}.`, '');
      for (const violation of turn.violations) lines.push(`- ${violation.severity === 'error' ? '❌' : '⚠️'} \`${violation.id}\`: ${sanitizeText(violation.message)}`);
      if (turn.violations.length) lines.push('');
    });
  }
  return `${lines.join('\n')}\n`;
}

export type { TurnSummary };
