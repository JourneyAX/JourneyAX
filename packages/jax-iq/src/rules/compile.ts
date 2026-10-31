import type { ConnectorId, FactPath, JaxOntologyRelease, ThingName, WhoClause } from '../model';

/**
 * Turns the permission rules of a release into what the engine asks: which rules name each fact, and which write tools are capped for
 * whom. A rule has no field that names a tool state, so a compiled rule can only take access away: a `see` rule is an allow-list for
 * facts (no rule, no access) and a `change` rule becomes a cap of `blocked` on the write tools it names, for everyone its clauses do
 * not admit. Nothing here reads the per-tool table; `effective.ts` combines the two.
 */

/** The parts of a release the rules read. */
export type RulesBlock = Pick<JaxOntologyRelease, 'facts' | 'links' | 'bindings' | 'permissionRules' | 'signalRules'>;

/** Who is asking. Rules cover members of staff only: any other audience is refused, whatever groups it claims. */
export interface RulePerson {
  audience: string;
  groups: readonly string[];
}

/** A `see` rule with its target written out as facts of the block. */
export interface CompiledSeeRule {
  ruleId: string;
  who: readonly WhoClause[];
  facts: readonly FactPath[];
}

/** What a `change` rule does to one write tool: everyone its clauses do not admit is capped. */
export interface ToolCap {
  ruleId: string;
  connectorId: ConnectorId;
  tool: string;
  cap: 'blocked';
  allowedWho: readonly WhoClause[];
}

export interface CompiledRules {
  /** The `see` rules, in the block's order. */
  see: readonly CompiledSeeRule[];
  /** Every fact the block defines, with the `see` rules that name it. An empty list means no rule names it: new facts start closed. */
  seeByFact: ReadonlyMap<FactPath, readonly CompiledSeeRule[]>;
  caps: readonly ToolCap[];
}

/** Is this a member of staff? Anyone else, and a missing person, is not. */
export const isStaffPerson = (who: RulePerson | undefined): boolean => who?.audience === 'staff';

/** Does one of these clauses admit this person? An empty group list admits every member of staff; a person no clause matches is denied. */
export function clausesAdmit(clauses: readonly WhoClause[], who: RulePerson): boolean {
  if (!isStaffPerson(who)) return false;
  const groups = Array.isArray(who.groups) ? who.groups : [];
  return clauses.some((clause) => clause.audience === 'staff' && Array.isArray(clause.groups) && (clause.groups.length === 0 || clause.groups.some((group) => groups.includes(group))));
}

/** The person as the per-tool table reads it: anyone who is not staff is a shopper and carries no groups. */
export function tablePersonOf(who: RulePerson): { audience: 'staff' | 'shopper'; groups: string[] } {
  return isStaffPerson(who) ? { audience: 'staff', groups: Array.isArray(who.groups) ? [...who.groups] : [] } : { audience: 'shopper', groups: [] };
}

/**
 * Compiles the rules of a block. A `see` rule that names facts covers those of them the target thing defines; one that names none covers
 * every fact of the thing. A mode other than `see` and `change` covers nothing and caps nothing.
 */
export function compileRules(block: Pick<RulesBlock, 'facts' | 'permissionRules'>): CompiledRules {
  const factsOfThing = new Map<ThingName, Set<FactPath>>();
  for (const fact of block.facts) {
    const facts = factsOfThing.get(fact.thing) ?? new Set<FactPath>();
    facts.add(fact.fact);
    factsOfThing.set(fact.thing, facts);
  }

  const see: CompiledSeeRule[] = [];
  const caps: ToolCap[] = [];
  const capped = new Set<string>();
  for (const rule of block.permissionRules) {
    if (rule.mode === 'see') {
      const ofThing = factsOfThing.get(rule.target.thing) ?? new Set<FactPath>();
      const named = rule.target.facts ? rule.target.facts.filter((fact) => ofThing.has(fact)) : [...ofThing];
      see.push({ ruleId: rule.ruleId, who: rule.who ?? [], facts: [...new Set(named)] });
    } else if (rule.mode === 'change') {
      for (const { connectorId, tool } of rule.writeTools ?? []) {
        const key = JSON.stringify([rule.ruleId, connectorId, tool]);
        if (capped.has(key)) continue;
        capped.add(key);
        caps.push({ ruleId: rule.ruleId, connectorId, tool, cap: 'blocked', allowedWho: rule.who ?? [] });
      }
    }
  }

  const seeByFact = new Map<FactPath, CompiledSeeRule[]>();
  for (const fact of block.facts) seeByFact.set(fact.fact, []);
  for (const rule of see) for (const fact of rule.facts) seeByFact.get(fact)?.push(rule);
  return { see, seeByFact, caps };
}
