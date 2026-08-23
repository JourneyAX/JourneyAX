/**
 * Minimal levelled logger.
 *
 * The codebase had 200-plus bare `console.log` calls, several of them printing
 * user messages and search queries. In production that is both noise and a
 * quiet privacy problem, since anything logged tends to end up in a hosting
 * provider's retained log store.
 *
 * Rules: `debug` disappears outside development, `warn`/`error` always speak.
 * Nothing here is clever on purpose — swapping this for a real log shipper
 * later should mean changing one file.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const isProd = process.env.NODE_ENV === 'production';
const enabled: Record<Level, boolean> = {
  debug: !isProd,
  info: !isProd,
  warn: true,
  error: true,
};

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (!enabled[level]) return;
  const line = `[${scope}] ${msg}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}

/**
 * Shorten free text before it reaches a log line.
 *
 * Used for user messages and search queries: enough to debug a bad retrieval,
 * not enough to reconstruct a conversation out of the log store.
 */
export function redact(text: unknown, keep = 60): string {
  if (typeof text !== 'string') return '(non-string)';
  return text.length <= keep ? text : `${text.slice(0, keep)}… (${text.length} chars)`;
}
