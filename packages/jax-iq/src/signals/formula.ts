import type { Formula, ListOperand, Operand } from '../model';
import { compareExact, divideExact, exact, formatExact, fromJsNumber, parseExact, readAmount, signOf, type ExactNumber } from './decimal';
import { SignalProblem, type SignalListEvidence } from './evidence';
import { evaluateListOperand, itemId, type SignalListInput, type SignalListItem } from './list';

/** What a formula works with. A list-valued fact is carried by its length only: nothing reads its members. */
export type SignalValue =
  | { kind: 'number'; q: ExactNumber; currency?: string }
  | { kind: 'text'; text: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'list'; length: number };

type NumberValue = Extract<SignalValue, { kind: 'number' }>;
type CompareFormula = Extract<Formula, { op: 'compare' }>;

/** Everything one evaluation reads and writes. Inputs and settings are already checked: what is in the maps is usable. */
export interface FormulaState {
  nowMs: number;
  /** The rule's declared inputs, by name. */
  inputs: ReadonlyMap<string, SignalValue>;
  /** The settings that hold a value, by key. */
  settings: ReadonlyMap<string, ExactNumber>;
  lists: Readonly<Record<string, SignalListInput>>;
  workings: string[];
  listEvidence: SignalListEvidence[];
}

/** A day is the same length everywhere in UTC, so this is a fact of the calendar and not a setting. */
const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_AND_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const CMP_WORDS: Record<CompareFormula['cmp'], string> = {
  gt: 'is above',
  gte: 'is at or above',
  lt: 'is below',
  lte: 'is at or below',
  eq: 'is',
};

/** The start of a calendar day in UTC, or null when there is no such day (no 30 February). */
function startOfDay(year: number, month: number, day: number): number | null {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date.getTime() : null;
}

/**
 * Reads a date ('2026-09-01') or a date and time with a zone ('2026-09-01T10:00:00Z'). A time with no zone is not read: it would be
 * a guess at where in the world it was written. A date alone stands for the whole calendar day, in UTC.
 */
export function parseTime(text: string): { ms: number; dateOnly: boolean } | null {
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const ms = startOfDay(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
    return ms === null ? null : { ms, dateOnly: true };
  }
  const dateAndTime = DATE_AND_TIME.exec(text);
  if (!dateAndTime || startOfDay(Number(dateAndTime[1]), Number(dateAndTime[2]), Number(dateAndTime[3])) === null) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : { ms, dateOnly: false };
}

/** A fact's value as a formula value. Null when it is a kind no formula can use. */
export function readValue(raw: unknown): SignalValue | null {
  if (typeof raw === 'number') {
    const q = fromJsNumber(raw);
    return q ? { kind: 'number', q } : null;
  }
  if (typeof raw === 'string') return { kind: 'text', text: raw };
  if (typeof raw === 'boolean') return { kind: 'boolean', value: raw };
  if (Array.isArray(raw)) return { kind: 'list', length: raw.length };
  const money = readAmount(raw);
  return money ? { kind: 'number', q: money.amount, currency: money.currency } : null;
}

const needsBrackets = (formula: Formula): boolean => formula.op !== 'ratio' && formula.op !== 'age' && formula.op !== 'count';

/** The formula in words, from the fixed vocabulary. It reads the rule alone: no value goes into it. */
export function renderFormula(formula: Formula): string {
  switch (formula.op) {
    case 'ratio': return `${renderOperand(formula.num)} divided by ${renderOperand(formula.den)}`;
    case 'compare': return `${renderOperand(formula.left)} ${CMP_WORDS[formula.cmp]} ${renderOperand(formula.right)}`;
    case 'age': return `the age of ${renderOperand(formula.of)} in ${formula.unit}`;
    case 'count': return `the number of ${renderOperand(formula.of)}`;
    case 'any': return `any of ${renderOperand(formula.of)}`;
    case 'and': return formula.of.map((child) => (child.op === 'and' || child.op === 'or' ? `(${renderFormula(child)})` : renderFormula(child))).join(' and ');
    case 'or': return formula.of.map((child) => (child.op === 'and' || child.op === 'or' ? `(${renderFormula(child)})` : renderFormula(child))).join(' or ');
    case 'positive': return `${renderOperand(formula.of)} is above zero`;
    case 'is_past': return `${renderOperand(formula.of)} is in the past`;
  }
}

export function renderOperand(operand: Operand): string {
  if ('input' in operand) return operand.input;
  if ('setting' in operand) return operand.setting;
  if ('text' in operand) return `'${operand.text}'`;
  if ('formula' in operand) return needsBrackets(operand.formula) ? `(${renderFormula(operand.formula)})` : renderFormula(operand.formula);
  return `${operand.over} where ${renderFormula(operand.where)}`;
}

/** What a reason names: an input or a setting by its own name, anything else in words. */
const nameOf = (operand: Operand): string => ('input' in operand ? operand.input : 'setting' in operand ? operand.setting : renderOperand(operand));

const unusable = (names: string[], detail: string): SignalProblem => new SignalProblem('input_unusable', names, detail);

function show(value: SignalValue): string {
  switch (value.kind) {
    case 'number': return value.currency ? `${formatExact(value.q)} ${value.currency}` : formatExact(value.q);
    case 'text': return `'${value.text}'`;
    case 'boolean': return value.value ? 'yes' : 'no';
    case 'list': return `${value.length} entries`;
  }
}

const yesNoText = (value: boolean): string => (value ? 'yes' : 'no');

function note(state: FormulaState, item: SignalListItem | undefined, text: string): void {
  if (!item) state.workings.push(text);
}

function unitLength(unit: Extract<Formula, { op: 'age' }>['unit']): bigint {
  switch (unit) {
    case 'days': return BigInt(DAY_MS);
    case 'hours': return 3_600_000n;
    case 'minutes': return 60_000n;
  }
}

function inputValue(name: string, state: FormulaState, item: SignalListItem | undefined): SignalValue {
  if (item) {
    const fact = item.facts[name];
    const where = `${name} on ${itemId(item)}`;
    if (!fact || fact.status !== 'ok' || fact.value === undefined || fact.value === null) {
      throw new SignalProblem('signal_input_unavailable', [name], `${where} is not available`);
    }
    const value = readValue(fact.value);
    if (!value) throw unusable([name], `${where} is not a value a formula can use`);
    return value;
  }
  const value = state.inputs.get(name);
  if (!value) throw unusable([name], `the formula reads ${name}, which the rule does not declare`);
  return value;
}

function operandValue(operand: Operand, state: FormulaState, item: SignalListItem | undefined): SignalValue {
  if ('input' in operand) return inputValue(operand.input, state, item);
  if ('setting' in operand) {
    const q = state.settings.get(operand.setting);
    if (!q) throw new SignalProblem('setting_missing', [operand.setting], `${operand.setting} holds no value`);
    return { kind: 'number', q };
  }
  if ('formula' in operand) return runFormula(operand.formula, state, item);
  if ('text' in operand) return { kind: 'text', text: operand.text };
  return { kind: 'number', q: exact(BigInt(countItems(operand, 'number', state, item))) };
}

function countItems(operand: ListOperand, use: SignalListEvidence['use'], state: FormulaState, item: SignalListItem | undefined): number {
  if (item) throw unusable([operand.over], `${operand.over} is a list inside the test of another list`);
  return evaluateListOperand(
    operand,
    use,
    state.lists,
    state.listEvidence,
    (condition, listItem) => yesNo(runFormula(condition, state, listItem), condition),
    renderFormula,
  );
}

function numberOf(operand: Operand, state: FormulaState, item: SignalListItem | undefined): NumberValue {
  const value = operandValue(operand, state, item);
  if (value.kind === 'number') return value;
  if (value.kind === 'text') {
    const q = parseExact(value.text);
    if (q) return { kind: 'number', q };
  }
  throw unusable([nameOf(operand)], `${renderOperand(operand)} is not a number`);
}

function yesNo(value: SignalValue, formula: Formula): boolean {
  if (value.kind !== 'boolean') throw unusable([renderFormula(formula)], `${renderFormula(formula)} does not give a yes or no`);
  return value.value;
}

function timeOf(operand: Operand, state: FormulaState, item: SignalListItem | undefined): { ms: number; dateOnly: boolean; text: string } {
  const value = operandValue(operand, state, item);
  const time = value.kind === 'text' ? parseTime(value.text) : null;
  if (!time || value.kind !== 'text') throw unusable([nameOf(operand)], `${renderOperand(operand)} is not a date, or a date and time with a zone`);
  return { ...time, text: value.text };
}

const numericAgainst = (value: SignalValue, other: SignalValue): NumberValue | null => {
  if (value.kind === 'number') return value;
  if (value.kind === 'text' && other.kind === 'number') {
    const q = parseExact(value.text);
    return q ? { kind: 'number', q } : null;
  }
  return null;
};

const satisfies = (cmp: CompareFormula['cmp'], order: number): boolean => {
  switch (cmp) {
    case 'gt': return order > 0;
    case 'gte': return order >= 0;
    case 'lt': return order < 0;
    case 'lte': return order <= 0;
    case 'eq': return order === 0;
  }
};

/** Numbers compare as numbers (a text is read as a number only against a number); texts are equal or not, or are dates; yes/no is equal or not. */
function compareValues(formula: CompareFormula, left: SignalValue, right: SignalValue): boolean {
  const names = [nameOf(formula.left), nameOf(formula.right)];
  const leftNumber = numericAgainst(left, right);
  const rightNumber = numericAgainst(right, left);
  if (leftNumber && rightNumber) {
    if (leftNumber.currency && rightNumber.currency && leftNumber.currency !== rightNumber.currency) {
      throw unusable(names, `${renderOperand(formula.left)} and ${renderOperand(formula.right)} are in different currencies`);
    }
    return satisfies(formula.cmp, compareExact(leftNumber.q, rightNumber.q));
  }
  if (left.kind === 'text' && right.kind === 'text') {
    if (formula.cmp === 'eq') return left.text === right.text;
    const leftTime = parseTime(left.text);
    const rightTime = parseTime(right.text);
    if (leftTime && rightTime) return satisfies(formula.cmp, leftTime.ms < rightTime.ms ? -1 : leftTime.ms > rightTime.ms ? 1 : 0);
  }
  if (left.kind === 'boolean' && right.kind === 'boolean' && formula.cmp === 'eq') return left.value === right.value;
  throw unusable(names, `${renderOperand(formula.left)} and ${renderOperand(formula.right)} cannot be compared`);
}

/**
 * Works a formula out. Everything is evaluated, left to right, with no short cut: a part that cannot be worked out stops the whole
 * thing, even when another part has already settled the answer, because a signal never rests on a guess. Inside the test of a list
 * operand `item` is the row being tested and its facts are what an input reads.
 */
export function runFormula(formula: Formula, state: FormulaState, item?: SignalListItem): SignalValue {
  switch (formula.op) {
    case 'ratio': {
      const num = numberOf(formula.num, state, item);
      const den = numberOf(formula.den, state, item);
      if (num.currency && den.currency && num.currency !== den.currency) {
        throw unusable([nameOf(formula.num), nameOf(formula.den)], `${renderOperand(formula.num)} and ${renderOperand(formula.den)} are in different currencies`);
      }
      const q = divideExact(num.q, den.q);
      if (!q) throw new SignalProblem('divisor_zero', [nameOf(formula.den)], `${renderOperand(formula.den)} is zero`);
      const value: SignalValue = { kind: 'number', q };
      note(state, item, `${renderOperand(formula.num)} (${show(num)}) divided by ${renderOperand(formula.den)} (${show(den)}) = ${show(value)}`);
      return value;
    }
    case 'compare': {
      const left = operandValue(formula.left, state, item);
      const right = operandValue(formula.right, state, item);
      const holds = compareValues(formula, left, right);
      note(state, item, `${renderOperand(formula.left)} (${show(left)}) ${CMP_WORDS[formula.cmp]} ${renderOperand(formula.right)} (${show(right)}): ${yesNoText(holds)}`);
      return { kind: 'boolean', value: holds };
    }
    case 'age': {
      const then = timeOf(formula.of, state, item);
      const value: SignalValue = { kind: 'number', q: exact(BigInt(state.nowMs - then.ms), unitLength(formula.unit)) };
      note(state, item, `the age of ${renderOperand(formula.of)} ('${then.text}') in ${formula.unit} = ${show(value)}`);
      return value;
    }
    case 'count': {
      let total: number;
      if ('over' in formula.of) {
        total = countItems(formula.of, 'count', state, item);
      } else {
        const value = operandValue(formula.of, state, item);
        if (value.kind !== 'list') throw unusable([nameOf(formula.of)], `${renderOperand(formula.of)} is not a list`);
        total = value.length;
      }
      note(state, item, `the number of ${renderOperand(formula.of)} = ${total}`);
      return { kind: 'number', q: exact(BigInt(total)) };
    }
    case 'any': {
      const found = countItems(formula.of, 'any', state, item) > 0;
      note(state, item, `any of ${renderOperand(formula.of)}: ${yesNoText(found)}`);
      return { kind: 'boolean', value: found };
    }
    case 'and': {
      const results = formula.of.map((child) => yesNo(runFormula(child, state, item), child));
      return { kind: 'boolean', value: results.every(Boolean) };
    }
    case 'or': {
      const results = formula.of.map((child) => yesNo(runFormula(child, state, item), child));
      return { kind: 'boolean', value: results.some(Boolean) };
    }
    case 'positive': {
      const value = numberOf(formula.of, state, item);
      const holds = signOf(value.q) > 0;
      note(state, item, `${renderOperand(formula.of)} (${show(value)}) is above zero: ${yesNoText(holds)}`);
      return { kind: 'boolean', value: holds };
    }
    case 'is_past': {
      const time = timeOf(formula.of, state, item);
      // A date alone is past once its whole day is over; a date and time is past once the moment has gone by.
      const holds = time.dateOnly ? state.nowMs >= time.ms + DAY_MS : time.ms < state.nowMs;
      note(state, item, `${renderOperand(formula.of)} ('${time.text}') is in the past: ${yesNoText(holds)}`);
      return { kind: 'boolean', value: holds };
    }
  }
}
