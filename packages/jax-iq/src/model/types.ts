/**
 * The JAX IQ model: a written dictionary of the things a business cares about (account, order, invoice, ticket and so on), where each
 * fact about them lives, which system wins when two disagree, and who may see what.
 *
 * It is the shape of the release block `extensions.jaxOntology` and of the part files that block is merged from. The Zod twin is in
 * `schema.ts`: it refuses unknown keys and caps every list. Nothing here holds a number a person must decide: thresholds, freshness
 * limits, timeouts and the like are named settings whose value is `null` until the owner sets them.
 */

export type ThingName = string;          // 'Account'
export type FactPath = string;           // 'Account.balance'
export type LinkName = string;           // 'Account.orders'
export type KeyKind = string;            // an identifier kind the dictionary declares, e.g. 'account_number'
export type ConnectorId = string;        // equals a connectorId in the pack's extensions.connectors
export type SettingKey = string;         // a named setting in the same release, e.g. 'credit.useWatch'
export type Environment = 'dev' | 'test' | 'staging' | 'production';

export interface JaxOntologyRelease {
  schemaVersion: '1.0.0';
  ontologyId: string;
  /** False: the chat tools are not offered and a release check looks at the shape only. */
  enabled: boolean;
  /** The pack connector id that offers the JAX IQ chat tools. */
  selfConnector: ConnectorId;
  /** `withhold`: the reply checker holds back a figure it cannot trace to a JAX IQ answer. Absent means `off`. */
  claimGuard?: { figures: 'off' | 'withhold' };
  things: ThingDef[];
  facts: FactDef[];
  links: LinkDef[];
  /** Fact bindings and link bindings. */
  bindings: Binding[];
  permissionRules: PermissionRule[];
  signalRules: SignalRule[];
  /** Every threshold, freshness limit, timeout, retry and limit the engine or a signal reads. */
  settings: SettingDef[];
  /** The owner's names for how serious a signal is, for example 'watch'. */
  severities: string[];
  /** Declared conversions between two systems' statuses. */
  stateMaps: StateMap[];
  /** Signed-off differences when a fact is bound to another source. */
  contractChanges: ContractChange[];
  notes?: string;
}

/**
 * One dictionary file. The same arrays as the release block, every one optional, plus the part's id. Parts are merged into one block;
 * a part may replace a thing another part defines (the replaced thing goes, and the links that pointed at it are redirected).
 */
export interface DictionaryPart {
  partId: string;
  replaces?: PartReplacement[];
  things?: ThingDef[];
  facts?: FactDef[];
  links?: LinkDef[];
  bindings?: Binding[];
  permissionRules?: PermissionRule[];
  signalRules?: SignalRule[];
  settings?: SettingDef[];
  severities?: string[];
  stateMaps?: StateMap[];
  contractChanges?: ContractChange[];
}

export interface PartReplacement {
  /** The thing that goes. */
  thing: ThingName;
  /** The thing, defined in the same part, that takes its place. */
  with: ThingName;
}

export interface ThingDef {
  thing: ThingName;
  /** One plain line. */
  meaning: string;
  /** The words people use for it, for example 'customer' for Account. */
  aliases: string[];
  /** For the editor only. */
  group: string;
  /** `modelled_only`: written down, no binding yet; a question about it answers "no source". */
  status: 'active' | 'modelled_only';
  key: { canonical: KeyKind; pattern: string };
  /** Every identifier this thing has, per system. */
  keyKinds: KeyKindDef[];
  labelFact: FactPath;
  /** What `find` matches words against. */
  searchFacts: FactPath[];
  /** The facts `get` returns when the caller names none. */
  defaultFacts: FactPath[];
  /** The systems where a record should exist; they drive the "unmatched" report. */
  expectedIn: ConnectorId[];
}

export interface KeyKindDef {
  kind: KeyKind;
  system: ConnectorId | 'jaxiq';
  evidence: KeyEvidence;
  /** A regular expression, written as text, that a value of this kind matches. */
  pattern?: string;
  caseRule: 'as_is' | 'upper' | 'lower';
  /** False while the source field does not exist yet or the connector does not read it. */
  ready: boolean;
}

/** How a link between two systems' records was established. */
export type KeyEvidence = 'real_field' | 'text_note' | 'tag' | 'name_only';

export type FactType = 'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime' | 'boolean' | 'enum' | 'ref' | 'list';

export interface FactDef {
  fact: FactPath;
  thing: ThingName;
  label: string;
  /** One line. The assistant reads it. */
  meaning: string;
  type: FactType;
  /** Required for `enum`, refused for every other type. */
  enumValues?: string[];
  /** The kind of freshness limit that applies: the setting is `freshness.<kind>`. A plain word; the kinds are data. */
  freshnessKind: string;
  /** False: an old value is never shown as current. */
  allowStale: boolean;
  /** Free text from a vendor (a ticket subject, a next step): marked untrusted when shown to the model. */
  freeText?: boolean;
  /** Members of the knowledge package's claim classes; they unlock reply wording. */
  claimClasses?: string[];
}

export interface LinkDef {
  link: LinkName;
  from: ThingName;
  to: ThingName;
  meaning: string;
  cardinality: '1:1' | '1:n' | 'n:1' | 'n:n';
  /** A named composite path, fixed in the dictionary. There is no free walk of the graph. */
  via?: LinkName[];
  /** Include the division units of an Account. */
  rollsUpDivisions?: boolean;
  inverse?: LinkName;
}

export type ArgSource =
  | { from: 'key'; kind: KeyKind }                          // from the key table, for the resolved thing
  | { from: 'request'; param: string }                      // from the caller's request, a filter
  | { from: 'literal'; value: string | number | boolean };  // fixed by the binding

export interface Binding {
  bindingId: string;
  target: { kind: 'fact'; fact: FactPath } | { kind: 'link'; link: LinkName };
  /** Must be an enabled connector of the same pack. */
  system: ConnectorId;
  /** Must be listed there as a read tool. */
  tool: string;
  args: Record<string, ArgSource>;
  /** A dot path into the tool's answer, for example 'record.balance'. No expressions. */
  select: string;
  /** For links: where the list is and which field of a row is the target's key. */
  rows?: { path: string; keyField: string };
  /** For money: the path to the currency. */
  currencyFrom?: string;
  /** How the tool says "there are more". */
  page?: { totalPath?: string; morePath?: string };
  /** `optional`: absent means "not recorded in the source". `required`: absent means the answer has the wrong shape. */
  presence: 'required' | 'optional';
  authority: 'source_of_truth' | 'cross_check' | 'fallback';
  /** The id of a declared StateMap, the only conversion allowed. */
  stateMap?: string;
  freshnessKind: string;
  contract: MeaningContract;
  /** In plain words: the connector setting this binding relies on. */
  precondition?: string;
  /** Names a test fixture whose expected answer lives in the test suite. Required for `source_of_truth`. */
  selfTest?: { fixtureId: string };
}

/** What a number or a count means, in five lines. `unknown` is a legal, visible value. */
export interface MeaningContract {
  unit: string | 'unknown' | 'not_applicable';
  currency: string | 'from_record' | 'unknown' | 'not_applicable';
  tax: 'includes_tax' | 'excludes_tax' | 'unknown' | 'not_applicable';
  taxLabel?: string;
  /** Which time the "as of" stamp means for this binding. */
  asOf: 'source_updated' | 'retrieved';
  counts: string | 'unknown';
}

/** A person-signed difference. Without one, a fact bound to another source must keep the same contract. */
export interface ContractChange {
  factOrLink: string;
  from: MeaningContract;
  to: MeaningContract;
  conversionRule?: string;
  reason: string;
  /** A name. */
  approvedBy: string;
  /** A time, ISO 8601. */
  approvedAt: string;
}

export interface StateMap {
  id: string;
  from: string;
  to: string;
  table: Array<{ from: string; to: string }>;
  /** True when the conversion drops information; a person sees that in the release checks. */
  lossy: boolean;
}

/** Members of staff in these groups; an empty list means every member of staff. Customers are not covered in this version. */
export interface WhoClause {
  audience: 'staff';
  groups: string[];
}

/** A write tool a `change` rule limits. */
export interface WriteToolRef {
  connectorId: ConnectorId;
  tool: string;
}

/**
 * An allow-list on top of the per-tool table: the rule can only narrow what the table gives, never widen it, so it has no field that
 * names a tool state. `see`: only the people in `who` may read the facts. `change`: only the people in `who` may use the named write
 * tools. A person no clause matches is denied; a fact no `see` rule names is denied.
 */
export interface PermissionRule {
  ruleId: string;
  mode: 'see' | 'change';
  /** No facts means the whole thing. */
  target: { thing: ThingName; facts?: FactPath[] };
  who: WhoClause[];
  /** The write tools a `change` rule limits. Required for `change`, refused for `see`. */
  writeTools?: WriteToolRef[];
  note?: string;
}

export interface SettingDef {
  key: SettingKey;
  label: string;
  kind: 'threshold' | 'freshness' | 'timeout' | 'retry' | 'limit' | 'display';
  unit: 'ratio' | 'percent' | 'count' | 'money' | 'seconds' | 'milliseconds' | 'days' | 'text';
  /** Who answers for the value, for example 'finance' for credit. */
  ownerRole: string;
  /** `null`: not set. No default exists anywhere in code. */
  value: number | null;
}

/**
 * A list over a link, with a test on each item. `where` reads the item's facts: inside it an `input` is a fact of the thing the link
 * leads to, for example 'Ticket.priority'. A `where` holds no list operand of its own.
 */
export interface ListOperand {
  over: LinkName;
  where: Formula;
}

/**
 * What a formula reads. There is no literal number: a threshold is a named setting, and zero is the `positive` test.
 * An `input` is the name of one of the rule's inputs (or, inside a list operand's `where`, an item fact). A `text` is a word such as
 * a status; it is never a number.
 */
export type Operand =
  | { input: string }
  | { setting: SettingKey }
  | { formula: Formula }
  | { text: string }
  | ListOperand;

export type Formula =
  | { op: 'ratio'; num: Operand; den: Operand }                                  // den zero or missing: not worked out
  | { op: 'compare'; cmp: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; left: Operand; right: Operand }
  | { op: 'age'; of: Operand; unit: 'days' | 'hours' | 'minutes' }               // now minus a date, in the stated unit
  | { op: 'count'; of: Operand }
  | { op: 'any'; of: ListOperand }                                                // true when one item meets the test
  | { op: 'and'; of: Formula[] }
  | { op: 'or'; of: Formula[] }
  | { op: 'positive'; of: Operand }                                               // above zero
  | { op: 'is_past'; of: Operand };                                               // a date before now

export interface SignalRule {
  signalId: string;
  name: string;
  meaning: string;
  appliesTo: ThingName;
  /** One of the release's severities. */
  severity: string;
  inputs: Array<{ name: string; fact: FactPath; maxAge?: SettingKey; requireAuthority?: Binding['authority'] }>;
  formula: Formula;
  /** Every threshold the rule reads. */
  settings: SettingKey[];
  /** `active` also needs `activatedBy` and `activatedAt`, and every setting it reads must hold a value. A draft cannot fire. */
  status: 'draft' | 'active';
  /** A name. */
  activatedBy?: string;
  /** A time, ISO 8601. */
  activatedAt?: string;
  /** Sentences the assistant may use for the result. */
  wording: string[];
}
