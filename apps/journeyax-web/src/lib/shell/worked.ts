/**
 * "Worked for 12 s": what a finished turn leaves behind in the thread, in place of the live working steps.
 * The step wording itself comes from the caller (ChatPanel's plain-language trace labels); nothing here is business wording.
 */
export interface WorkedTrace {
  /** Whole seconds the turn took, from the customer's send to the reply being complete. */
  seconds: number;
  /** Plain-language steps, in order, with consecutive repeats folded. */
  steps: string[];
}

/** A turn shorter than this, with no steps to show, leaves no line behind. */
export const MIN_VISIBLE_SECONDS = 3;

export function formatSeconds(seconds: number): string {
  const s = Math.max(1, Math.round(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

export function formatWorkedFor(seconds: number): string {
  return `Worked for ${formatSeconds(seconds)}`;
}

/** The steps a turn took, with immediate repeats and blanks removed ("Checking stock" twice in a row reads as once). */
export function foldSteps(steps: ReadonlyArray<string | undefined | null>): string[] {
  const out: string[] = [];
  for (const raw of steps) {
    const step = String(raw ?? '').trim();
    if (step && out[out.length - 1] !== step) out.push(step);
  }
  return out;
}

/** The trace to keep on a finished turn, or null when it was too quick and plain to be worth a line. */
export function buildTrace(startedAt: number, endedAt: number, steps: ReadonlyArray<string | undefined | null>): WorkedTrace | null {
  const folded = foldSteps(steps);
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (folded.length === 0 && seconds < MIN_VISIBLE_SECONDS) return null;
  return { seconds: Math.max(1, seconds), steps: folded };
}

/** Whether a stored value (from saved messages) is a usable trace. */
export function isWorkedTrace(value: unknown): value is WorkedTrace {
  const v = value as WorkedTrace | null | undefined;
  return !!v && typeof v.seconds === 'number' && Array.isArray(v.steps) && v.steps.every((s) => typeof s === 'string');
}

/**
 * `messages` with `trace` set on the last reply from the assistant (the turn's final answer). A turn whose latest message is
 * not an assistant reply (an error, an empty answer) is left untouched, as is a list with no assistant message at all.
 */
export function attachTrace<M extends { role: string; tool_calls?: unknown }>(messages: M[], trace: WorkedTrace): Array<M & { trace?: WorkedTrace }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool' || m.tool_calls) continue;
    if (m.role !== 'assistant') return messages;
    const next = [...messages] as Array<M & { trace?: WorkedTrace }>;
    next[i] = { ...m, trace };
    return next;
  }
  return messages;
}
