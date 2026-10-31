import type { FactPath, SettingDef, SignalRule } from '../model';
import { compareExact, exact, fromJsNumber, type ExactNumber } from './decimal';
import {
  asOfText, copySource, notWorkedOutText, SignalProblem,
  type SignalEvidence, type SignalInputEvidence, type SignalInputFact, type SignalResult, type SignalSettingEvidence,
} from './evidence';
import { parseTime, readValue, renderFormula, runFormula, type FormulaState, type SignalValue } from './formula';
import { itemFactsRead, settingsRead, type SignalListInput } from './list';

/** Time comes from here, never from the machine: a test or a replay sees the same answer. Structurally the shared `Clock` port. */
export interface SignalClock {
  now(): Date;
}

/** The facts the person asking may see: a set of fact paths, or a test for one. */
export type SignalVisibleFacts = ReadonlySet<string> | ((fact: FactPath) => boolean);

export interface SignalContext {
  release: { version: string; checksum: string };
  /** Every setting of the release, with its owner role and its value (`null`: not set). */
  settings: readonly SettingDef[];
  clock: SignalClock;
  visible: SignalVisibleFacts;
  /** The facts that were read, by fact path. A fact that was not read is simply not here. */
  facts: Readonly<Record<string, SignalInputFact>>;
  /** The rows behind the links the signals count over, by link name. */
  lists: Readonly<Record<string, SignalListInput>>;
}

type RuleInput = SignalRule['inputs'][number];

interface InputCheck {
  entry: SignalInputEvidence;
  value?: SignalValue;
  /** The input cannot be used because it is missing, stale, too old or from the wrong kind of source. */
  unavailable?: true;
  /** The input is there but of a kind the formula cannot use; the sentence says why. */
  unusable?: string;
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** The facts a signal needs to be shown: its declared inputs, and the facts of the rows its list operands test. */
export function signalInputFacts(rule: SignalRule): FactPath[] {
  return unique([...rule.inputs.map((input) => input.fact), ...itemFactsRead(rule.formula)]);
}

/** How long a freshness setting's unit is, in milliseconds. Null for a unit that is not a length of time. */
function settingUnitMs(unit: SettingDef['unit']): bigint | null {
  switch (unit) {
    case 'milliseconds': return 1n;
    case 'seconds': return 1_000n;
    case 'days': return 86_400_000n;
    default: return null;
  }
}

function checkInput(input: RuleInput, context: SignalContext, settings: ReadonlyMap<string, SettingDef>, nowMs: number): InputCheck {
  const fact = context.facts[input.fact];
  if (!fact) return { entry: { name: input.name, fact: input.fact, status: 'not_available', problem: { reason: 'not_supplied' } }, unavailable: true };
  const entry: SignalInputEvidence = { name: input.name, fact: input.fact, status: fact.status };
  if (fact.status !== 'not_available' && fact.value !== undefined) entry.value = structuredClone(fact.value);
  if (fact.source) {
    entry.source = copySource(fact.source);
    entry.asOf = asOfText(fact.source);
  }
  const refuse = (reason: string, system?: string): InputCheck => ({ entry: { ...entry, problem: system ? { reason, system } : { reason } }, unavailable: true });
  if (fact.status === 'not_available') return refuse(fact.unavailable?.reason ?? 'not_available', fact.unavailable?.system);
  if (fact.status === 'stale') return refuse('stale');
  if (fact.value === undefined || fact.value === null) return refuse('no_value');
  if (fact.atLeast) return refuse('at_least_only');
  if (input.requireAuthority !== undefined && fact.source?.authority !== input.requireAuthority) return refuse('wrong_authority');
  const limit = input.maxAge === undefined ? undefined : settings.get(input.maxAge);
  if (limit && limit.value !== null) {
    const unitMs = settingUnitMs(limit.unit);
    const allowed = fromJsNumber(limit.value);
    if (unitMs === null || allowed === null) return { entry, unusable: `${input.maxAge} is not a length of time` };
    // The age that counts is the time since we read the value, not the time since the source last changed it.
    const read = fact.source ? parseTime(fact.source.retrievedAt) : null;
    if (!read || read.dateOnly) return refuse('unknown_age');
    if (compareExact(exact(BigInt(nowMs - read.ms)), exact(allowed.num * unitMs, allowed.den)) > 0) return refuse('older_than_limit');
  }
  const value = readValue(fact.value);
  return value ? { entry, value } : { entry, unusable: `${input.name} is not a value a formula can use` };
}

function settingEvidence(key: string, settings: ReadonlyMap<string, SettingDef>): SignalSettingEvidence {
  const setting = settings.get(key);
  return setting
    ? { key, label: setting.label, value: setting.value, ownerRole: setting.ownerRole, unit: setting.unit }
    : { key, label: null, value: null, ownerRole: null, unit: null };
}

function instant(clock: SignalClock): number {
  const ms = clock.now().getTime();
  if (!Number.isFinite(ms)) throw new RangeError('the clock did not give a valid time');
  return ms;
}

function evaluateAt(rule: SignalRule, context: SignalContext, nowMs: number): SignalResult | null {
  const mayRead = typeof context.visible === 'function' ? context.visible : (fact: FactPath) => (context.visible as ReadonlySet<string>).has(fact);
  // A signal with one input the person may not see is absent, like a denied fact: no result, no hint, nothing in any evidence. This is
  // decided first, before a draft or an unset setting could say anything about it.
  if (!signalInputFacts(rule).every(mayRead)) return null;

  const settings = new Map(context.settings.map((setting) => [setting.key, setting] as const));
  const needed = unique([...rule.settings, ...settingsRead(rule.formula)]);
  const limits = rule.inputs.flatMap((input) => (input.maxAge === undefined ? [] : [input.maxAge]));
  const checks = rule.inputs.map((input) => checkInput(input, context, settings, nowMs));

  const values = new Map<string, ExactNumber>();
  const lacking: string[] = [];
  for (const key of needed) {
    const setting = settings.get(key);
    const q = setting && setting.value !== null ? fromJsNumber(setting.value) : null;
    if (q) values.set(key, q);
    else lacking.push(key);
  }
  for (const key of unique(limits)) if (!settings.has(key) && !lacking.includes(key)) lacking.push(key);

  const inputValues = new Map<string, SignalValue>();
  const state: FormulaState = { nowMs, inputs: inputValues, settings: values, lists: context.lists, workings: [], listEvidence: [] };
  let problem: SignalProblem | undefined;
  let fired = false;
  try {
    if (lacking.length > 0) throw new SignalProblem('setting_missing', lacking, `${lacking.join(', ')} holds no value`);
    if (rule.status === 'draft') throw new SignalProblem('draft', [], 'the signal is a draft');
    const unavailable = rule.inputs.filter((_, index) => checks[index].unavailable).map((input) => input.name);
    if (unavailable.length > 0) throw new SignalProblem('signal_input_unavailable', unavailable, `${unavailable.join(', ')} not available`);
    const unusable = checks.find((check) => check.unusable !== undefined);
    if (unusable) throw new SignalProblem('input_unusable', [unusable.entry.name], unusable.unusable ?? '');
    checks.forEach((check) => {
      if (check.value) inputValues.set(check.entry.name, check.value);
    });
    const outcome = runFormula(rule.formula, state);
    if (outcome.kind !== 'boolean') {
      throw new SignalProblem('input_unusable', [renderFormula(rule.formula)], `${renderFormula(rule.formula)} does not give a yes or no`);
    }
    fired = outcome.value;
  } catch (error) {
    if (!(error instanceof SignalProblem)) throw error;
    problem = error;
  }

  const result = problem ? notWorkedOutText(problem) : fired ? rule.severity : 'clear';
  const evidence: SignalEvidence = {
    inputs: checks.map((check) => check.entry),
    lists: state.listEvidence,
    formula: renderFormula(rule.formula),
    workings: state.workings,
    settings: unique([...needed, ...limits]).map((key) => settingEvidence(key, settings)),
    rule: { signalId: rule.signalId, name: rule.name, status: rule.status },
    release: { version: context.release.version, checksum: context.release.checksum },
    result,
  };
  if (problem) return { signalId: rule.signalId, status: 'not_worked_out', result, reason: problem.reason, names: [...problem.names], evidence };
  if (fired) return { signalId: rule.signalId, status: 'fired', severity: rule.severity, result, wording: [...rule.wording], evidence };
  return { signalId: rule.signalId, status: 'clear', result, evidence };
}

/**
 * Works out one signal from facts that have already been read. `fired` or `clear` only when every input is present, fresh, from the
 * source the rule asks for, and every setting it reads holds a value; otherwise `not_worked_out`, naming what was missing. A draft
 * signal never fires. Returns null when the person may not see one of its inputs: the signal is absent for them, as a denied fact is.
 */
export function evaluateSignal(rule: SignalRule, context: SignalContext): SignalResult | null {
  return evaluateAt(rule, context, instant(context.clock));
}

/** Several signals at one instant. A signal the person may not see is left out. */
export function evaluateSignals(rules: readonly SignalRule[], context: SignalContext): SignalResult[] {
  const nowMs = instant(context.clock);
  return rules.flatMap((rule) => {
    const result = evaluateAt(rule, context, nowMs);
    return result ? [result] : [];
  });
}
