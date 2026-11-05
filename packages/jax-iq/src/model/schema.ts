import { z } from 'zod';
import type { Formula, ListOperand, Operand } from './types';

/**
 * The Zod twin of `types.ts`. Unknown keys are refused everywhere, every name has a pattern, and every list has a maximum (all lists
 * are built by `list`, which cannot be called without one). It checks the shape of one block or part. Whether the names in it point at
 * something that exists, and whether a binding matches the pack's connectors, is the job of the release checks.
 *
 * A stored release is read again on every load, so a field added after version 1.0.0 must be optional.
 */

/** The only version this schema reads. */
export const JAX_ONTOLOGY_SCHEMA_VERSION = '1.0.0' as const;

const list = <T extends z.ZodType>(item: T, max: number, min = 0) => z.array(item).min(min).max(max);

/** One plain line: not blank, no line break. */
const Line = (max: number) => z.string().min(1).max(max).regex(/^[^\r\n]*\S[^\r\n]*$/, 'one plain line, not blank');

const Identifier = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.\-]*$/, 'an id uses letters, digits and _ . -');
const BindingId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.@#:\-]*$/, 'a binding id uses letters, digits and _ . @ # : -');
/** A thing: capitalised, letters and digits. */
const ThingName = z.string().min(1).max(40).regex(/^[A-Z][A-Za-z0-9]*$/, 'a thing name starts with a capital letter and uses letters and digits');
/** A fact or a link: the thing, a dot, then a name that starts with a lower-case letter. */
const FactPath = z.string().min(1).max(81).regex(/^[A-Z][A-Za-z0-9]{0,39}\.[a-z][A-Za-z0-9]{0,39}$/, "a fact path is 'Thing.name'");
const LinkName = FactPath;
const KeyKind = z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/, 'a key kind uses lower-case letters, digits and _');
/** Same rule as a connector id in the pack. */
const ConnectorId = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?$/, 'a connector id uses lower-case letters, digits and -');
/** Same rule as a tool name in the pack. */
const ToolName = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_\-.]*$/, 'a tool name uses letters, digits and _ - .');
/** Same rule as a group id in the pack. */
const GroupId = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9\-.:]*[a-z0-9])?$/, 'a group id uses lower-case letters, digits and - . :');
/** Dotted words: 'credit.useWatch', 'freshness.credit'. */
const SettingKey = z.string().min(1).max(80).regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/, "a setting key is dotted words, like 'credit.useWatch'");
const FreshnessKind = z.string().min(1).max(40).regex(/^[a-z][A-Za-z0-9]*$/, 'a freshness kind is one word');
/** A path into a tool's answer: names joined by dots, no expressions. */
const AnswerPath = z.string().min(1).max(120).regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/, 'a path is names joined by dots');
const ArgName = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'an argument name uses letters, digits and _');
/** A time with a zone, and a real one: no 30 February, no hour 25. */
const Timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, 'a time like 2026-10-29T09:30:00Z').refine((value) => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return !Number.isNaN(Date.parse(value)) && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, 'not a real time');

/** A regular expression written as text: it must compile. */
const RegexSource = z.string().min(1).max(200).refine((source) => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}, 'not a valid regular expression');

const issue = (ctx: z.RefinementCtx, path: Array<string | number>, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

export const KeyKindDefSchema = z.object({
  kind: KeyKind,
  system: ConnectorId,
  evidence: z.enum(['real_field', 'text_note', 'tag', 'name_only']),
  pattern: RegexSource.optional(),
  caseRule: z.enum(['as_is', 'upper', 'lower']),
  ready: z.boolean(),
}).strict();

export const ThingDefSchema = z.object({
  thing: ThingName,
  meaning: Line(300),
  aliases: list(Line(40), 50),
  group: Line(60),
  status: z.enum(['active', 'modelled_only']),
  key: z.object({ canonical: KeyKind, pattern: RegexSource }).strict(),
  sourceIdentity: z.object({ system: ConnectorId, keyKind: KeyKind }).strict().optional(),
  keyKinds: list(KeyKindDefSchema, 20),
  labelFact: FactPath,
  searchFacts: list(FactPath, 20),
  defaultFacts: list(FactPath, 100),
  expectedIn: list(ConnectorId, 20),
  lookups: list(z.object({
    system: ConnectorId, tool: ToolName, queryArg: ArgName, rows: AnswerPath,
    keyField: AnswerPath, keyKind: KeyKind, labelField: AnswerPath,
  }).strict(), 20).optional(),
}).strict();

export const FactDefSchema = z.object({
  fact: FactPath,
  thing: ThingName,
  label: Line(80),
  meaning: Line(300),
  type: z.enum(['text', 'number', 'money', 'percent', 'date', 'datetime', 'boolean', 'enum', 'ref', 'list']),
  enumValues: list(Line(80), 100, 1).optional(),
  freshnessKind: FreshnessKind,
  allowStale: z.boolean(),
  freeText: z.boolean().optional(),
  claimClasses: list(z.string().min(1).max(40), 11).optional(),
}).strict().superRefine((fact, ctx) => {
  if (fact.type === 'enum' && !fact.enumValues) issue(ctx, ['enumValues'], 'An enum fact needs its values.');
  if (fact.type !== 'enum' && fact.enumValues) issue(ctx, ['enumValues'], 'Only an enum fact has values.');
});

export const LinkDefSchema = z.object({
  link: LinkName,
  from: ThingName,
  to: ThingName,
  meaning: Line(300),
  cardinality: z.enum(['1:1', '1:n', 'n:1', 'n:n']),
  via: list(LinkName, 10).optional(),
  rollsUpDivisions: z.boolean().optional(),
  inverse: LinkName.optional(),
}).strict();

export const MeaningContractSchema = z.object({
  unit: Line(80),
  currency: Line(40),
  tax: z.enum(['includes_tax', 'excludes_tax', 'unknown', 'not_applicable']),
  taxLabel: Line(40).optional(),
  asOf: z.enum(['source_updated', 'retrieved']),
  counts: Line(300),
}).strict();

export const ArgSourceSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('key'), kind: KeyKind, valueType: z.enum(['string', 'integer']).optional() }).strict(),
  z.object({ from: z.literal('request'), param: ArgName, optional: z.boolean().optional() }).strict(),
  z.object({ from: z.literal('principal'), field: z.literal('id') }).strict(),
  z.object({ from: z.literal('literal'), value: z.union([z.string().max(200), z.number().finite(), z.boolean()]) }).strict(),
]);

export const BindingSchema = z.object({
  bindingId: BindingId,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fact'), fact: FactPath }).strict(),
    z.object({ kind: z.literal('link'), link: LinkName }).strict(),
  ]),
  system: ConnectorId,
  tool: ToolName,
  args: z.record(ArgName, ArgSourceSchema).refine((args) => Object.keys(args).length <= 20, 'at most 20 arguments'),
  select: AnswerPath,
  identity: z.object({ keyKind: KeyKind, select: AnswerPath }).strict().optional(),
  rows: z.object({ path: AnswerPath, keyField: AnswerPath, keyKind: KeyKind.optional(), factFields: z.record(FactPath, AnswerPath).refine(value => Object.keys(value).length <= 20, 'At most twenty row fact projections.').optional() }).strict().optional(),
  currencyFrom: AnswerPath.optional(),
  page: z.object({ totalPath: AnswerPath.optional(), morePath: AnswerPath.optional(), nextCursorPath: AnswerPath.optional(), cursorParam: ArgName.optional() }).strict().refine(page => (!page.nextCursorPath && !page.cursorParam) || !!(page.morePath && page.nextCursorPath && page.cursorParam), 'Cursor paging requires morePath, nextCursorPath and cursorParam together.').optional(),
  presence: z.enum(['required', 'optional']),
  authority: z.enum(['source_of_truth', 'cross_check', 'fallback']),
  stateMap: Identifier.optional(),
  freshnessKind: FreshnessKind,
  contract: MeaningContractSchema,
  precondition: Line(300).optional(),
  selfTest: z.object({ fixtureId: Identifier }).strict().optional(),
}).strict();

export const ContractChangeSchema = z.object({
  factOrLink: FactPath,
  from: MeaningContractSchema,
  to: MeaningContractSchema,
  conversionRule: Line(300).optional(),
  reason: Line(300),
  approvedBy: Line(80),
  approvedAt: Timestamp,
}).strict();

export const StateMapSchema = z.object({
  id: Identifier,
  from: Line(120),
  to: Line(120),
  table: list(z.object({ from: Line(80), to: Line(80) }).strict(), 200, 1),
  lossy: z.boolean(),
}).strict();

export const WhoClauseSchema = z.object({
  audience: z.literal('staff'),
  groups: list(GroupId, 50),
}).strict();

export const PermissionRuleSchema = z.object({
  ruleId: Identifier,
  mode: z.enum(['see', 'change']),
  target: z.object({ thing: ThingName, facts: list(FactPath, 100, 1).optional() }).strict(),
  who: list(WhoClauseSchema, 50),
  writeTools: list(z.object({ connectorId: ConnectorId, tool: ToolName }).strict(), 50, 1).optional(),
  note: Line(400).optional(),
}).strict().superRefine((rule, ctx) => {
  if (rule.mode === 'change' && !rule.writeTools) issue(ctx, ['writeTools'], 'A change rule names the write tools it limits.');
  if (rule.mode === 'see' && rule.writeTools) issue(ctx, ['writeTools'], 'Only a change rule names write tools.');
});

export const SettingDefSchema = z.object({
  key: SettingKey,
  label: Line(120),
  kind: z.enum(['threshold', 'freshness', 'timeout', 'retry', 'limit', 'display']),
  unit: z.enum(['ratio', 'percent', 'count', 'money', 'seconds', 'milliseconds', 'days', 'text']),
  ownerRole: Line(60),
  value: z.number().finite().nullable(),
}).strict();

/** A text value is a word such as a status. A number written as text would be a literal number in disguise. */
const TextValue = z.string().min(1).max(80).refine((text) => !(/\d/.test(text) && /^[\s\d.,+\-%$]*$/.test(text)), 'a text value is a word, not a number: a number belongs in a named setting');
/** The name of one of the rule's inputs, or, inside a list operand's `where`, a fact of the item. */
const InputRef = z.string().min(1).max(81).regex(/^(?:[A-Z][A-Za-z0-9]{0,39}\.)?[a-z][A-Za-z0-9]{0,39}$/, "an input is a name, or 'Thing.name' inside a list");

const once = <T>(build: () => T) => {
  let built: T | undefined;
  return () => (built ??= build());
};

/** Every operand an operand holds, depth first. */
function operandsOf(formula: Formula): Operand[] {
  switch (formula.op) {
    case 'ratio': return [formula.num, formula.den];
    case 'compare': return [formula.left, formula.right];
    case 'age': case 'count': case 'positive': case 'is_past': case 'any': return [formula.of];
    case 'and': case 'or': return formula.of.flatMap(operandsOf);
  }
}

/** Every list operand in a formula, however deeply nested in other formulas (but not looking inside a list operand's own `where`). */
function listOperandsOf(formula: Formula): ListOperand[] {
  return operandsOf(formula).flatMap((operand): ListOperand[] => {
    if ('over' in operand) return [operand];
    if ('formula' in operand) return listOperandsOf(operand.formula);
    return [];
  });
}

const operandUnion = once(() => z.union([
  z.object({ input: InputRef }).strict(),
  z.object({ setting: SettingKey }).strict(),
  z.object({ formula: FormulaSchema }).strict(),
  z.object({ text: TextValue }).strict(),
  z.object({ over: LinkName, where: FormulaSchema }).strict(),
]));
export const OperandSchema: z.ZodType<Operand> = z.lazy(() => operandUnion());

const listOperandSchema = once(() => z.object({ over: LinkName, where: FormulaSchema }).strict());
const ListOperandSchema: z.ZodType<ListOperand> = z.lazy(() => listOperandSchema());

const formulaUnion = once(() => z.discriminatedUnion('op', [
  z.object({ op: z.literal('ratio'), num: OperandSchema, den: OperandSchema }).strict(),
  z.object({ op: z.literal('compare'), cmp: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']), left: OperandSchema, right: OperandSchema }).strict(),
  z.object({ op: z.literal('age'), of: OperandSchema, unit: z.enum(['days', 'hours', 'minutes']) }).strict(),
  z.object({ op: z.literal('count'), of: OperandSchema }).strict(),
  z.object({ op: z.literal('any'), of: ListOperandSchema }).strict(),
  z.object({ op: z.literal('and'), of: list(FormulaSchema, 20, 1) }).strict(),
  z.object({ op: z.literal('or'), of: list(FormulaSchema, 20, 1) }).strict(),
  z.object({ op: z.literal('positive'), of: OperandSchema }).strict(),
  z.object({ op: z.literal('is_past'), of: OperandSchema }).strict(),
]));
export const FormulaSchema: z.ZodType<Formula> = z.lazy(() => formulaUnion());

export const SignalRuleSchema = z.object({
  signalId: Identifier,
  name: Line(80),
  meaning: Line(300),
  appliesTo: ThingName,
  severity: Line(40),
  inputs: list(z.object({
    name: z.string().min(1).max(40).regex(/^[a-z][A-Za-z0-9]*$/, 'an input name is one word'),
    fact: FactPath,
    maxAge: SettingKey.optional(),
    requireAuthority: z.enum(['source_of_truth', 'cross_check', 'fallback']).optional(),
  }).strict(), 20),
  formula: FormulaSchema,
  settings: list(SettingKey, 20),
  status: z.enum(['draft', 'active']),
  activatedBy: Line(80).optional(),
  activatedAt: Timestamp.optional(),
  wording: list(Line(300), 20),
}).strict().superRefine((signal, ctx) => {
  if (signal.status === 'active') {
    if (!signal.activatedBy) issue(ctx, ['activatedBy'], 'An active signal records who activated it.');
    if (!signal.activatedAt) issue(ctx, ['activatedAt'], 'An active signal records when it was activated.');
  }
  for (const operand of listOperandsOf(signal.formula)) {
    if (listOperandsOf(operand.where).length > 0) issue(ctx, ['formula'], `The test over '${operand.over}' holds a list of its own: a list holds no list.`);
  }
});

export const PartReplacementSchema = z.object({ thing: ThingName, with: ThingName }).strict();

export const JaxOntologyReleaseSchema = z.object({
  schemaVersion: z.literal(JAX_ONTOLOGY_SCHEMA_VERSION),
  ontologyId: Identifier,
  enabled: z.boolean(),
  selfConnector: ConnectorId,
  claimGuard: z.object({ figures: z.enum(['off', 'withhold']) }).strict().optional(),
  customerAccess: list(z.object({ thing: ThingName, facts: list(FactPath, 100), links: list(LinkName, 100), roles: list(Identifier, 50).optional() }).strict(), 200).optional(),
  customerIdentity: z.object({ thing: ThingName, keyKind: KeyKind }).strict().optional(),
  retailCustomerIdentity: z.object({ thing: ThingName, role: Identifier, selfAlias: Identifier }).strict().optional(),
  things: list(ThingDefSchema, 200),
  facts: list(FactDefSchema, 3000),
  links: list(LinkDefSchema, 600),
  bindings: list(BindingSchema, 5000),
  permissionRules: list(PermissionRuleSchema, 2000),
  signalRules: list(SignalRuleSchema, 500),
  settings: list(SettingDefSchema, 500),
  severities: list(Line(40), 20),
  stateMaps: list(StateMapSchema, 200),
  contractChanges: list(ContractChangeSchema, 2000),
  notes: z.string().max(2000).optional(),
}).strict();

export const DictionaryPartSchema = z.object({
  partId: Identifier,
  replaces: list(PartReplacementSchema, 20).optional(),
  things: list(ThingDefSchema, 200).optional(),
  facts: list(FactDefSchema, 3000).optional(),
  links: list(LinkDefSchema, 600).optional(),
  bindings: list(BindingSchema, 5000).optional(),
  permissionRules: list(PermissionRuleSchema, 2000).optional(),
  signalRules: list(SignalRuleSchema, 500).optional(),
  settings: list(SettingDefSchema, 500).optional(),
  severities: list(Line(40), 20).optional(),
  stateMaps: list(StateMapSchema, 200).optional(),
  contractChanges: list(ContractChangeSchema, 2000).optional(),
}).strict();
