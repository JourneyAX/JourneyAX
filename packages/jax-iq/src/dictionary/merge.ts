import { JAX_ONTOLOGY_SCHEMA_VERSION } from '../model';
import type {
  Binding, ContractChange, DictionaryPart, FactDef, Formula, JaxOntologyRelease, LinkDef, Operand, PermissionRule, SettingDef, SignalRule, StateMap, ThingDef,
} from '../model';
import { dictionaryIssue, issuePath, type DictionaryIssue } from './issues';

/**
 * Merges the dictionary part files into one release block. Pure: no clock, no I/O, and the parts passed in are never changed.
 *
 * The block is a union of the parts. A part carries no header (id, switch, own connector, claim guard), so the caller gives it.
 * An id defined twice is an error. A part may replace a thing another part defines: the replaced thing goes with its own facts, the links
 * from it and their bindings, and (when they sit in the part that defines it) its rules and contract changes; its aliases pass to the
 * replacement; and every link, rule, signal and contract change elsewhere that pointed at it is redirected to the replacement. A
 * reference that cannot be redirected is an error. A state map names no thing, so state maps are only united.
 *
 * Every list of the output is sorted, so the JSON is the same whatever order the parts came in.
 */

export interface DictionaryHeader {
  ontologyId: string;
  enabled: boolean;
  selfConnector: string;
  claimGuard?: JaxOntologyRelease['claimGuard'];
  notes?: string;
}

export interface DictionaryMergeResult {
  /** Present only when the merge found no error. */
  block?: JaxOntologyRelease;
  issues: DictionaryIssue[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedBy = <T>(items: readonly T[], key: (item: T) => string): T[] => [...items].sort((a, b) => compare(key(a), key(b)));
const united = (...lists: ReadonlyArray<readonly string[]>): string[] => [...new Set(lists.flat())].sort(compare);

/** The thing a fact or link path starts with: 'Delivery.status' is 'Delivery'. */
const headOf = (path: string): string => (path.includes('.') ? path.slice(0, path.indexOf('.')) : path);

type Redirected = { path: string; subject: string; name: string; kind: 'fact' | 'link' | 'fact or link' };

export function mergeDictionaryParts(parts: readonly DictionaryPart[], header: DictionaryHeader): DictionaryMergeResult {
  const issues: DictionaryIssue[] = [];
  const work: DictionaryPart[] = parts.map((part) => structuredClone(part));

  const seenParts = new Set<string>();
  work.forEach((part, index) => {
    if (seenParts.has(part.partId)) issues.push(dictionaryIssue('merge_duplicate_part', issuePath('parts', index, 'partId'), `Two parts are called '${part.partId}'.`));
    seenParts.add(part.partId);
  });

  const duplicates = <T>(label: string, field: keyof Omit<DictionaryPart, 'partId' | 'replaces' | 'severities'>, id: (item: T) => string) => {
    const owner = new Map<string, string>();
    for (const part of work) {
      ((part[field] as unknown as T[] | undefined) ?? []).forEach((item, index) => {
        const key = id(item);
        const first = owner.get(key);
        if (first === undefined) owner.set(key, part.partId);
        else issues.push(dictionaryIssue('duplicate_id', issuePath(part.partId, field, index), `${label} '${key}' is defined in part '${first}' and again in part '${part.partId}'.`));
      });
    }
  };
  duplicates<ThingDef>('The thing', 'things', (item) => item.thing);
  duplicates<FactDef>('The fact', 'facts', (item) => item.fact);
  duplicates<LinkDef>('The link', 'links', (item) => item.link);
  duplicates<Binding>('The binding', 'bindings', (item) => item.bindingId);
  duplicates<PermissionRule>('The rule', 'permissionRules', (item) => item.ruleId);
  duplicates<SignalRule>('The signal', 'signalRules', (item) => item.signalId);
  duplicates<SettingDef>('The setting', 'settings', (item) => item.key);
  duplicates<StateMap>('The state map', 'stateMaps', (item) => item.id);

  // Which thing replaces which. The replacing thing is defined in the part that says so; the replaced thing in another part.
  const replacedBy = new Map<string, string>();
  work.forEach((part, partIndex) => {
    (part.replaces ?? []).forEach((replacement, index) => {
      const path = issuePath(part.partId, 'replaces', index);
      const defines = (candidate: DictionaryPart, thing: string) => (candidate.things ?? []).some((entry) => entry.thing === thing);
      const refuse = (message: string) => issues.push(dictionaryIssue('merge_replace_invalid', path, message));
      if (replacement.thing === replacement.with) refuse(`'${replacement.thing}' cannot replace itself.`);
      else if (!defines(part, replacement.with)) refuse(`'${replacement.with}' takes the place of '${replacement.thing}', so the same part must define it.`);
      else if (defines(part, replacement.thing)) refuse(`'${replacement.thing}' is replaced, so another part must define it, not part '${part.partId}'.`);
      else if (!work.some((other, otherIndex) => otherIndex !== partIndex && defines(other, replacement.thing))) refuse(`No other part defines '${replacement.thing}', so there is nothing to replace.`);
      else if (replacedBy.has(replacement.thing)) refuse(`'${replacement.thing}' is already replaced by '${replacedBy.get(replacement.thing)}'.`);
      else replacedBy.set(replacement.thing, replacement.with);
    });
  });

  // Follow a chain of replacements to its end; a circle is an error.
  const finalOf = new Map<string, string>();
  for (const replaced of [...replacedBy.keys()].sort(compare)) {
    const seen = new Set([replaced]);
    let current = replacedBy.get(replaced)!;
    while (replacedBy.has(current) && !seen.has(current)) {
      seen.add(current);
      current = replacedBy.get(current)!;
    }
    if (replacedBy.has(current)) issues.push(dictionaryIssue('merge_replace_invalid', issuePath('replaces', replaced), `The replacements of '${replaced}' go round in a circle.`));
    else finalOf.set(replaced, current);
  }
  if (issues.some((found) => found.code === 'merge_replace_invalid')) return { issues };

  const replaced = new Set(finalOf.keys());
  const rename = (thing: string): string => finalOf.get(thing) ?? thing;
  const renamePath = (path: string): string => (replaced.has(headOf(path)) ? `${rename(headOf(path))}${path.slice(headOf(path).length)}` : path);
  const homeOf = new Map<string, string>();
  for (const part of work) for (const thing of part.things ?? []) if (replaced.has(thing.thing)) homeOf.set(thing.thing, part.partId);

  const things: ThingDef[] = [];
  const facts: FactDef[] = [];
  const links: LinkDef[] = [];
  const bindings: Binding[] = [];
  const permissionRules: PermissionRule[] = [];
  const signalRules: SignalRule[] = [];
  const settings: SettingDef[] = [];
  const stateMaps: StateMap[] = [];
  const contractChanges: ContractChange[] = [];
  const severities: string[] = [];
  const carried = new Map<string, string[]>();
  const removedFacts = new Set<string>();
  const removedLinks = new Set<string>();
  const redirected: Redirected[] = [];
  const stranded: Array<{ path: string; message: string }> = [];

  for (const part of work) {
    for (const thing of part.things ?? []) {
      if (replaced.has(thing.thing)) carried.set(rename(thing.thing), [...(carried.get(rename(thing.thing)) ?? []), ...thing.aliases]);
      else things.push(thing);
    }
    for (const fact of part.facts ?? []) {
      if (replaced.has(fact.thing)) removedFacts.add(fact.fact);
      else facts.push(fact);
    }
    for (const link of part.links ?? []) {
      if (replaced.has(link.from)) removedLinks.add(link.link);
      else {
        if (replaced.has(link.to)) link.to = rename(link.to);
        links.push(link);
      }
    }
    settings.push(...(part.settings ?? []));
    stateMaps.push(...(part.stateMaps ?? []));
    severities.push(...(part.severities ?? []));
  }

  for (const thing of things) {
    const extra = carried.get(thing.thing);
    if (extra) thing.aliases = united(thing.aliases, extra);
  }

  for (const part of work) {
    for (const binding of part.bindings ?? []) {
      const path = binding.target.kind === 'fact' ? binding.target.fact : binding.target.link;
      const gone = binding.target.kind === 'fact' ? removedFacts.has(path) : removedLinks.has(path);
      if (!gone && !replaced.has(headOf(path))) bindings.push(binding);
    }

    for (const rule of part.permissionRules ?? []) {
      const thing = rule.target.thing;
      if (replaced.has(thing)) {
        if (homeOf.get(thing) === part.partId) continue;
        rule.target.thing = rename(thing);
      }
      if (rule.target.facts) {
        rule.target.facts = rule.target.facts.map((fact) => {
          const renamed = renamePath(fact);
          if (renamed !== fact) redirected.push({ path: issuePath(part.partId, 'permissionRules', rule.ruleId), subject: `Rule '${rule.ruleId}'`, name: renamed, kind: 'fact' });
          return renamed;
        });
      }
      permissionRules.push(rule);
    }

    for (const signal of part.signalRules ?? []) {
      if (replaced.has(signal.appliesTo)) {
        if (homeOf.get(signal.appliesTo) === part.partId) continue;
        signal.appliesTo = rename(signal.appliesTo);
      }
      const path = issuePath(part.partId, 'signalRules', signal.signalId);
      const subject = `Signal '${signal.signalId}'`;
      for (const input of signal.inputs) {
        const renamed = renamePath(input.fact);
        if (renamed !== input.fact) redirected.push({ path, subject, name: renamed, kind: 'fact' });
        input.fact = renamed;
      }
      signal.formula = redirectFormula(signal.formula, {
        fact: (name) => {
          const renamed = renamePath(name);
          if (renamed !== name) redirected.push({ path, subject, name: renamed, kind: 'fact' });
          return renamed;
        },
        link: (name) => {
          if (removedLinks.has(name)) stranded.push({ path, message: `${subject} reads over the link '${name}', which goes when its thing is replaced.` });
        },
      });
      signalRules.push(signal);
    }

    for (const change of part.contractChanges ?? []) {
      const head = headOf(change.factOrLink);
      if (replaced.has(head)) {
        if (homeOf.get(head) === part.partId) continue;
        const renamed = renamePath(change.factOrLink);
        redirected.push({ path: issuePath(part.partId, 'contractChanges', change.factOrLink), subject: `The contract change for '${change.factOrLink}'`, name: renamed, kind: 'fact or link' });
        change.factOrLink = renamed;
      }
      contractChanges.push(change);
    }
  }

  for (const link of links) {
    for (const name of [...(link.via ?? []), ...(link.inverse ? [link.inverse] : [])]) {
      if (removedLinks.has(name)) stranded.push({ path: issuePath('links', link.link), message: `The link '${link.link}' refers to '${name}', which goes when its thing is replaced.` });
    }
  }

  const factNames = new Set(facts.map((fact) => fact.fact));
  const linkNames = new Set(links.map((link) => link.link));
  for (const found of redirected) {
    const exists = found.kind === 'fact' ? factNames.has(found.name) : found.kind === 'link' ? linkNames.has(found.name) : factNames.has(found.name) || linkNames.has(found.name);
    if (!exists) stranded.push({ path: found.path, message: `${found.subject} was redirected to '${found.name}', but the replacement has no ${found.kind} of that name.` });
  }
  for (const found of stranded) issues.push(dictionaryIssue('merge_unredirectable', found.path, found.message));
  if (issues.some((found) => found.severity === 'error')) return { issues };

  const block: JaxOntologyRelease = {
    schemaVersion: JAX_ONTOLOGY_SCHEMA_VERSION,
    ontologyId: header.ontologyId,
    enabled: header.enabled,
    selfConnector: header.selfConnector,
    ...(header.claimGuard ? { claimGuard: header.claimGuard } : {}),
    things: sortedBy(things, (item) => item.thing),
    facts: sortedBy(facts, (item) => item.fact),
    links: sortedBy(links, (item) => item.link),
    bindings: sortedBy(bindings, (item) => item.bindingId),
    permissionRules: sortedBy(permissionRules, (item) => item.ruleId),
    signalRules: sortedBy(signalRules, (item) => item.signalId),
    settings: sortedBy(settings, (item) => item.key),
    severities: united(severities),
    stateMaps: sortedBy(stateMaps, (item) => item.id),
    contractChanges: sortedBy(contractChanges, (item) => [item.factOrLink, item.approvedAt, item.approvedBy, item.reason].join('\u0000')),
    ...(header.notes !== undefined ? { notes: header.notes } : {}),
  };
  return { block, issues };
}

interface FormulaRedirect {
  /** Called for every fact an input names; returns the name to use. */
  fact: (name: string) => string;
  /** Called for every link a list is read over. */
  link: (name: string) => void;
}

/** A copy of the formula with every input that names a fact passed through `redirect.fact`. */
function redirectFormula(formula: Formula, redirect: FormulaRedirect): Formula {
  const operand = (value: Operand): Operand => {
    if ('input' in value) return { input: value.input.includes('.') ? redirect.fact(value.input) : value.input };
    if ('formula' in value) return { formula: redirectFormula(value.formula, redirect) };
    if ('over' in value) {
      redirect.link(value.over);
      return { over: value.over, where: redirectFormula(value.where, redirect) };
    }
    return value;
  };
  switch (formula.op) {
    case 'ratio': return { op: 'ratio', num: operand(formula.num), den: operand(formula.den) };
    case 'compare': return { op: 'compare', cmp: formula.cmp, left: operand(formula.left), right: operand(formula.right) };
    case 'age': return { op: 'age', of: operand(formula.of), unit: formula.unit };
    case 'count': return { op: 'count', of: operand(formula.of) };
    case 'positive': return { op: 'positive', of: operand(formula.of) };
    case 'is_past': return { op: 'is_past', of: operand(formula.of) };
    case 'any': {
      redirect.link(formula.of.over);
      return { op: 'any', of: { over: formula.of.over, where: redirectFormula(formula.of.where, redirect) } };
    }
    case 'and': return { op: 'and', of: formula.of.map((inner) => redirectFormula(inner, redirect)) };
    case 'or': return { op: 'or', of: formula.of.map((inner) => redirectFormula(inner, redirect)) };
  }
}
