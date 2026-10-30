import type { Binding, JaxOntologyRelease, MeaningContract } from '../model';
import { isUnknownLine, targetName } from './compare';
import type { MeaningContractLine } from './compare';

/** The lines that can say 'unknown'. The as-of line always names a time. */
export type UnknownContractLine = Exclude<MeaningContractLine, 'asOf'>;

const LINES_THAT_CAN_BE_UNKNOWN: readonly UnknownContractLine[] = ['unit', 'currency', 'tax', 'counts'];

const AUTHORITY_ORDER: Record<Binding['authority'], number> = { source_of_truth: 0, cross_check: 1, fallback: 2 };

/** One binding with a line the owner has not settled yet. */
export interface UnknownContractEntry {
  /** The fact or link the binding fills, for example 'Account.balance'. */
  factOrLink: string;
  bindingId: string;
  system: string;
  tool: string;
  authority: Binding['authority'];
  /** The lines that say 'unknown', in the order unit, currency, tax, counts. */
  unknownLines: UnknownContractLine[];
  /** A copy of the whole contract, so the owner sees the lines that are settled beside the ones that are not. */
  contract: MeaningContract;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The first-pass list of design 17.2: every binding with a line that says 'unknown', so the owner can settle them in one sitting.
 * One entry per binding, because a fact read from two systems has two contracts. Sorted by fact or link, then source of truth before
 * cross check before fallback, then binding id, so the same block always gives the same list.
 */
export function listUnknownContracts(block: Pick<JaxOntologyRelease, 'bindings'>): UnknownContractEntry[] {
  return block.bindings
    .flatMap((binding): UnknownContractEntry[] => {
      const unknownLines = LINES_THAT_CAN_BE_UNKNOWN.filter((line) => isUnknownLine(binding.contract[line]));
      if (unknownLines.length === 0) return [];
      return [{
        factOrLink: targetName(binding), bindingId: binding.bindingId, system: binding.system, tool: binding.tool, authority: binding.authority,
        unknownLines, contract: { ...binding.contract },
      }];
    })
    .sort((a, b) => compareText(a.factOrLink, b.factOrLink) || AUTHORITY_ORDER[a.authority] - AUTHORITY_ORDER[b.authority] || compareText(a.bindingId, b.bindingId));
}
