import { ContractChangeSchema } from '../model';
import type { Binding, ContractChange, JaxOntologyRelease, MeaningContract } from '../model';

/**
 * The release check on meaning (R7). A fact that is read from another system or tool must still mean the same thing: the five lines
 * of its contract equal the old ones, or a person has written the difference down as a contract change and signed it. Nothing is
 * converted here; a conversion is a rule that someone writes in the contract change.
 */

/** The five lines of a meaning contract, as the design lists them. The label of a tax belongs to the tax line. */
export type MeaningContractLine = 'unit' | 'currency' | 'tax' | 'asOf' | 'counts';

export const MEANING_CONTRACT_LINES: readonly MeaningContractLine[] = ['unit', 'currency', 'tax', 'asOf', 'counts'];

export interface ContractLineDifference {
  line: MeaningContractLine;
  from: string;
  to: string;
}

export interface ContractContinuityIssue {
  code: 'contract_rebind_differs' | 'contract_rebind_unsigned' | 'contract_rebind_no_conversion_rule';
  severity: 'error' | 'warning';
  /** Where in the next block, written as the dictionary checks write it: the contract of the new binding, or the contract change. */
  path: string;
  message: string;
  /** The fact or link that was re-bound. */
  factOrLink: string;
  /** The lines that differ between the old contract and the new one. */
  differences: ContractLineDifference[];
}

/** What the check reads of a release block. */
export type ContractContinuityBlock = Pick<JaxOntologyRelease, 'bindings' | 'contractChanges'>;

/** The lines whose value changes when the unit, the currency or the tax basis changes. */
const CONVERTIBLE_LINES: readonly MeaningContractLine[] = ['unit', 'currency', 'tax'];

const collapse = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** True for the word 'unknown', however it is capitalised or spaced. */
export const isUnknownLine = (text: string): boolean => collapse(text).toLowerCase() === 'unknown';

const isKnownLine = (text: string): boolean => !isUnknownLine(text) && text !== 'not_applicable';

/** What one line says, with spacing tidied so that two lines differ only when their words do. */
function lineText(contract: MeaningContract, line: MeaningContractLine): string {
  const label = line === 'tax' && contract.taxLabel ? collapse(contract.taxLabel) : '';
  const text = collapse(contract[line]);
  const value = label ? `${text} (${label})` : text;
  return isUnknownLine(value) ? 'unknown' : value;
}

export function contractDifferences(from: MeaningContract, to: MeaningContract): ContractLineDifference[] {
  return MEANING_CONTRACT_LINES
    .filter((line) => lineText(from, line) !== lineText(to, line))
    .map((line) => ({ line, from: lineText(from, line), to: lineText(to, line) }));
}

const sameContract = (a: MeaningContract, b: MeaningContract): boolean => contractDifferences(a, b).length === 0;

const { approvedBy, approvedAt } = ContractChangeSchema.shape;

/** A contract change counts only with a name and a real time, judged by the same schema that reads the block. */
export const isSignedChange = (change: ContractChange): boolean =>
  approvedBy.safeParse(change.approvedBy).success && approvedAt.safeParse(change.approvedAt).success;

export const targetName = (binding: Binding): string => (binding.target.kind === 'fact' ? binding.target.fact : binding.target.link);

const pairName = (binding: Binding): string => `${binding.system}.${binding.tool}`;

interface Placed {
  binding: Binding;
  index: number;
}

const place = (bindings: Binding[]): Placed[] => bindings.map((binding, index) => ({ binding, index }));

function groupBy(items: Placed[], key: (item: Placed) => string): Map<string, Placed[]> {
  const groups = new Map<string, Placed[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/** A fact or a link, and the part it plays: each authority is checked on its own. */
const slotOf = ({ binding }: Placed): string => `${binding.target.kind} ${targetName(binding)} ${binding.authority}`;

/** The bindings of every system and tool that has more of them in `from` than in `against`. */
function surplus(from: Map<string, Placed[]>, against: Map<string, Placed[]>): Placed[] {
  return [...from].filter(([pair, group]) => group.length > (against.get(pair)?.length ?? 0)).flatMap(([, group]) => group);
}

const quote = (text: string): string => JSON.stringify(text);

const describeDifferences = (differences: ContractLineDifference[]): string =>
  differences.map((difference) => `${difference.line} was ${quote(difference.from)}, now ${quote(difference.to)}`).join('; ');

const hasConversionRule = (change: ContractChange): boolean => collapse(change.conversionRule ?? '') !== '';

interface PlacedChange {
  change: ContractChange;
  index: number;
}

/** The contract changes that record exactly this move: this fact or link, from one of the old contracts to the new one. */
function recordedMoves(arrived: Placed, departed: Placed[], changes: PlacedChange[]): PlacedChange[] {
  const name = targetName(arrived.binding);
  return changes.filter(({ change }) => change.factOrLink === name
    && sameContract(change.to, arrived.binding.contract)
    && departed.some(({ binding }) => sameContract(change.from, binding.contract)));
}

function checkArrival(arrived: Placed, departed: Placed[], changes: PlacedChange[]): ContractContinuityIssue[] {
  const name = targetName(arrived.binding);
  const nearest = departed
    .map(({ binding }) => contractDifferences(binding.contract, arrived.binding.contract))
    .reduce((best, candidate) => (candidate.length < best.length ? candidate : best));
  if (nearest.length === 0) return [];

  const recorded = recordedMoves(arrived, departed, changes);
  const signed = recorded.filter(({ change }) => isSignedChange(change));
  const moved = `${name} moved from ${[...new Set(departed.map(({ binding }) => pairName(binding)))].join(', ')} to ${pairName(arrived.binding)} and its meaning changed: ${describeDifferences(nearest)}.`;
  const path = `bindings[${arrived.index}].contract`;

  if (signed.length === 0 && recorded.length > 0) {
    return [{ code: 'contract_rebind_unsigned', severity: 'error', path, message: `${moved} The contract change recorded for it is not signed: it needs the name of a person and a time.`, factOrLink: name, differences: nearest }];
  }
  if (signed.length === 0) {
    const other = changes.some(({ change }) => change.factOrLink === name)
      ? ` A contract change is recorded for ${name}, but its old and new lines are not these.`
      : '';
    return [{ code: 'contract_rebind_differs', severity: 'error', path, message: `${moved} Make the new contract equal the old one, or record the difference as a contract change that names a person and a time.${other}`, factOrLink: name, differences: nearest }];
  }

  const written = signed.find(({ change }) => hasConversionRule(change)) ?? signed[0];
  const converted = contractDifferences(written.change.from, written.change.to)
    .filter((difference) => CONVERTIBLE_LINES.includes(difference.line) && isKnownLine(difference.from) && isKnownLine(difference.to));
  if (hasConversionRule(written.change) || converted.length === 0) return [];
  return [{
    code: 'contract_rebind_no_conversion_rule', severity: 'warning', path: `contractChanges[${written.index}]`,
    message: `The contract change for ${name} moves ${converted.map((difference) => difference.line).join(', ')} from one known value to another but gives no conversion rule. Write how a value is converted, or write that none is.`,
    factOrLink: name, differences: converted,
  }];
}

/**
 * R7. Compares the bindings of the next block with those of the previous release. A fact or link counts as re-bound when, for one of
 * its authorities (source of truth, cross check, fallback), a system and tool that held it is gone and another has taken its place. A
 * new fact, a new binding, a removed binding and a change of contract on the same system and tool are not re-binds: the last is how
 * an unknown is settled. For every re-bind, the new contract must equal the old one line by line, or the next block must hold a
 * signed contract change from the old lines to the new. Unknown to known and known to unknown are differences. The answer follows the
 * order of the next block's bindings and is empty when nothing was re-bound or every re-bind keeps its meaning.
 */
export function checkContractContinuity(previousBlock: ContractContinuityBlock, nextBlock: ContractContinuityBlock): ContractContinuityIssue[] {
  const before = groupBy(place(previousBlock.bindings), slotOf);
  const changes = nextBlock.contractChanges.map((change, index) => ({ change, index }));
  const issues: ContractContinuityIssue[] = [];
  for (const [slot, now] of groupBy(place(nextBlock.bindings), slotOf)) {
    const was = before.get(slot);
    if (!was) continue;
    const pairsWas = groupBy(was, ({ binding }) => pairName(binding));
    const pairsNow = groupBy(now, ({ binding }) => pairName(binding));
    const departed = surplus(pairsWas, pairsNow);
    const arrived = surplus(pairsNow, pairsWas);
    if (departed.length === 0 || arrived.length === 0) continue;
    for (const move of arrived) issues.push(...checkArrival(move, departed, changes));
  }
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code} ${issue.path}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
