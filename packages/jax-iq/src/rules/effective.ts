import { connectorToolState, type ConnectorState, type ConnectorsExtension, type EffectiveConnectorTool } from '@journeyax/business-pack';
import type { Binding, FactPath, Formula, LinkName, Operand, SignalRule } from '../model';
import { clausesAdmit, compileRules, isStaffPerson, tablePersonOf, type CompiledRules, type RulePerson, type RulesBlock, type ToolCap } from './compile';

/**
 * What a person may use and see once the rules are applied on top of the per-tool table. The table stays the last gate: a rule can only
 * take access away. JAX IQ is for members of staff, so every function that decides what JAX IQ reads refuses any other audience.
 */

/** The state of one tool for the person asking, as the planner and the scope factory read it. */
export type RuleToolStates = (connectorId: string, tool: string) => ConnectorState;

export interface CappedToolState {
  state: ConnectorState;
  /** The table's answer, unchanged: false for a tool the pack does not list. */
  known: boolean;
  via: EffectiveConnectorTool['via'];
  /** The `change` rules that capped this person's use of the tool. */
  capRuleIds: string[];
}

/**
 * Strictness from the most open to the most closed. A local copy of the table's order, which the business-pack keeps private; a test
 * pins the two together.
 */
export const TOOL_STATE_STRICTNESS: Readonly<Record<ConnectorState, number>> = { allow: 0, ask: 1, blocked: 2 };

const rank = (state: ConnectorState): number => TOOL_STATE_STRICTNESS[state] ?? TOOL_STATE_STRICTNESS.blocked;

/** The stricter of two states: blocked beats ask, ask beats allow. */
export function stricterToolState(a: ConnectorState, b: ConnectorState): ConnectorState {
  return rank(b) > rank(a) ? b : a;
}

/**
 * The state of one tool for this person: the stricter of the per-tool table and the caps of the `change` rules. It cannot be looser
 * than the table. It does not refuse non-staff audiences by itself; `toolStatesFor` does that for JAX IQ.
 */
export function effectiveToolState(
  connectors: ConnectorsExtension | undefined,
  caps: readonly ToolCap[],
  connectorId: string,
  tool: string,
  who: RulePerson,
): CappedToolState {
  const table = connectorToolState(connectors, connectorId, tool, tablePersonOf(who));
  const capRuleIds: string[] = [];
  let state = table.state;
  for (const cap of caps) {
    if (cap.connectorId !== connectorId || cap.tool !== tool || clausesAdmit(cap.allowedWho, who)) continue;
    if (!capRuleIds.includes(cap.ruleId)) capRuleIds.push(cap.ruleId);
    state = stricterToolState(state, cap.cap);
  }
  return { state, known: table.known, via: table.via, capRuleIds };
}

/** The state lookup JAX IQ hands to `allowedFacts` and `allowedSignals`: the effective state, and blocked for anyone who is not staff. */
export function toolStatesFor(connectors: ConnectorsExtension | undefined, caps: readonly ToolCap[], who: RulePerson): RuleToolStates {
  if (!isStaffPerson(who)) return () => 'blocked';
  return (connectorId, tool) => effectiveToolState(connectors, caps, connectorId, tool, who).state;
}

/** A read counts only when its tool is allowed: `ask` counts as blocked, because JAX IQ cannot wait for a person's yes. */
const isOpen = (toolStates: RuleToolStates, binding: Pick<Binding, 'system' | 'tool'>): boolean => toolStates(binding.system, binding.tool) === 'allow';

function groupBy<K, V>(items: readonly V[], key: (item: V) => K | undefined): Map<K, V[]> {
  const groups = new Map<K, V[]>();
  for (const item of items) {
    const name = key(item);
    if (name === undefined) continue;
    const members = groups.get(name) ?? [];
    members.push(item);
    groups.set(name, members);
  }
  return groups;
}

/**
 * The facts this person may see: the tool state of a fact's bound tool is not blocked AND some `see` rule allows the fact. A fact is
 * open when at least one of its bindings is on an allowed tool; a fact with no binding at all is decided by the rules alone, so a
 * question about it can still be answered "no source". No rule means denied. Anyone who is not staff gets nothing.
 */
export function allowedFacts(block: RulesBlock, who: RulePerson, toolStates: RuleToolStates, rules: CompiledRules = compileRules(block)): Set<FactPath> {
  const allowed = new Set<FactPath>();
  if (!isStaffPerson(who)) return allowed;
  const bindings = groupBy(block.bindings, (binding) => (binding.target.kind === 'fact' ? binding.target.fact : undefined));
  for (const { fact } of block.facts) {
    if (!(rules.seeByFact.get(fact) ?? []).some((rule) => clausesAdmit(rule.who, who))) continue;
    const bound = bindings.get(fact) ?? [];
    if (bound.length > 0 && !bound.some((binding) => isOpen(toolStates, binding))) continue;
    allowed.add(fact);
  }
  return allowed;
}

export interface SignalFactReads {
  /** Every fact the signal reads: its declared inputs and the item facts inside its list operands. */
  facts: FactPath[];
  /** Every link a list operand goes over. */
  links: LinkName[];
  /** Input names the signal does not declare and that are not facts either. A signal that has one cannot be shown. */
  unresolved: string[];
}

/** What a signal reads, so that it can be shown only to a person who may see all of it. */
export function signalFactReads(signal: Pick<SignalRule, 'inputs' | 'formula'>): SignalFactReads {
  const facts = new Set<FactPath>(signal.inputs.map((input) => input.fact));
  const links = new Set<LinkName>();
  const unresolved = new Set<string>();
  const declared = new Map(signal.inputs.map((input) => [input.name, input.fact]));

  const readOperand = (operand: Operand): void => {
    if ('input' in operand) {
      const named = declared.get(operand.input);
      if (named) facts.add(named);
      else if (operand.input.includes('.')) facts.add(operand.input);
      else unresolved.add(operand.input);
    } else if ('formula' in operand) {
      readFormula(operand.formula);
    } else if ('over' in operand) {
      links.add(operand.over);
      readFormula(operand.where);
    } else if (!('setting' in operand) && !('text' in operand)) {
      unresolved.add('(an operand this version does not know)');
    }
  };
  const readFormula = (formula: Formula): void => {
    switch (formula.op) {
      case 'ratio': readOperand(formula.num); readOperand(formula.den); break;
      case 'compare': readOperand(formula.left); readOperand(formula.right); break;
      case 'age': case 'count': case 'positive': case 'is_past': case 'any': readOperand(formula.of); break;
      case 'and': case 'or': formula.of.forEach(readFormula); break;
      default: unresolved.add('(an operator this version does not know)');
    }
  };
  readFormula(signal.formula);
  return { facts: [...facts], links: [...links], unresolved: [...unresolved] };
}

/**
 * The signals this person may see. A signal is allowed only when every fact it reads is allowed for this person, the item facts inside
 * its list operands included, and the links its lists go over can be read; otherwise it is absent, like a denied fact. Anyone who is
 * not staff gets nothing.
 */
export function allowedSignals(block: RulesBlock, who: RulePerson, toolStates: RuleToolStates, rules: CompiledRules = compileRules(block)): Set<string> {
  const allowed = new Set<string>();
  if (!isStaffPerson(who)) return allowed;
  const facts = allowedFacts(block, who, toolStates, rules);
  const defined = new Set(block.links.map((link) => link.link));
  const bindings = groupBy(block.bindings, (binding) => (binding.target.kind === 'link' ? binding.target.link : undefined));
  const linkIsOpen = (link: LinkName): boolean => {
    const bound = bindings.get(link) ?? [];
    return defined.has(link) && (bound.length === 0 || bound.some((binding) => isOpen(toolStates, binding)));
  };
  for (const signal of block.signalRules) {
    const reads = signalFactReads(signal);
    if (reads.unresolved.length === 0 && reads.facts.every((fact) => facts.has(fact)) && reads.links.every(linkIsOpen)) allowed.add(signal.signalId);
  }
  return allowed;
}
