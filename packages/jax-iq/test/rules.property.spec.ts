import './setup/no-world';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSuite } from '@journeyax/test-support';
import { ConnectorsSchema, connectorToolState, type ConnectorState, type ConnectorsExtension } from '@journeyax/business-pack';
import { PermissionRuleSchema, SignalRuleSchema } from '../src/model';
import type { Binding, FactDef, Formula, LinkDef, PermissionRule, SignalRule, WhoClause } from '../src/model';
import { allowedFacts, allowedSignals, checkRulesAgainstTable, compileRules, effectiveToolState, stricterToolState, toolStatesFor } from '../src/rules';
import type { RulePerson, RulesBlock } from '../src/rules';

/**
 * The property test: random tables, random rules and a list of people, and the rules never open anything the per-tool table closed.
 * The style is the editor's own random-edit test (apps/journeyax-web connectorRules.test.ts): a small seeded generator written here, so
 * a run is the same every time and a failure names its seed. Everything generated is made up for the test.
 *
 * Each property is also checked against an oracle written below straight from the rules in the schema, with none of the module's code in
 * it except the table's own `connectorToolState`.
 */
const suite = createSuite('jax-iq: permission rules, the property test (never looser than the table)');

const RUNS = 300;
const GROUPS = ['alpha', 'beta', 'gamma', 'delta', 'administrators'];
const THINGS = ['Alpha', 'Beta', 'Gamma'];
const SYSTEMS = ['sys-one', 'sys-two', 'sys-three'];
const TOOL_NAMES = ['read_a', 'read_b', 'read_c', 'write_a', 'write_b'];
/** Mostly allow, so that tools are open often enough for the rules to matter. */
const STATE_POOL: ConnectorState[] = ['allow', 'allow', 'allow', 'ask', 'blocked'];
const STATES: ConnectorState[] = ['allow', 'ask', 'blocked'];

/** A seeded generator (mulberry32). The same seed gives the same run; nothing here reads the clock or the system's random numbers. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number): number => Math.floor(next() * below);
  return {
    int,
    chance: (p: number): boolean => next() < p,
    pick: <T>(items: readonly T[]): T => items[int(items.length)],
    some: <T>(items: readonly T[], p: number): T[] => items.filter(() => next() < p),
    between: (min: number, max: number): number => min + int(max - min + 1),
  };
}

interface World {
  seed: number;
  block: RulesBlock;
  connectors: ConnectorsExtension;
  people: RulePerson[];
  /** What each signal reads, written down while it was built. */
  reads: Map<string, { facts: string[]; links: string[] }>;
}

const contract = { unit: 'not_applicable', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: 'not_applicable' } as const;
const factDef = (fact: string): FactDef => ({ fact, thing: fact.split('.')[0], label: fact, meaning: 'A test fact.', type: 'text', freshnessKind: 'reference', allowStale: true });
const bindingOf = (bindingId: string, target: Binding['target'], system: string, tool: string, authority: Binding['authority']): Binding => ({
  bindingId, target, system, tool, args: {}, select: 'record.value', presence: 'optional', authority, freshnessKind: 'reference', contract,
});

function world(seed: number): World {
  const g = generator(seed);
  const systems = SYSTEMS.map((connectorId) => {
    const named = TOOL_NAMES.filter(() => g.chance(0.6));
    return { connectorId, tools: named.length >= 2 ? named : TOOL_NAMES.slice(0, 2), enabled: g.chance(0.9) };
  });
  const policy = systems.flatMap((system) => Array.from({ length: g.between(0, 7) }, () => {
    const shopper = g.chance(0.15);
    return { connectorId: system.connectorId, tool: g.chance(0.2) ? '*' : g.pick(system.tools), audience: shopper ? 'shopper' : 'staff', groups: shopper ? [] : g.some(GROUPS, 0.35), state: g.pick(STATE_POOL) };
  }));
  const connectors = ConnectorsSchema.parse({
    askVia: 'card',
    announceSample: false,
    connectors: systems.map((system) => ({
      connectorId: system.connectorId, displayName: system.connectorId, description: 'A test connector.', owner: 'Test owner', sample: true, enabled: system.enabled,
      tools: system.tools.map((name) => ({ name, sideEffect: name.startsWith('write') ? 'write' : 'read' })),
    })),
    policy,
  });
  const pairs = systems.flatMap((system) => system.tools.map((tool): [string, string] => [system.connectorId, tool]));
  const readPairs = pairs.filter(([, tool]) => tool.startsWith('read'));

  const facts: FactDef[] = THINGS.flatMap((thing) => Array.from({ length: g.between(2, 4) }, (_, index) => factDef(`${thing}.f${index}`)));
  const links: LinkDef[] = [
    { link: 'Alpha.items', from: 'Alpha', to: 'Beta', meaning: 'A test link.', cardinality: '1:n' },
    { link: 'Beta.items', from: 'Beta', to: 'Gamma', meaning: 'A test link.', cardinality: '1:n' },
  ];
  const bindings: Binding[] = [];
  const authorityOf = () => g.pick<Binding['authority']>(['source_of_truth', 'source_of_truth', 'cross_check', 'fallback']);
  const onePair = (): [string, string] => (g.chance(0.05) ? [g.pick(SYSTEMS), 'ghost_tool'] : g.pick(readPairs));
  for (const fact of facts) {
    for (let count = g.pick([0, 1, 1, 1, 2]); count > 0; count--) {
      const [system, tool] = onePair();
      bindings.push(bindingOf(`${fact.fact}#${bindings.length}`, { kind: 'fact', fact: fact.fact }, system, tool, authorityOf()));
    }
  }
  for (const link of links) {
    if (g.chance(0.7)) {
      const [system, tool] = onePair();
      bindings.push(bindingOf(`${link.link}#${bindings.length}`, { kind: 'link', link: link.link }, system, tool, 'source_of_truth'));
    }
  }

  const whoOf = (): WhoClause[] => Array.from({ length: g.between(0, 3) }, () => ({ audience: 'staff' as const, groups: g.chance(0.3) ? [] : g.some(GROUPS, 0.4).concat(g.pick(GROUPS)).filter((group, index, all) => all.indexOf(group) === index) }));
  const permissionRules: PermissionRule[] = Array.from({ length: g.between(0, 6) }, (_, index) => {
    const thing = g.pick(THINGS);
    if (g.chance(0.7)) {
      const ofThing = facts.filter((fact) => fact.thing === thing).map((fact) => fact.fact);
      let named: string[] | undefined;
      if (g.chance(0.5)) {
        named = g.some(ofThing, 0.5);
        if (named.length === 0) named.push(g.pick(ofThing));
        if (g.chance(0.15)) named.push(`${g.pick(THINGS)}.f0`, 'Alpha.missing');
        named = [...new Set(named)];
      }
      return PermissionRuleSchema.parse({ ruleId: `r${index}-see`, mode: 'see', target: { thing, ...(named ? { facts: named } : {}) }, who: whoOf() });
    }
    const writeTools = Array.from({ length: g.between(1, 3) }, () => {
      const [connectorId, tool] = g.chance(0.1) ? [g.pick(SYSTEMS), 'ghost_tool'] : g.pick(pairs);
      return { connectorId, tool };
    });
    return PermissionRuleSchema.parse({ ruleId: `r${index}-change`, mode: 'change', target: { thing }, who: whoOf(), writeTools });
  });

  const signalRules: SignalRule[] = [];
  const reads = new Map<string, { facts: string[]; links: string[] }>();
  for (let index = 0, total = g.between(0, 4); index < total; index++) {
    const inputs = Array.from({ length: g.between(0, 3) }, (_, position) => ({ name: `i${position}`, fact: g.pick(facts).fact }));
    const kind = g.pick(['plain', 'list', 'both']);
    const over = g.pick(links);
    const itemFacts = facts.filter((fact) => fact.thing === over.to).map((fact) => fact.fact);
    const first = g.pick(itemFacts);
    const second = g.pick(itemFacts);
    const list = { over: over.link, where: kind === 'both'
      ? { op: 'and', of: [{ op: 'positive', of: { input: first } }, { op: 'is_past', of: { input: second } }] } as Formula
      : { op: 'positive', of: { input: first } } as Formula };
    const plain: Formula = inputs.length > 0
      ? { op: 'positive', of: { input: 'i0' } }
      : { op: 'compare', cmp: 'gte', left: { setting: 'level.one' }, right: { setting: 'level.two' } };
    const formula: Formula = kind === 'plain' ? plain
      : kind === 'list' ? { op: 'any', of: list }
      : { op: 'and', of: [plain, { op: 'compare', cmp: 'gt', left: { formula: { op: 'count', of: list } }, right: { setting: 'level.one' } }] };
    const signalId = `s${index}`;
    signalRules.push(SignalRuleSchema.parse({
      signalId, name: signalId, meaning: 'A test signal.', appliesTo: 'Alpha', severity: 'watch', inputs, formula, settings: [], status: 'draft', wording: ['A test sentence.'],
    }));
    reads.set(signalId, {
      facts: [...new Set([...inputs.map((input) => input.fact), ...(kind === 'plain' ? [] : kind === 'list' ? [first] : [first, second])])],
      links: kind === 'plain' ? [] : [over.link],
    });
  }

  const staff = (...groups: string[]): RulePerson => ({ audience: 'staff', groups });
  const people: RulePerson[] = [
    staff(),
    ...GROUPS.map((group) => staff(group)),
    ...Array.from({ length: 4 }, () => staff(...g.some(GROUPS, 0.5))),
    { audience: 'shopper', groups: [] },
    { audience: 'shopper', groups: [GROUPS[0], GROUPS[1]] },
    { audience: 'robot', groups: [GROUPS[2]] },
  ];
  return { seed, block: { facts, links, bindings, permissionRules, signalRules }, connectors, people, reads };
}

// The oracle, written from the schema's own words, not from the module.

const admitted = (who: RulePerson, clauses: WhoClause[]): boolean => who.audience === 'staff' && clauses.some((one) => one.groups.length === 0 || one.groups.some((group) => who.groups.includes(group)));

function tableState(w: World, who: RulePerson, system: string, tool: string): ConnectorState {
  return connectorToolState(w.connectors, system, tool, who.audience === 'staff' ? { audience: 'staff', groups: [...who.groups] } : { audience: 'shopper', groups: [] }).state;
}

/** The table's state, or blocked where a change rule names the tool and does not admit the person. */
function stateFor(w: World, who: RulePerson, system: string, tool: string): ConnectorState {
  const capped = w.block.permissionRules.some((rule) => rule.mode === 'change' && (rule.writeTools ?? []).some((named) => named.connectorId === system && named.tool === tool) && !admitted(who, rule.who));
  return capped ? 'blocked' : tableState(w, who, system, tool);
}

const ruleAllows = (w: World, who: RulePerson, fact: FactDef): boolean =>
  w.block.permissionRules.some((rule) => rule.mode === 'see' && rule.target.thing === fact.thing && (!rule.target.facts || rule.target.facts.includes(fact.fact)) && admitted(who, rule.who));

const toolOpensFact = (w: World, who: RulePerson, fact: string): boolean => {
  const bound = w.block.bindings.filter((binding) => binding.target.kind === 'fact' && binding.target.fact === fact);
  return bound.length === 0 || bound.some((binding) => stateFor(w, who, binding.system, binding.tool) === 'allow');
};

function oracleFacts(w: World, who: RulePerson): string[] {
  return w.block.facts.filter((fact) => who.audience === 'staff' && ruleAllows(w, who, fact) && toolOpensFact(w, who, fact.fact)).map((fact) => fact.fact).sort();
}

function oracleSignals(w: World, who: RulePerson): string[] {
  const facts = new Set(oracleFacts(w, who));
  return w.block.signalRules.filter((signal) => {
    const read = w.reads.get(signal.signalId)!;
    const linksOpen = read.links.every((link) => {
      const bound = w.block.bindings.filter((binding) => binding.target.kind === 'link' && binding.target.link === link);
      return bound.length === 0 || bound.some((binding) => stateFor(w, who, binding.system, binding.tool) === 'allow');
    });
    return who.audience === 'staff' && linksOpen && read.facts.every((fact) => facts.has(fact));
  }).map((signal) => signal.signalId).sort();
}

const gapKey = (ruleId: string, system: string, tool: string, team: string | null): string => JSON.stringify([ruleId, system, tool, team]);

function oracleGaps(w: World): string[] {
  const teams = new Set<string>();
  for (const row of w.connectors.policy) for (const group of row.groups) teams.add(group);
  for (const rule of w.block.permissionRules) for (const one of rule.who) for (const group of one.groups) teams.add(group);
  const persons = [null, ...teams].map((team) => ({ team, who: { audience: 'staff', groups: team === null ? [] : [team] } as RulePerson }));
  const covers = (rule: PermissionRule, fact: FactDef): boolean => rule.mode === 'see' && rule.target.thing === fact.thing && (!rule.target.facts || rule.target.facts.includes(fact.fact));
  const leadsTo = (link: string): string | undefined => (link === 'Alpha.items' ? 'Beta' : link === 'Beta.items' ? 'Gamma' : undefined);
  const returns = (binding: Binding, fact: FactDef): boolean =>
    binding.target.kind === 'fact' ? binding.target.fact === fact.fact : leadsTo(binding.target.link) === fact.thing;
  const found = new Set<string>();
  for (const rule of w.block.permissionRules) {
    for (const { team, who } of persons) {
      if (rule.mode === 'see') {
        if (admitted(who, rule.who)) continue;
        for (const fact of w.block.facts.filter((candidate) => covers(rule, candidate))) {
          if (w.block.permissionRules.some((other) => covers(other, fact) && admitted(who, other.who))) continue;
          for (const binding of w.block.bindings.filter((candidate) => returns(candidate, fact))) {
            if (tableState(w, who, binding.system, binding.tool) !== 'blocked') found.add(gapKey(rule.ruleId, binding.system, binding.tool, team));
          }
        }
      } else if (!admitted(who, rule.who)) {
        for (const named of rule.writeTools ?? []) if (tableState(w, who, named.connectorId, named.tool) !== 'blocked') found.add(gapKey(rule.ruleId, named.connectorId, named.tool, team));
      }
    }
  }
  return [...found].sort();
}

async function main() {
  const worlds = Array.from({ length: RUNS }, (_, index) => world(index + 1));
  const listedTools = (w: World): Array<[string, string]> => [
    ...w.connectors.connectors.flatMap((entry): Array<[string, string]> => entry.tools.map((tool) => [entry.connectorId, tool.name])),
    ['sys-one', 'ghost_tool'], ['no-such-system', 'read_a'],
  ];
  const seen = { staffPeople: 0, factsAllowed: 0, ruleDeniedToolOpen: 0, toolDeniedRuleAdmits: 0, signalsAllowed: 0, signalsDenied: 0, capped: 0, gaps: 0, changeGaps: 0, linkGaps: 0 };

  await suite.test(`the generator is the same every time, and is not the system's: ${RUNS} worlds from seeds 1 to ${RUNS}`, () => {
    assert.deepEqual(JSON.parse(JSON.stringify(world(7))), JSON.parse(JSON.stringify(worlds[6])));
    assert.notDeepEqual(JSON.stringify(worlds[0]), JSON.stringify(worlds[1]));
    const source = readFileSync(__filename, 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    // Written in pieces so that this list does not match itself.
    const banned = [['Math', '.random'], ['Date', '.now'], ['new', ' Date'], ['performance', '.now'], ['cry', 'pto']].map((pieces) => pieces.join(''));
    for (const word of banned) assert.ok(!code.some((line) => line.includes(word)), `no ${word}`);
  });

  await suite.test('effective strictness is never below the table\'s, for every tool, every world and every person; only a change rule moves it, and only to blocked', () => {
    for (const w of worlds) {
      const rules = compileRules(w.block);
      for (const who of w.people) {
        for (const [system, tool] of listedTools(w)) {
          const context = `seed ${w.seed}, ${system}.${tool}, ${JSON.stringify(who)}`;
          const table = connectorToolState(w.connectors, system, tool, who.audience === 'staff' ? { audience: 'staff', groups: [...who.groups] } : { audience: 'shopper', groups: [] });
          const effective = effectiveToolState(w.connectors, rules.caps, system, tool, who);
          assert.equal(stricterToolState(table.state, effective.state), effective.state, `never looser: ${context}`);
          assert.equal(effective.known, table.known, context);
          assert.equal(effective.via, table.via, context);
          if (table.state === 'blocked') assert.equal(effective.state, 'blocked', `a rule cannot open a closed tool: ${context}`);
          if (effective.capRuleIds.length > 0) assert.equal(effective.state, 'blocked', context);
          if (effective.state !== table.state) {
            assert.equal(effective.state, 'blocked', context);
            assert.ok(effective.capRuleIds.length > 0, `only a cap moves it: ${context}`);
            seen.capped++;
          } else if (!w.block.permissionRules.some((rule) => rule.mode === 'change' && (rule.writeTools ?? []).some((named) => named.connectorId === system && named.tool === tool))) {
            assert.deepEqual(effective.capRuleIds, [], `a tool no change rule names is the table's: ${context}`);
          }
          assert.equal(effective.state, stateFor(w, who, system, tool), `agrees with the oracle: ${context}`);
          assert.equal(toolStatesFor(w.connectors, rules.caps, who)(system, tool), who.audience === 'staff' ? effective.state : 'blocked', context);
        }
      }
    }
  });

  await suite.test('adding rules only ever makes a tool stricter: with the first k change rules, then k + 1, no person gets a looser state', () => {
    for (const w of worlds) {
      const all = w.block.permissionRules;
      let before = compileRules({ facts: w.block.facts, permissionRules: [] }).caps;
      for (let count = 1; count <= all.length; count++) {
        const after = compileRules({ facts: w.block.facts, permissionRules: all.slice(0, count) }).caps;
        for (const who of w.people) {
          for (const [system, tool] of listedTools(w)) {
            const was = effectiveToolState(w.connectors, before, system, tool, who).state;
            const now = effectiveToolState(w.connectors, after, system, tool, who).state;
            assert.equal(stricterToolState(was, now), now, `seed ${w.seed}, rule ${count}, ${system}.${tool}`);
          }
        }
        before = after;
      }
    }
  });

  await suite.test('the allowed facts are exactly what the oracle says, and a subset of what the rules allow and of what the open tools return', () => {
    for (const w of worlds) {
      const rules = compileRules(w.block);
      for (const who of w.people) {
        const context = `seed ${w.seed}, ${JSON.stringify(who)}`;
        const actual = [...allowedFacts(w.block, who, toolStatesFor(w.connectors, rules.caps, who), rules)].sort();
        assert.deepEqual(actual, oracleFacts(w, who), context);
        for (const fact of actual) {
          const def = w.block.facts.find((candidate) => candidate.fact === fact)!;
          assert.ok(ruleAllows(w, who, def), `some see rule allows ${fact}: ${context}`);
          assert.ok(toolOpensFact(w, who, fact), `the tool state of ${fact} is open: ${context}`);
        }
        if (who.audience === 'staff') {
          seen.staffPeople++;
          seen.factsAllowed += actual.length;
          for (const def of w.block.facts) {
            if (actual.includes(def.fact)) continue;
            if (!ruleAllows(w, who, def)) {
              if (toolOpensFact(w, who, def.fact)) seen.ruleDeniedToolOpen++;
            } else seen.toolDeniedRuleAdmits++;
          }
        }
      }
    }
  });

  await suite.test('a person who is not staff gets no fact, no signal and no open tool, in every world, whatever groups they claim', () => {
    for (const w of worlds) {
      const rules = compileRules(w.block);
      for (const who of w.people.filter((person) => person.audience !== 'staff')) {
        const states = toolStatesFor(w.connectors, rules.caps, who);
        assert.deepEqual([...allowedFacts(w.block, who, states, rules)], [], `seed ${w.seed}, ${JSON.stringify(who)}`);
        assert.deepEqual([...allowedSignals(w.block, who, states, rules)], [], `seed ${w.seed}, ${JSON.stringify(who)}`);
        assert.deepEqual([...allowedFacts(w.block, who, () => 'allow', rules)], [], 'not even when every tool is open');
        for (const [system, tool] of listedTools(w)) assert.equal(states(system, tool), 'blocked');
      }
    }
  });

  await suite.test('a stricter table never gives more: raising any row of the table can only shrink the allowed facts and signals', () => {
    for (const w of worlds) {
      const g = generator(w.seed + 5000);
      const tighter = ConnectorsSchema.parse({
        ...w.connectors,
        policy: w.connectors.policy.map((row) => (g.chance(0.4) ? { ...row, state: stricterToolState(row.state, g.pick(STATES)) } : row)),
      });
      const rules = compileRules(w.block);
      for (const who of w.people) {
        const before = allowedFacts(w.block, who, toolStatesFor(w.connectors, rules.caps, who), rules);
        const after = allowedFacts(w.block, who, toolStatesFor(tighter, rules.caps, who), rules);
        for (const fact of after) assert.ok(before.has(fact), `seed ${w.seed}: ${fact} appeared after the table got stricter`);
        const signalsBefore = allowedSignals(w.block, who, toolStatesFor(w.connectors, rules.caps, who), rules);
        for (const signal of allowedSignals(w.block, who, toolStatesFor(tighter, rules.caps, who), rules)) assert.ok(signalsBefore.has(signal), `seed ${w.seed}: ${signal} appeared`);
      }
    }
  });

  await suite.test('fewer rules never give more: dropping a see rule, or one of its clauses, can only shrink the allowed facts and signals', () => {
    for (const w of worlds) {
      const g = generator(w.seed + 9000);
      const see = w.block.permissionRules.filter((rule) => rule.mode === 'see');
      if (see.length === 0) continue;
      const victim = g.pick(see);
      const without: RulesBlock = { ...w.block, permissionRules: w.block.permissionRules.filter((rule) => rule !== victim) };
      const narrower: RulesBlock = {
        ...w.block,
        permissionRules: w.block.permissionRules.map((rule) => (rule === victim && rule.who.length > 0 ? { ...rule, who: rule.who.filter((_, index) => index !== g.int(rule.who.length)) } : rule)),
      };
      for (const smaller of [without, narrower]) {
        const fewer = compileRules(smaller);
        const rules = compileRules(w.block);
        for (const who of w.people) {
          const states = toolStatesFor(w.connectors, rules.caps, who);
          const before = allowedFacts(w.block, who, states, rules);
          for (const fact of allowedFacts(smaller, who, states, fewer)) assert.ok(before.has(fact), `seed ${w.seed}: ${fact} appeared with fewer rules`);
          const signalsBefore = allowedSignals(w.block, who, states, rules);
          for (const signal of allowedSignals(smaller, who, states, fewer)) assert.ok(signalsBefore.has(signal), `seed ${w.seed}: ${signal} appeared with fewer rules`);
        }
      }
    }
  });

  await suite.test('the allowed signals are exactly those whose every fact and list is allowed, and what an allowed signal reads is never a denied fact', () => {
    for (const w of worlds) {
      const rules = compileRules(w.block);
      for (const who of w.people) {
        const states = toolStatesFor(w.connectors, rules.caps, who);
        const facts = allowedFacts(w.block, who, states, rules);
        const actual = [...allowedSignals(w.block, who, states, rules)].sort();
        assert.deepEqual(actual, oracleSignals(w, who), `seed ${w.seed}, ${JSON.stringify(who)}`);
        for (const signal of actual) for (const fact of w.reads.get(signal)!.facts) assert.ok(facts.has(fact), `seed ${w.seed}: ${signal} reads the denied ${fact}`);
        if (who.audience === 'staff') {
          seen.signalsAllowed += actual.length;
          seen.signalsDenied += w.block.signalRules.length - actual.length;
        }
      }
    }
  });

  await suite.test('check R15 finds exactly the (rule, tool, team) triples the oracle finds, in a stable order, and closing them leaves none', () => {
    for (const w of worlds) {
      const gaps = checkRulesAgainstTable(w.block, w.connectors);
      const context = `seed ${w.seed}`;
      assert.deepEqual(gaps.map((gap) => gapKey(gap.ruleId, gap.connectorId, gap.tool, gap.team)).sort(), oracleGaps(w), context);
      assert.equal(new Set(gaps.map((gap) => gapKey(gap.ruleId, gap.connectorId, gap.tool, gap.team))).size, gaps.length, `no triple twice: ${context}`);
      assert.deepEqual(checkRulesAgainstTable(w.block, w.connectors), gaps, `the same list the second time: ${context}`);
      for (const gap of gaps) {
        assert.notEqual(gap.tableState, 'blocked');
        assert.equal(connectorToolState(w.connectors, gap.connectorId, gap.tool, { audience: 'staff', groups: gap.team === null ? [] : [gap.team] }).state, gap.tableState, context);
        assert.ok(gap.mode === 'change' ? gap.exposes.length === 0 : gap.exposes.length > 0, context);
        assert.ok(/^Rule \S+ does not let .+\. Close the table row or accept it\.$/.test(gap.message) && !gap.message.includes('\n'), `${context}: ${gap.message}`);
      }
      const closed = ConnectorsSchema.parse({
        ...w.connectors,
        policy: [...w.connectors.policy, ...gaps.map((gap) => ({ connectorId: gap.connectorId, tool: gap.tool, audience: 'staff', groups: gap.team === null ? [] : [gap.team], state: 'blocked' }))],
      });
      assert.deepEqual(checkRulesAgainstTable(w.block, closed), [], `closing every listed row leaves no gap: ${context}`);
      assert.deepEqual(checkRulesAgainstTable(w.block, undefined), [], 'a pack without the table is closed everywhere');
      seen.gaps += gaps.length;
      seen.changeGaps += gaps.filter((gap) => gap.mode === 'change').length;
      seen.linkGaps += gaps.filter((gap) => gap.mode === 'see' && w.block.bindings.some((binding) => binding.target.kind === 'link' && binding.system === gap.connectorId && binding.tool === gap.tool)).length;
    }
  });

  await suite.test('the generator reaches the cases that matter: the properties above are not true for want of anything to test', () => {
    assert.ok(seen.staffPeople > 2000, `staff people: ${seen.staffPeople}`);
    assert.ok(seen.factsAllowed > 2000, `facts allowed: ${seen.factsAllowed}`);
    assert.ok(seen.ruleDeniedToolOpen > 1000, `facts a rule took away from an open tool: ${seen.ruleDeniedToolOpen}`);
    assert.ok(seen.toolDeniedRuleAdmits > 500, `facts a closed tool took away from a rule that admits: ${seen.toolDeniedRuleAdmits}`);
    assert.ok(seen.signalsAllowed > 200, `signals allowed: ${seen.signalsAllowed}`);
    assert.ok(seen.signalsDenied > 200, `signals denied: ${seen.signalsDenied}`);
    assert.ok(seen.capped > 200, `tool states a change rule made stricter: ${seen.capped}`);
    assert.ok(seen.gaps > 500, `gaps found: ${seen.gaps}`);
    assert.ok(seen.changeGaps > 50, `change-rule gaps: ${seen.changeGaps}`);
    assert.ok(seen.linkGaps > 20, `gaps through a link: ${seen.linkGaps}`);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
