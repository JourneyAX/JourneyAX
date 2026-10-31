import type { Binding, FactPath, LinkName, SettingKey, SignalRule } from '../model';
import { formatExact, fromJsNumber, readAmount } from './decimal';

/**
 * Why a signal could not be worked out. The first three are the reasons of the error table; `draft` and `input_unusable` belong to this
 * evaluator: a draft signal never fires, and a value that is there but is of the wrong kind (text where a number is needed, two
 * currencies, a date with no zone) is neither guessed at nor treated as zero.
 */
export type SignalReason = 'signal_input_unavailable' | 'setting_missing' | 'divisor_zero' | 'draft' | 'input_unusable';

/** Where a value was read from. A fuller source stamp from another module has these fields and more; only these are copied. */
export interface SignalSource {
  system: string;
  displayName?: string;
  sample?: boolean;
  tool?: string;
  authority: Binding['authority'];
  /** Null when the tool gives no time of its own. */
  sourceUpdatedAt: string | null;
  retrievedAt: string;
  fromCache?: boolean;
  /**
   * Which time the binding's contract says to trust, as the stamp already decided it. When it is there, it alone decides the "as of"
   * line of the evidence; the two times above are then only context. A stamp without it falls back to the tool's own time when it gave one.
   */
  asOf?: { kind: 'as_of' | 'as_read_at'; at: string };
}

/** What the caller knows about one fact it has read. `ok` and `stale` carry a value; `not_available` carries the reason. */
export interface SignalInputFact {
  status: 'ok' | 'stale' | 'not_available';
  value?: unknown;
  source?: SignalSource;
  unavailable?: { reason: string; system?: string };
  /** A count that may be higher than the number seen. It is not a figure to compare, so a signal that reads it is not worked out. */
  atLeast?: boolean;
}

export interface SignalInputEvidence {
  name: string;
  fact: FactPath;
  /** As the caller gave it; an input the caller did not supply is `not_available`. */
  status: SignalInputFact['status'];
  value?: unknown;
  source?: SignalSource;
  /** "as of <time>" or "as read at <time>", as the stamp's `asOf` says; without one, "as of" when the source gave a time of its own. */
  asOf?: string;
  /** Present when the signal could not use this input, and why. */
  problem?: { reason: string; system?: string };
}

export interface SignalListEvidence {
  over: LinkName;
  /** `any`: a yes/no over the items; `count`: how many; `number`: the count used as a plain number. */
  use: 'any' | 'count' | 'number';
  /** False when the list was cut or a system that holds it did not answer: the signal is then not worked out. */
  complete: boolean;
  /** The tests an item is put through, in words. */
  conditions: string[];
  looked: number;
  /** The items that made the test true, with the conditions each met. Null when the list could not be counted. */
  counted: Array<{ id: string; met: string[] }> | null;
}

export interface SignalSettingEvidence {
  key: SettingKey;
  /** Null for all four when the release does not declare the setting. */
  label: string | null;
  value: number | null;
  ownerRole: string | null;
  unit: string | null;
}

/** Design 17.1: what `explain` shows for a signal. */
export interface SignalEvidence {
  inputs: SignalInputEvidence[];
  lists: SignalListEvidence[];
  /** The formula in words, rendered from the fixed vocabulary. */
  formula: string;
  /** The figures the formula worked out on the way, in words. */
  workings: string[];
  settings: SignalSettingEvidence[];
  rule: { signalId: string; name: string; status: SignalRule['status'] };
  release: { version: string; checksum: string };
  result: string;
}

export interface SignalResult {
  signalId: string;
  status: 'fired' | 'clear' | 'not_worked_out';
  /** Only when fired. */
  severity?: string;
  /** The severity when fired, `clear`, or the plain sentence saying what was not worked out. */
  result: string;
  /** Only when not worked out. */
  reason?: SignalReason;
  /** The inputs, settings or lists the reason names. Only when not worked out. */
  names?: string[];
  /** The sentences the assistant may use. Only when fired. */
  wording?: string[];
  evidence: SignalEvidence;
}

/** Stops an evaluation: the signal cannot be worked out, and `names` says which input, setting or list is the reason. */
export class SignalProblem extends Error {
  constructor(readonly reason: SignalReason, readonly names: string[], readonly detail: string) {
    super(detail);
  }
}

/** The sentence for a signal that was not worked out (the wording of the error table). */
export function notWorkedOutText(problem: SignalProblem): string {
  const list = problem.names.join(', ');
  const many = problem.names.length > 1;
  switch (problem.reason) {
    case 'signal_input_unavailable': return `Not worked out: ${list} ${many ? 'are' : 'is'} not available.`;
    case 'setting_missing': return `Not worked out: no ${list} ${many ? 'have' : 'has'} been set.`;
    case 'divisor_zero': return `Not worked out: ${list} ${many ? 'are' : 'is'} zero or missing.`;
    case 'draft': return 'Not worked out: this signal is still a draft.';
    case 'input_unusable': return `Not worked out: ${problem.detail}.`;
  }
}

/** Only the stamp's own fields, so nothing else a caller attached to it travels into the evidence. */
export function copySource(source: SignalSource): SignalSource {
  return {
    system: source.system,
    ...(source.displayName !== undefined ? { displayName: source.displayName } : {}),
    ...(source.sample !== undefined ? { sample: source.sample } : {}),
    ...(source.tool !== undefined ? { tool: source.tool } : {}),
    authority: source.authority,
    sourceUpdatedAt: source.sourceUpdatedAt,
    retrievedAt: source.retrievedAt,
    ...(source.fromCache !== undefined ? { fromCache: source.fromCache } : {}),
    ...(source.asOf !== undefined ? { asOf: { kind: source.asOf.kind, at: source.asOf.at } } : {}),
  };
}

export function asOfText(source: SignalSource): string {
  if (source.asOf !== undefined) return source.asOf.kind === 'as_of' ? `as of ${source.asOf.at}` : `as read at ${source.asOf.at}`;
  return source.sourceUpdatedAt !== null ? `as of ${source.sourceUpdatedAt}` : `as read at ${source.retrievedAt}`;
}

/** A value as a person reads it: a number as its exact decimal, money with its currency, text as it is. */
export function plainValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    const exactValue = fromJsNumber(value);
    return exactValue ? formatExact(exactValue) : String(value);
  }
  const money = readAmount(value);
  if (money) return `${formatExact(money.amount)} ${money.currency}`;
  return JSON.stringify(value) ?? '';
}

/** The evidence as plain lines, for `explain` and for tests. */
export function signalEvidenceText(evidence: SignalEvidence): string {
  const lines: string[] = [];
  lines.push(`${evidence.rule.name} (${evidence.rule.signalId}), ${evidence.rule.status}.`);
  lines.push(`Result: ${evidence.result.endsWith('.') ? evidence.result : `${evidence.result}.`}`);
  for (const input of evidence.inputs) {
    const head = `Input ${input.name} (${input.fact})`;
    if (input.problem) {
      const system = input.problem.system ? `, ${input.problem.system}` : '';
      lines.push(`${head}: not usable (${input.problem.reason}${system}).`);
      continue;
    }
    const where = input.source ? `, from ${input.source.system}${input.source.sample ? ' (sample data)' : ''}, ${input.asOf}` : '';
    lines.push(`${head}: ${plainValue(input.value)}${where}.`);
  }
  for (const list of evidence.lists) {
    const tests = list.conditions.join('; ');
    if (list.counted === null) {
      lines.push(`List ${list.over}: not counted, because the list is not complete (tests: ${tests}).`);
      continue;
    }
    const counted = list.counted.map((item) => `${item.id} (${item.met.join('; ')})`).join(', ');
    lines.push(`List ${list.over}: looked at ${list.looked}, counted ${list.counted.length}${counted ? `: ${counted}` : ''} (tests: ${tests}).`);
  }
  lines.push(`Formula: ${evidence.formula}.`);
  for (const working of evidence.workings) lines.push(`Working: ${working}.`);
  for (const setting of evidence.settings) {
    if (setting.label === null) {
      lines.push(`Setting ${setting.key}: not declared in this release.`);
      continue;
    }
    lines.push(`Setting ${setting.key} (${setting.label}, owner ${setting.ownerRole}, ${setting.unit}): ${setting.value === null ? 'not set' : plainValue(setting.value)}.`);
  }
  lines.push(`Release ${evidence.release.version}, checksum ${evidence.release.checksum}.`);
  return lines.join('\n');
}
