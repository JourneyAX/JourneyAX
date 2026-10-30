import type { FactPath, Formula, ListOperand, Operand, SettingKey } from '../model';
import { SignalProblem, type SignalInputFact, type SignalListEvidence } from './evidence';

/** One row of a list. The fields a link item has: the facts are keyed by fact path, for example 'Ticket.priority'. */
export interface SignalListItem {
  key: { value: string };
  canonicalId?: string;
  facts: Readonly<Record<string, SignalInputFact>>;
}

/** The rows behind one link, for example 'Account.tickets'. */
export interface SignalListInput {
  items: readonly SignalListItem[];
  /** True only when nothing was cut and every system that holds the list answered. A list that is not whole is never counted as if it were. */
  complete: boolean;
}

export const itemId = (item: SignalListItem): string => item.canonicalId ?? item.key.value;

/**
 * Every operand of a formula, depth first, with whether it sits inside the test of a list operand. A nested formula operand is walked
 * into; so is the `where` of a list operand (flagged), because a setting or an item fact read there counts.
 */
export function walkOperands(formula: Formula, visit: (operand: Operand, insideList: boolean) => void, insideList = false): void {
  const take = (operand: Operand): void => {
    visit(operand, insideList);
    if ('formula' in operand) walkOperands(operand.formula, visit, insideList);
    else if ('over' in operand) walkOperands(operand.where, visit, true);
  };
  switch (formula.op) {
    case 'ratio': take(formula.num); take(formula.den); return;
    case 'compare': take(formula.left); take(formula.right); return;
    case 'age': case 'count': case 'positive': case 'is_past': case 'any': take(formula.of); return;
    case 'and': case 'or': for (const child of formula.of) walkOperands(child, visit, insideList); return;
  }
}

/** The facts of a list's items that a formula reads: an input inside a list operand's test that is written 'Thing.name'. */
export function itemFactsRead(formula: Formula): FactPath[] {
  const found: FactPath[] = [];
  walkOperands(formula, (operand, insideList) => {
    if (insideList && 'input' in operand && operand.input.includes('.') && !found.includes(operand.input)) found.push(operand.input);
  });
  return found;
}

/** The settings a formula reads, anywhere in it, in the order they first appear. */
export function settingsRead(formula: Formula): SettingKey[] {
  const found: SettingKey[] = [];
  walkOperands(formula, (operand) => {
    if ('setting' in operand && !found.includes(operand.setting)) found.push(operand.setting);
  });
  return found;
}

/**
 * The tests an item is put through. An `and` or an `or` is split into its parts so that the evidence can say which part each counted
 * item met; any other test is the one part.
 */
export const conditionsOf = (where: Formula): Formula[] => (where.op === 'and' || where.op === 'or' ? where.of : [where]);

/**
 * Counts the items of a list that pass a test. The list must be whole: a cut list or a list a system did not answer for gives no count
 * at all (a count of zero would say "there are none"). `testCondition` runs one part of the test on one item; `words` writes a part in
 * words for the evidence. What happened is added to `record`.
 */
export function evaluateListOperand(
  operand: ListOperand,
  use: SignalListEvidence['use'],
  lists: Readonly<Record<string, SignalListInput>>,
  record: SignalListEvidence[],
  testCondition: (condition: Formula, item: SignalListItem) => boolean,
  words: (formula: Formula) => string,
): number {
  const conditions = conditionsOf(operand.where);
  const conditionWords = conditions.map(words);
  const list = lists[operand.over];
  if (!list || !list.complete) {
    record.push({ over: operand.over, use, complete: false, conditions: conditionWords, looked: list ? list.items.length : 0, counted: null });
    throw new SignalProblem('signal_input_unavailable', [operand.over], `${operand.over} is ${list ? 'not complete' : 'not supplied'}`);
  }
  const counted: Array<{ id: string; met: string[] }> = [];
  for (const item of list.items) {
    const results = conditions.map((condition) => testCondition(condition, item));
    const passes = operand.where.op === 'or' ? results.some(Boolean) : results.every(Boolean);
    if (passes) counted.push({ id: itemId(item), met: conditionWords.filter((_, index) => results[index]) });
  }
  record.push({ over: operand.over, use, complete: true, conditions: conditionWords, looked: list.items.length, counted });
  return counted.length;
}
