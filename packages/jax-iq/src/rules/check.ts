import { connectorToolState, type ConnectorsExtension } from '@journeyax/business-pack';
import type { Binding, ConnectorId, FactPath, ThingName } from '../model';
import { clausesAdmit, compileRules, tablePersonOf, type RulePerson, type RulesBlock } from './compile';

/**
 * Check R15. The rules of a release hold only inside JAX IQ; the direct route to a tool follows the per-tool table alone. Wherever the
 * table lets a team use a tool that a rule keeps that team away from, the table is looser than the rule. This returns every such
 * (rule, tool, team) so that a person can close the table row or accept the gap.
 */

export interface RuleTableGap {
  ruleId: string;
  mode: 'see' | 'change';
  connectorId: ConnectorId;
  tool: string;
  /** The team the table lets through; `null` for a member of staff who is in no team. */
  team: string | null;
  /** What the table says for that team: looser than the rule's `blocked`. */
  tableState: 'allow' | 'ask';
  /** For a `see` rule, the facts it keeps from the team that this tool returns. Empty for a `change` rule. */
  exposes: FactPath[];
  /** The gap in plain words, for the publish message. */
  message: string;
}

interface Candidate {
  team: string | null;
  who: RulePerson;
}

const teamLabel = (team: string | null): string => team ?? 'staff who are in no team';
const stateWords = (state: 'allow' | 'ask'): string => (state === 'ask' ? 'ask first' : 'allowed');

function messageOf(gap: Omit<RuleTableGap, 'message'>): string {
  const team = teamLabel(gap.team);
  const tool = `${gap.connectorId}.${gap.tool}`;
  const close = 'Close the table row or accept it.';
  if (gap.mode === 'change') return `Rule ${gap.ruleId} does not let ${team} use ${tool}, but the tool table gives ${team} that tool (${stateWords(gap.tableState)}). ${close}`;
  return `Rule ${gap.ruleId} does not let ${team} see ${gap.exposes.join(', ')}, but the tool table gives ${team} ${tool} (${stateWords(gap.tableState)}) and that tool returns ${gap.exposes.length === 1 ? 'it' : 'them'}. ${close}`;
}

/** One person per team the table or a rule names, and one member of staff in no team. Teams come out in alphabetical order, no team first. */
function candidatesOf(block: RulesBlock, connectors: ConnectorsExtension | undefined): Candidate[] {
  const teams = new Set<string>();
  for (const row of connectors?.policy ?? []) for (const group of row.groups ?? []) teams.add(group);
  for (const rule of block.permissionRules) for (const clause of rule.who ?? []) for (const group of clause.groups ?? []) teams.add(group);
  return [null, ...[...teams].sort()].map((team) => ({ team, who: { audience: 'staff', groups: team === null ? [] : [team] } }));
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const members = map.get(key) ?? [];
  members.push(value);
  map.set(key, members);
}

/**
 * Every (rule, tool, team) where the per-tool table is looser than a rule. A team is a member of staff in that one team, evaluated as
 * the table does; a person in two teams can be given more by the table's own union of rows, which this list does not try to enumerate.
 * - A `see` rule keeps a team from a fact when no `see` rule lets that team see it. Every tool that returns the fact is a gap for that
 *   team when the table does not block it. A tool returns a fact when a binding of that fact is on it, or when a binding of a link
 *   leading to the fact's thing is on it.
 * - A `change` rule keeps a team from a write tool when its clauses do not admit the team. The table is looser when it does not block it.
 * `ask` is looser than `blocked`, so it is listed with its state. Facts that no rule names are not listed: there is no rule to compare.
 */
export function checkRulesAgainstTable(block: RulesBlock, connectors: ConnectorsExtension | undefined): RuleTableGap[] {
  const rules = compileRules(block);
  const candidates = candidatesOf(block, connectors);

  const thingOf = new Map<FactPath, ThingName>(block.facts.map((fact) => [fact.fact, fact.thing]));
  const linkLeadsTo = new Map(block.links.map((link) => [link.link, link.to]));
  const onFact = new Map<FactPath, Binding[]>();
  const onThing = new Map<ThingName, Binding[]>();
  for (const binding of block.bindings) {
    if (binding.target.kind === 'fact') pushTo(onFact, binding.target.fact, binding);
    else {
      const thing = linkLeadsTo.get(binding.target.link);
      if (thing) pushTo(onThing, thing, binding);
    }
  }

  const toolOrder = new Map<string, number>();
  for (const { system, tool } of [...block.bindings, ...rules.caps.map((cap) => ({ system: cap.connectorId, tool: cap.tool }))]) {
    const key = `${system}\u0000${tool}`;
    if (!toolOrder.has(key)) toolOrder.set(key, toolOrder.size);
  }
  const ruleOrder = new Map<string, number>();
  for (const rule of block.permissionRules) if (!ruleOrder.has(rule.ruleId)) ruleOrder.set(rule.ruleId, ruleOrder.size);
  const teamOrder = new Map<string | null, number>(candidates.map((candidate, index) => [candidate.team, index]));

  const found = new Map<string, Omit<RuleTableGap, 'message'>>();
  const record = (ruleId: string, mode: 'see' | 'change', connectorId: string, tool: string, candidate: Candidate, fact?: FactPath): void => {
    const state = connectorToolState(connectors, connectorId, tool, tablePersonOf(candidate.who)).state;
    if (state === 'blocked') return;
    const key = JSON.stringify([ruleId, connectorId, tool, candidate.team]);
    const gap = found.get(key) ?? { ruleId, mode, connectorId, tool, team: candidate.team, tableState: state, exposes: [] };
    if (fact && !gap.exposes.includes(fact)) gap.exposes.push(fact);
    found.set(key, gap);
  };

  for (const rule of rules.see) {
    for (const candidate of candidates) {
      if (clausesAdmit(rule.who, candidate.who)) continue;
      for (const fact of rule.facts) {
        if ((rules.seeByFact.get(fact) ?? []).some((other) => clausesAdmit(other.who, candidate.who))) continue;
        const exposing = [...(onFact.get(fact) ?? []), ...(onThing.get(thingOf.get(fact) ?? '') ?? [])];
        for (const binding of exposing) record(rule.ruleId, 'see', binding.system, binding.tool, candidate, fact);
      }
    }
  }
  for (const cap of rules.caps) {
    for (const candidate of candidates) {
      if (!clausesAdmit(cap.allowedWho, candidate.who)) record(cap.ruleId, 'change', cap.connectorId, cap.tool, candidate);
    }
  }

  return [...found.values()]
    .sort((a, b) =>
      (ruleOrder.get(a.ruleId) ?? 0) - (ruleOrder.get(b.ruleId) ?? 0)
      || (toolOrder.get(`${a.connectorId}\u0000${a.tool}`) ?? 0) - (toolOrder.get(`${b.connectorId}\u0000${b.tool}`) ?? 0)
      || (teamOrder.get(a.team) ?? 0) - (teamOrder.get(b.team) ?? 0))
    .map((gap) => ({ ...gap, message: messageOf(gap) }));
}
