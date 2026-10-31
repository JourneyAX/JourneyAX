import { connectorToolState, type ConnectorsExtension } from '@journeyax/business-pack';
import { ENGINE_SETTINGS, JaxOntologyReleaseSchema } from '../model';
import type { Binding, Formula, JaxOntologyRelease, Operand, SettingDef } from '../model';
import { dictionaryIssue, issuePath, type DictionaryIssue, type DictionaryIssueCode } from './issues';

/**
 * The release checks for a dictionary block (the spec's R1 to R6 and R8 to R14, plus the ones this build adds). Pure and deterministic:
 * no clock, no I/O, the same input gives the same issues in the same order, and nothing passed in is changed.
 *
 * R7 (a re-bound fact keeps its meaning) and R15 (a rule is never looser than the per-tool table) belong to other modules.
 *
 * A block that is switched off (`enabled: false`) is checked against the schema only, so a mistake in it cannot stop an unrelated
 * release. A block that does not pass the schema gets the schema's findings and the shape checks below, nothing more.
 *
 * `partial` checks one part on its own. The names it expects from other parts are given in `external`, one flat list: a thing (all of
 * its facts and links count), a fact, a link, a setting, a key kind or a severity. The checks that need the whole dictionary (every
 * engine setting declared) are not run on a part. A rule added after version 1 must be a warning, never an error.
 */

export interface DictionaryCheckContext {
  /** The pack's own `extensions.connectors`: the connectors, their tools and the per-tool table. */
  connectors: ConnectorsExtension | undefined;
  /** The claim classes the reply checker knows. */
  knownClaimClasses: readonly string[];
  /** Check one part alone. */
  partial?: { external: string[] };
}

export function checkDictionary(input: unknown, ctx: DictionaryCheckContext): DictionaryIssue[] {
  const parsed = JaxOntologyReleaseSchema.safeParse(input);
  const found: DictionaryIssue[] = parsed.success ? [] : parsed.error.issues.map((entry) => dictionaryIssue('schema', issuePath(...entry.path), entry.message));
  if (isRecord(input) && input.enabled === false) return found;
  found.push(...checkShape(input));
  if (parsed.success) found.push(...checkMeaning(parsed.data, ctx));
  return found;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isFilled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
/** A word taken from the block, short enough to put in a sentence. */
const shown = (value: unknown): string => (typeof value === 'string' && value.length <= 60 ? `'${value}'` : 'a value that is not allowed');

const CONTRACT_LINES = ['unit', 'currency', 'tax', 'asOf', 'counts'] as const;

const REFUSED_SCOPES = new Map<string, string>([
  ['own_branch', "is limited to the person's own branch. That cannot be enforced: no source says which branch a person belongs to."],
  ['owned_by_me', 'is limited to the accounts the person owns. That cannot be enforced: no source says who owns which account.'],
  ['own_company', "is limited to the person's own company. This version covers staff only; customers have no rules here."],
]);

/** What can be checked on any input, even one that does not pass the schema, so each failing case gets its own plain message. */
function checkShape(input: unknown): DictionaryIssue[] {
  if (!isRecord(input)) return [];
  const found: DictionaryIssue[] = [];
  asList(input.permissionRules).forEach((rule, index) => {
    if (!isRecord(rule)) return;
    const name = isFilled(rule.ruleId) ? `Rule ${shown(rule.ruleId)}` : 'A rule';
    const at = (...rest: Array<string | number>) => issuePath('permissionRules', index, ...rest);
    if (typeof rule.scope === 'string' && REFUSED_SCOPES.has(rule.scope)) found.push(dictionaryIssue('r11_scope_refused', at('scope'), `${name} ${REFUSED_SCOPES.get(rule.scope)}`));
    asList(rule.who).forEach((clause, position) => {
      if (isRecord(clause) && (clause.audience !== 'staff' || 'roles' in clause)) {
        found.push(dictionaryIssue('r11_clause_refused', at('who', position), `${name} names people who are not staff. This version covers staff only; customers have no rules here.`));
      }
    });
    if (rule.mode !== 'see' && rule.mode !== 'change') {
      found.push(dictionaryIssue('rule_mode_unsupported', at('mode'), `${name} uses the mode ${shown(rule.mode)}. Only 'see' and 'change' are enforced, and a rule nothing enforces would look like protection.`));
    }
  });
  asList(input.contractChanges).forEach((change, index) => {
    if (isRecord(change) && !isFilled(change.approvedBy)) {
      found.push(dictionaryIssue('contract_change_unnamed', issuePath('contractChanges', index, 'approvedBy'), `The contract change for ${shown(change.factOrLink)} does not say who approved it. A person signs every difference.`));
    }
  });
  asList(input.bindings).forEach((binding, index) => {
    if (!isRecord(binding)) return;
    const contract = isRecord(binding.contract) ? binding.contract : {};
    const missing = CONTRACT_LINES.filter((line) => !isFilled(contract[line]));
    if (missing.length > 0) {
      found.push(dictionaryIssue('r6_contract_incomplete', issuePath('bindings', index, 'contract'), `Binding ${shown(binding.bindingId)} does not state all five lines of its meaning contract. Missing: ${missing.join(', ')}. 'unknown' is allowed; a blank is not.`));
    }
  });
  asList(input.signalRules).forEach((signal, index) => {
    if (!isRecord(signal) || signal.status !== 'active') return;
    if (!isFilled(signal.activatedBy) || !isFilled(signal.activatedAt)) {
      found.push(dictionaryIssue('r8_signal_unsigned', issuePath('signalRules', index, 'status'), `Signal ${shown(signal.signalId)} is switched on but does not say who switched it on and when.`));
    }
  });
  return found;
}

const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|secret|token|api[_ -]?key|client[_ -]?secret)\s*[:=]\s*\S+/i,
  /\btenant-secret:/i,
  /\b[0-9a-f]{32,}\b/i,
];
const ADDRESS_SHAPES: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /\bwww\./i,
  /\blocalhost\b/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  // A host and a port. The last label of a host name has a letter in it, so a time like 09:30:00.123-05:00 is not one.
  /\b(?:[a-z0-9-]+\.)+(?=[a-z0-9-]*[a-z])[a-z0-9-]+:\d{2,5}\b/i,
];
const PATH_SHAPES: RegExp[] = [
  /(?:^|[\s"'(=,;])\/[A-Za-z0-9_.~-]{2,}/,
  /(?:^|[\s"'(=,;])(?:~|\.{1,2})\/[A-Za-z0-9_.~-]*/,
  /\b[A-Za-z]:\\\S/,
  /\\\\[A-Za-z0-9_.-]+\\/,
];
/** A key pattern is a regular expression written as text. */
const PATTERN_FIELD = /^things\[\d+\]\.(?:key|keyKinds\[\d+\])\.pattern$/;
/**
 * The texts the secret, address and path shapes are tried on. A key pattern is tried as written and with its escapes undone, because
 * an escaped slash and a plain slash match the same character: `https:\/\/` is still a web address and `sk\-` still starts a key.
 * Only escapes of punctuation are undone, so `\d` stays `\d`. Any other text is tried as written.
 */
const variantsOf = (path: string, text: string): readonly string[] =>
  PATTERN_FIELD.test(path) ? [text, text.replace(/\\([^A-Za-z0-9])/g, '$1')] : [text];
/**
 * What is still a path when the text is a regular expression: a lone slash, `\d` or `C:` before a class is not one, but slashes between
 * literal words, a home folder, a drive folder and a network share are.
 */
const PATTERN_PATH_SHAPES: RegExp[] = [
  /(?:^|[\s"'(=,;|^:[{<])\/[A-Za-z0-9_.~-]{2,}(?:\/[A-Za-z0-9_.~-]|$|[\s"')$|;,\]}>])/,
  /(?:^|[\s"'(=,;|^:[{<])(?:~\/|\.{1,2}\/[A-Za-z0-9_.~-])/,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:\\[A-Za-z0-9_.~-]{2,}(?:\\|$|[\s"')])/,
  /\\\\[A-Za-z0-9_.-]+\\/,
];
const holdsPath = (path: string, variants: readonly string[]): boolean =>
  PATTERN_FIELD.test(path)
    ? variants.some((variant) => PATTERN_PATH_SHAPES.some((shape) => shape.test(variant)))
    : PATH_SHAPES.some((shape) => shape.test(variants[0]));

/** A run of 32 or more letters and digits holding both: the look of a key or a hash. */
const looksLikeKey = (text: string): boolean => (text.match(/[A-Za-z0-9]{32,}/g) ?? []).some((run) => /\d/.test(run) && /[A-Za-z]/.test(run));

/** Every text in the value, with where it is. Names are not scanned, only what is written under them. */
function textsOf(value: unknown, path: string, into: Array<{ path: string; text: string }>): void {
  if (typeof value === 'string') into.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((item, index) => textsOf(item, `${path}[${index}]`, into));
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) textsOf(item, path === '' ? key : `${path}.${key}`, into);
}

function checkNeutral(block: JaxOntologyRelease): DictionaryIssue[] {
  const texts: Array<{ path: string; text: string }> = [];
  textsOf(block, '', texts);
  const found: DictionaryIssue[] = [];
  for (const { path, text } of texts) {
    const variants = variantsOf(path, text);
    if (variants.some((variant) => SECRET_SHAPES.some((shape) => shape.test(variant)) || looksLikeKey(variant))) {
      found.push(dictionaryIssue('r12_secret', path, 'This text looks like a secret or a key. A dictionary holds names only; keep secrets in the secret store.'));
    } else if (variants.some((variant) => ADDRESS_SHAPES.some((shape) => shape.test(variant)))) {
      found.push(dictionaryIssue('r12_address', path, 'This text looks like a web address, a host or a network address. A dictionary holds names only; addresses are settings of the service.'));
    } else if (holdsPath(path, variants)) {
      found.push(dictionaryIssue('r12_path', path, 'This text looks like a file path. A dictionary holds names only and does not depend on where a file sits.'));
    }
  }
  return found;
}

const FIRST_OF = <T>(items: readonly T[], key: (item: T) => string): Map<string, T> => {
  const first = new Map<string, T>();
  items.forEach((item) => {
    if (!first.has(key(item))) first.set(key(item), item);
  });
  return first;
};

/** The thing a fact or link path starts with: 'Account.balance' is 'Account'. */
const headOf = (path: string): string => path.slice(0, Math.max(path.indexOf('.'), 0));

/** What an unset setting means, in a sentence, by kind. */
const WHEN_UNSET: Partial<Record<SettingDef['kind'], string>> = {
  timeout: 'the default time limit of the connector client applies',
  retry: 'a failed call is not repeated and there is no cool-down',
  freshness: 'nothing is kept between questions, so every question asks the system again',
};

function checkMeaning(block: JaxOntologyRelease, ctx: DictionaryCheckContext): DictionaryIssue[] {
  const found: DictionaryIssue[] = [];
  const add = (code: DictionaryIssueCode, path: string, message: string) => found.push(dictionaryIssue(code, path, message));
  const partial = ctx.partial !== undefined;
  const external = new Set(ctx.partial?.external ?? []);
  const connectors = ctx.connectors;
  const claimClasses = new Set(ctx.knownClaimClasses);

  const things = FIRST_OF(block.things, (item) => item.thing);
  const facts = FIRST_OF(block.facts, (item) => item.fact);
  const links = FIRST_OF(block.links, (item) => item.link);
  const settings = FIRST_OF(block.settings, (item) => item.key);
  const stateMaps = FIRST_OF(block.stateMaps, (item) => item.id);
  const severities = new Set(block.severities);
  const keyKinds = new Set(block.things.flatMap((thing) => thing.keyKinds.map((kind) => kind.kind)));

  const outsideThing = (name: string) => external.has(name) && !things.has(name);
  const thingKnown = (name: string) => things.has(name) || external.has(name);
  const factKnown = (path: string) => facts.has(path) || external.has(path) || outsideThing(headOf(path));
  const linkKnown = (path: string) => links.has(path) || external.has(path) || outsideThing(headOf(path));
  const settingKnown = (key: string) => settings.has(key) || external.has(key);
  const stateMapKnown = (id: string) => stateMaps.has(id) || external.has(id);
  const severityKnown = (word: string) => severities.has(word) || external.has(word);
  const kindKnown = (kind: string) => keyKinds.has(kind) || external.has(kind);

  const unknown = (path: string, what: string, name: string) =>
    add('r4_unknown_name', path, `The ${what} '${name}' is not defined in the dictionary.${partial ? ' This part is checked on its own: if another part defines it, list it as external.' : ''}`);

  // Every id is defined once, or the lookups would disagree with the file.
  const unique = <T>(label: string, field: string, items: readonly T[], id: (item: T) => string) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(id(item))) add('duplicate_id', issuePath(field, index), `The ${label} '${id(item)}' is defined more than once.`);
      seen.add(id(item));
    });
  };
  unique('thing', 'things', block.things, (item) => item.thing);
  unique('fact', 'facts', block.facts, (item) => item.fact);
  unique('link', 'links', block.links, (item) => item.link);
  unique('binding', 'bindings', block.bindings, (item) => item.bindingId);
  unique('rule', 'permissionRules', block.permissionRules, (item) => item.ruleId);
  unique('signal', 'signalRules', block.signalRules, (item) => item.signalId);
  unique('setting', 'settings', block.settings, (item) => item.key);
  unique('state map', 'stateMaps', block.stateMaps, (item) => item.id);

  const freshnessUsers = new Map<string, string>();
  const noteFreshness = (kind: string, path: string) => {
    if (!freshnessUsers.has(kind)) freshnessUsers.set(kind, path);
  };

  block.things.forEach((thing, index) => {
    const at = (...rest: Array<string | number>) => issuePath('things', index, ...rest);
    if (!factKnown(thing.labelFact)) unknown(at('labelFact'), 'fact', thing.labelFact);
    thing.searchFacts.forEach((fact, position) => {
      if (!factKnown(fact)) unknown(at('searchFacts', position), 'fact', fact);
    });
    thing.defaultFacts.forEach((fact, position) => {
      if (!factKnown(fact)) unknown(at('defaultFacts', position), 'fact', fact);
    });
    if (!thing.keyKinds.some((kind) => kind.kind === thing.key.canonical)) unknown(at('key', 'canonical'), 'key kind', thing.key.canonical);
  });

  block.facts.forEach((fact, index) => {
    const at = (...rest: Array<string | number>) => issuePath('facts', index, ...rest);
    if (!thingKnown(fact.thing)) unknown(at('thing'), 'thing', fact.thing);
    if (headOf(fact.fact) !== fact.thing) add('r4_name_mismatch', at('fact'), `The fact '${fact.fact}' says it belongs to '${headOf(fact.fact)}' but its thing is '${fact.thing}'.`);
    (fact.claimClasses ?? []).forEach((name, position) => {
      if (!claimClasses.has(name)) add('r13_claim_class_unknown', at('claimClasses', position), `The claim class '${name}' on '${fact.fact}' is not one the reply checker knows.`);
    });
    noteFreshness(fact.freshnessKind, at('freshnessKind'));
  });

  block.links.forEach((link, index) => {
    const at = (...rest: Array<string | number>) => issuePath('links', index, ...rest);
    if (!thingKnown(link.from)) unknown(at('from'), 'thing', link.from);
    if (!thingKnown(link.to)) unknown(at('to'), 'thing', link.to);
    if (headOf(link.link) !== link.from) add('r4_name_mismatch', at('link'), `The link '${link.link}' says it starts at '${headOf(link.link)}' but starts at '${link.from}'.`);
    (link.via ?? []).forEach((name, position) => {
      if (!linkKnown(name)) unknown(at('via', position), 'link', name);
    });
    if (link.inverse && !linkKnown(link.inverse)) unknown(at('inverse'), 'link', link.inverse);
  });

  // R3 helper: can anyone read through this tool? "Ask first" counts as no, because JAX IQ cannot wait for a yes.
  const readable = new Map<string, boolean>();
  const anyoneCanRead = (system: string, tool: string): boolean => {
    const key = `${system}\u0000${tool}`;
    if (!readable.has(key)) {
      const groups = new Set((connectors?.policy ?? []).filter((row) => row.connectorId === system).flatMap((row) => row.groups ?? []));
      const people = [[], ...[...groups].sort().map((group) => [group])];
      readable.set(key, people.some((groupsOfPerson) => connectorToolState(connectors, system, tool, { audience: 'staff', groups: groupsOfPerson }).state === 'allow'));
    }
    return readable.get(key)!;
  };

  const boundFacts = new Set<string>();
  const boundThings = new Set<string>();
  block.bindings.forEach((binding: Binding, index) => {
    const at = (...rest: Array<string | number>) => issuePath('bindings', index, ...rest);
    const label = `Binding '${binding.bindingId}'`;
    const connector = connectors?.connectors.find((entry) => entry.connectorId === binding.system);
    if (!connector) add('r1_system_unavailable', at('system'), `${label} reads from '${binding.system}', which is not a connector of this pack.`);
    else {
      if (connector.enabled === false) add('r1_system_unavailable', at('system'), `${label} reads from '${binding.system}', which is switched off in this pack.`);
      if (connector.connectionScope === 'person') add('r10_person_scoped_connector', at('system'), `${label} reads from '${binding.system}', which uses each person's own sign-in. JAX IQ reads with the shop's sign-in only.`);
      const tool = connector.tools.find((entry) => entry.name === binding.tool);
      if (!tool) add('r2_tool_not_read', at('tool'), `${label} uses the tool '${binding.tool}', which '${binding.system}' does not list.`);
      else if ((tool.sideEffect ?? 'read') !== 'read') add('r2_tool_not_read', at('tool'), `${label} uses the tool '${binding.tool}', which changes something in '${binding.system}'. A binding may use a read tool only.`);
      else if (connector.enabled !== false && !anyoneCanRead(binding.system, binding.tool)) {
        add('r3_tool_blocked_for_all', at('tool'), `${label} uses the tool '${binding.tool}', which is blocked (or set to ask first) for every group, so this fact can never be read.`);
      }
    }

    const target = binding.target.kind === 'fact' ? binding.target.fact : binding.target.link;
    let thing: string | undefined;
    if (binding.target.kind === 'fact') {
      boundFacts.add(target);
      thing = facts.get(target)?.thing ?? headOf(target);
      if (!factKnown(target)) unknown(at('target', 'fact'), 'fact', target);
    } else {
      thing = links.get(target)?.from ?? headOf(target);
      if (!linkKnown(target)) unknown(at('target', 'link'), 'link', target);
    }
    boundThings.add(thing);
    for (const [name, source] of Object.entries(binding.args)) {
      if (source.from === 'key' && !kindKnown(source.kind) && !outsideThing(thing)) unknown(at('args', name, 'kind'), 'key kind', source.kind);
    }
    if (binding.stateMap !== undefined && !stateMapKnown(binding.stateMap)) unknown(at('stateMap'), 'state map', binding.stateMap);
    noteFreshness(binding.freshnessKind, at('freshnessKind'));
    if (binding.authority === 'source_of_truth' && !binding.selfTest) add('r5_no_self_test', at('selfTest'), `${label} is a source of truth, so it needs a self test that names its fixture.`);

    const unclear = (['unit', 'currency', 'tax', 'counts'] as const).filter((line) => binding.contract[line] === 'unknown');
    if (unclear.length > 0) add('r6_contract_unknown', at('contract'), `${label} does not yet say what its value means: ${unclear.join(', ')} ${unclear.length === 1 ? 'is' : 'are'} unknown. Someone has to decide.`);
  });

  block.facts.forEach((fact, index) => {
    if (!boundFacts.has(fact.fact)) add('r5_no_source', issuePath('facts', index), `The fact '${fact.fact}' has no binding, so a question about it answers "no source".`);
  });
  block.things.forEach((thing, index) => {
    if (thing.status === 'active' && !boundThings.has(thing.thing)) add('r5_active_thing_unbound', issuePath('things', index, 'status'), `The thing '${thing.thing}' is marked active but nothing is bound to it. Mark it modelled only, or bind it.`);
  });

  block.permissionRules.forEach((rule, index) => {
    const at = (...rest: Array<string | number>) => issuePath('permissionRules', index, ...rest);
    if (!thingKnown(rule.target.thing)) unknown(at('target', 'thing'), 'thing', rule.target.thing);
    (rule.target.facts ?? []).forEach((fact, position) => {
      if (!factKnown(fact)) unknown(at('target', 'facts', position), 'fact', fact);
      else if (headOf(fact) !== rule.target.thing) add('r4_name_mismatch', at('target', 'facts', position), `Rule '${rule.ruleId}' is about '${rule.target.thing}' but names the fact '${fact}'.`);
    });
  });

  block.signalRules.forEach((signal, index) => {
    const at = (...rest: Array<string | number>) => issuePath('signalRules', index, ...rest);
    if (!thingKnown(signal.appliesTo)) unknown(at('appliesTo'), 'thing', signal.appliesTo);
    if (!severityKnown(signal.severity)) unknown(at('severity'), 'severity', signal.severity);
    const inputNames = new Set(signal.inputs.map((input) => input.name));
    signal.inputs.forEach((input, position) => {
      if (!factKnown(input.fact)) unknown(at('inputs', position, 'fact'), 'fact', input.fact);
      if (input.maxAge !== undefined && !settingKnown(input.maxAge)) unknown(at('inputs', position, 'maxAge'), 'setting', input.maxAge);
    });
    signal.settings.forEach((key, position) => {
      if (!settingKnown(key)) unknown(at('settings', position), 'setting', key);
    });

    // The formula: its inputs are the rule's inputs; inside a list test they are facts of the thing the link leads to.
    const read: string[] = [];
    type Item = { thing: string | undefined };
    const walk = (formula: Formula, item: Item | undefined): void => {
      const operand = (value: Operand): void => {
        if ('input' in value) return readInput(value.input, item);
        if ('setting' in value) read.push(value.setting);
        else if ('formula' in value) walk(value.formula, item);
        else if ('over' in value) readList(value.over, value.where);
      };
      switch (formula.op) {
        case 'ratio': operand(formula.num); operand(formula.den); break;
        case 'compare': operand(formula.left); operand(formula.right); break;
        case 'age': case 'count': case 'positive': case 'is_past': operand(formula.of); break;
        case 'any': readList(formula.of.over, formula.of.where); break;
        case 'and': case 'or': formula.of.forEach((inner) => walk(inner, item)); break;
      }
    };
    const readList = (over: string, where: Formula): void => {
      if (!linkKnown(over)) unknown(at('formula'), 'link', over);
      walk(where, { thing: links.get(over)?.to });
    };
    const readInput = (name: string, item: Item | undefined): void => {
      if (!item) {
        if (!inputNames.has(name)) unknown(at('formula'), 'signal input', name);
      } else if (!name.includes('.')) {
        add('r4_unknown_name', at('formula'), `Inside a list test the input '${name}' must be a fact of the thing the link leads to, written like 'Thing.name'.`);
      } else if (item.thing !== undefined && headOf(name) !== item.thing) {
        add('r4_name_mismatch', at('formula'), `Inside a list test the input '${name}' must be a fact of '${item.thing}', the thing the link leads to.`);
      } else if (!factKnown(name)) unknown(at('formula'), 'fact', name);
    };
    walk(signal.formula, undefined);
    for (const key of read) if (!settingKnown(key)) unknown(at('formula'), 'setting', key);

    if (signal.status === 'active') {
      for (const key of new Set([...signal.settings, ...read])) {
        if (settings.get(key)?.value === null) add('r8_signal_setting_unset', at('status'), `Signal '${signal.signalId}' is switched on but reads the setting '${key}', which has no value yet. Give it a value or switch the signal off.`);
      }
    }
  });

  block.settings.forEach((setting, index) => {
    const meaning = WHEN_UNSET[setting.kind];
    if (meaning !== undefined && setting.value === null) add('r9_setting_unset', issuePath('settings', index, 'value'), `The setting '${setting.key}' has no value yet. Until it has one, ${meaning}.`);
  });

  block.stateMaps.forEach((stateMap, index) => {
    if (!stateMap.lossy) return;
    const sources = new Map<string, string[]>();
    stateMap.table.forEach((row) => sources.set(row.to, [...(sources.get(row.to) ?? []), row.from]));
    const merged = [...sources].filter(([, from]) => from.length > 1).map(([to, from]) => `${from.map((word) => `'${word}'`).join(', ')} all become '${to}'`);
    add('r14_state_map_lossy', issuePath('stateMaps', index), `The state map '${stateMap.id}' loses information${merged.length > 0 ? `: ${merged.join('; ')}` : ' the table does not show'}.`);
  });

  block.contractChanges.forEach((change, index) => {
    if (!factKnown(change.factOrLink) && !linkKnown(change.factOrLink)) unknown(issuePath('contractChanges', index, 'factOrLink'), 'fact or link', change.factOrLink);
  });

  // Whole-dictionary checks.
  if (!partial) {
    ENGINE_SETTINGS.forEach((name) => {
      if (!settings.has(name)) add('engine_setting_missing', 'settings', `The setting '${name}' is read by the engine but the dictionary does not declare it.`);
    });
  }
  for (const [kind, path] of freshnessUsers) {
    if (!settingKnown(`freshness.${kind}`)) add('freshness_setting_missing', path, `A fact uses the freshness kind '${kind}' but the dictionary has no setting 'freshness.${kind}'.`);
  }

  const own = connectors?.connectors.find((entry) => entry.connectorId === block.selfConnector);
  const withClasses = (own?.tools ?? []).filter((tool) => (tool.claimClasses ?? []).length > 0).map((tool) => tool.name);
  if (withClasses.length > 0 && block.claimGuard?.figures !== 'withhold') {
    add('claim_class_needs_guard', 'claimGuard.figures', `The tools ${withClasses.map((name) => `'${name}'`).join(', ')} of '${block.selfConnector}' list claim classes. A successful call would then let any figure in the reply pass, so the dictionary must say claimGuard.figures is 'withhold'.`);
  }

  found.push(...checkNeutral(block));
  return found;
}
