import type { Binding, FactDef, FactPath, MeaningContract, StateMap } from '../model';
import { callFreshnessLimit, judgeFreshness, type FreshnessLimits } from '../freshness/limits';
import { parseIsoTime, valuesAgree, type FactCrossCheck } from './crosscheck';
import { applyStateMap, indexStateMaps } from './state-map';

/**
 * Turns the answers of the bound tools into one value per fact, each with its source and time.
 *
 * The `source_of_truth` binding supplies the value. A `cross_check` binding is kept apart, for `explain`. A `fallback` binding is read
 * only when the source of truth answered and had nothing recorded; if the source of truth failed, the fallback is ignored, so a failed
 * system never turns into another system's figure. A fact that cannot be given is `not_available` with a reason and the system named:
 * never zero, never blank, never a value from somewhere else. Notes never carry text taken from an answer.
 */

/** Why a system gave no answer for a binding. The caller sorts its error codes into these. */
export type AnswerFailureReason = 'source_failed' | 'source_rate_limited' | 'source_not_connected' | 'source_not_authorised' | 'record_not_in_source';

export type FactUnavailableReason = AnswerFailureReason | 'no_source' | 'not_recorded' | 'conflicting_sources' | 'state_not_mapped';

export interface AnswerFailure {
  reason: AnswerFailureReason;
  /** The error code behind it, for the audit. */
  code?: string;
  retryable: boolean;
  /** A plain sentence written by the caller. */
  note: string;
}

export interface FactUnavailable {
  reason: FactUnavailableReason;
  /** The connector that failed or has nothing recorded. */
  system?: string;
  code?: string;
  retryable: boolean;
  note: string;
}

/** What the answer says about the system it came from. `sample` is the pack's mark and is always kept (D32). */
export interface SystemLabel {
  displayName: string;
  sample: boolean;
}

/** The parts of a binding the merge reads. A full `Binding` fits. */
export type MergeBinding = Pick<Binding, 'bindingId' | 'target' | 'system' | 'tool' | 'args' | 'authority' | 'stateMap' | 'freshnessKind' | 'contract'>;

/** The parts of a fact the merge reads. A full `FactDef` fits. */
export type MergeFactDef = Pick<FactDef, 'fact' | 'type' | 'allowStale' | 'freshnessKind'>;

/**
 * What one binding gave for the subject, already cut to the allowed fields and shaped. `value` is what the binding's `select` found.
 * A cached copy carries `fromCache: true` and the time it was read. When a copy past its limit was read again and that failed, the
 * caller passes the old copy with `refetchFailure`. `atLeast` is a count that may be higher than the number seen.
 */
export type BindingResult =
  | { kind: 'value'; value: unknown; retrievedAt: string; sourceUpdatedAt?: string | null; fromCache: boolean; atLeast?: boolean; notes?: string[]; refetchFailure?: AnswerFailure }
  | { kind: 'not_recorded'; retrievedAt: string; fromCache: boolean; refetchFailure?: AnswerFailure }
  | { kind: 'failed'; failure: AnswerFailure };

export interface BoundAnswer {
  binding: MergeBinding;
  system: SystemLabel;
  result: BindingResult;
}

export interface FactSource {
  system: string;
  displayName: string;
  sample: boolean;
  tool: string;
  authority: Binding['authority'];
  /** The source's own last-updated time, written as an ISO 8601 instant in UTC; `null` when the tool gives none or gives text that is not a time. It is never filled in. */
  sourceUpdatedAt: string | null;
  retrievedAt: string;
  fromCache: boolean;
  /** `as_of`: the source's own time, used only when the binding's contract says to trust it and the tool gave one. `as_read_at`: when we read it. */
  asOf: { kind: 'as_of' | 'as_read_at'; at: string };
}

export interface MergedFact {
  fact: FactPath;
  status: 'ok' | 'stale' | 'not_available';
  /** Only for `ok` and `stale`. */
  value?: unknown;
  /** Only for `not_available`. */
  unavailable?: FactUnavailable;
  /** The first binding that supplied the value; present whenever a value is. */
  source?: FactSource;
  contract?: MeaningContract;
  /** Every binding the value is made from: one, or the parts of a count that were added. */
  bindingIds: string[];
  notes: string[];
  /** A count that may be higher than the number seen. */
  atLeast?: true;
  /** Set when the value went through a state map; the source's own word is kept for `explain`. */
  stateMap?: { id: string; lossy: boolean; sourceValue: unknown };
  /** Only for `stale`: why the value could not be read again. */
  staleBecause?: FactUnavailable;
  /** Only filled when cross-check answers were passed in, which is for `explain`. */
  crossChecks: FactCrossCheck[];
}

export interface MergeFactsInput {
  /** The facts to give back: those asked for and allowed. An answer for any other fact is dropped. */
  facts: readonly MergeFactDef[];
  answers: readonly BoundAnswer[];
  stateMaps: readonly StateMap[];
  limits: FreshnessLimits;
  now: Date;
}

const NOT_READ_AGAIN: AnswerFailure = {
  reason: 'source_failed',
  retryable: true,
  note: 'The stored value is past its freshness limit and was not read again.',
};

interface Context {
  maps: ReadonlyMap<string, StateMap>;
  limits: FreshnessLimits;
  now: Date;
}

interface SettledValue {
  kind: 'value';
  answer: BoundAnswer;
  value: unknown;
  source: FactSource;
  stale: boolean;
  staleBecause?: FactUnavailable;
  atLeast: boolean;
  notes: string[];
  stateMap?: MergedFact['stateMap'];
}
interface SettledNone { kind: 'none'; answer: BoundAnswer }
interface SettledFailed { kind: 'failed'; answer: BoundAnswer; unavailable: FactUnavailable }
type Settled = SettledValue | SettledNone | SettledFailed;

type Tier =
  | { kind: 'empty' }
  | { kind: 'none'; system: string; displayName: string }
  | { kind: 'failed'; unavailable: FactUnavailable }
  | { kind: 'conflict'; unavailable: FactUnavailable }
  | ValueTier;

interface ValueTier {
  kind: 'value';
  parts: SettledValue[];
  value: unknown;
  summed: boolean;
  atLeast: boolean;
  stale: boolean;
  staleBecause?: FactUnavailable;
}

const byBindingId = (a: BoundAnswer, b: BoundAnswer): number => (a.binding.bindingId < b.binding.bindingId ? -1 : a.binding.bindingId > b.binding.bindingId ? 1 : 0);

function unavailableFrom(answer: BoundAnswer, failure: AnswerFailure): FactUnavailable {
  const unavailable: FactUnavailable = { reason: failure.reason, system: answer.binding.system, retryable: failure.retryable, note: failure.note };
  if (failure.code !== undefined) unavailable.code = failure.code;
  return unavailable;
}

/** The source's time as one instant, or `null` when the tool gave none or gave text that is not an ISO 8601 time. */
const validTime = (value: unknown): string | null => parseIsoTime(value)?.text ?? null;

function settle(answer: BoundAnswer, fact: MergeFactDef, ctx: Context): Settled {
  const { binding, result } = answer;
  if (result.kind === 'failed') return { kind: 'failed', answer, unavailable: unavailableFrom(answer, result.failure) };
  const verdict = judgeFreshness({
    fromCache: result.fromCache,
    retrievedAt: result.retrievedAt,
    // The fact and the binding each name a kind of freshness and the value must meet both: the shorter limit applies, and no limit on either side is no limit.
    limitMs: callFreshnessLimit([ctx.limits.millisecondsFor(fact.freshnessKind), ctx.limits.millisecondsFor(binding.freshnessKind)]),
    now: ctx.now,
    allowStale: fact.allowStale && result.kind === 'value',
    refetchFailed: result.refetchFailure !== undefined,
  });
  if (verdict === 'refused') return { kind: 'failed', answer, unavailable: unavailableFrom(answer, result.refetchFailure ?? NOT_READ_AGAIN) };
  if (result.kind === 'not_recorded' || result.value === undefined || result.value === null) return { kind: 'none', answer };

  let value = result.value;
  let stateMap: MergedFact['stateMap'];
  const notes = [...(result.notes ?? [])];
  if (binding.stateMap !== undefined) {
    const map = ctx.maps.get(binding.stateMap);
    const converted = map ? applyStateMap(map, result.value) : undefined;
    if (!map || !converted || converted.ok === false) {
      const note = converted && converted.ok === false ? converted.note : `State map '${binding.stateMap}' is not declared exactly once in this release.`;
      return { kind: 'failed', answer, unavailable: { reason: 'state_not_mapped', system: binding.system, retryable: false, note } };
    }
    value = converted.to;
    stateMap = { id: map.id, lossy: converted.lossy, sourceValue: result.value };
    if (converted.lossy) notes.push(`Converted through state map '${map.id}', which loses detail.`);
  }

  const sourceUpdatedAt = validTime(result.sourceUpdatedAt);
  const source: FactSource = {
    system: binding.system,
    displayName: answer.system.displayName,
    sample: answer.system.sample,
    tool: binding.tool,
    authority: binding.authority,
    sourceUpdatedAt,
    retrievedAt: result.retrievedAt,
    fromCache: result.fromCache,
    asOf: sourceUpdatedAt !== null && binding.contract.asOf === 'source_updated'
      ? { kind: 'as_of', at: sourceUpdatedAt }
      : { kind: 'as_read_at', at: result.retrievedAt },
  };
  const stale = verdict === 'stale';
  if (stale) notes.push('Older than the freshness limit, and the system could not be read again.');
  const settled: SettledValue = { kind: 'value', answer, value, source, stale, atLeast: result.atLeast === true, notes };
  if (stale && result.refetchFailure) settled.staleBecause = unavailableFrom(answer, result.refetchFailure);
  if (stateMap) settled.stateMap = stateMap;
  return settled;
}

function valueTier(parts: SettledValue[], value: unknown, summed: boolean): ValueTier {
  const tier: ValueTier = { kind: 'value', parts, value, summed, atLeast: parts.some((part) => part.atLeast), stale: parts.some((part) => part.stale) };
  const late = parts.find((part) => part.staleBecause);
  if (late?.staleBecause) tier.staleBecause = late.staleBecause;
  return tier;
}

/**
 * One level of authority: usually one answer. Several answers for one fact are accepted in two cases only. They are the parts of a
 * count, when they come from the same tool of the same system with different arguments (one call per status): then they are added, and
 * each part must be a whole count or the fact is a conflict. Or they all give the same value. Anything else is a conflict, because the
 * merge never picks between two sources of truth.
 */
function reduceTier(parts: Settled[], fact: MergeFactDef): Tier {
  if (parts.length === 0) return { kind: 'empty' };
  const failed = parts.find((part): part is SettledFailed => part.kind === 'failed');
  if (failed) return { kind: 'failed', unavailable: failed.unavailable };
  const values = parts.filter((part): part is SettledValue => part.kind === 'value');
  const empty = parts.find((part): part is SettledNone => part.kind === 'none');
  const [first] = values;
  if (!first && empty) return { kind: 'none', system: empty.answer.binding.system, displayName: empty.answer.system.displayName };
  if (parts.length === 1) return valueTier(values, first.value, false);

  const conflict: Tier = {
    kind: 'conflict',
    unavailable: { reason: 'conflicting_sources', retryable: false, note: 'More than one source of truth is bound to this fact and they do not give one value.' },
  };
  const [lead] = parts;
  const sameCall = parts.every((part) => part.answer.binding.system === lead.answer.binding.system && part.answer.binding.tool === lead.answer.binding.tool);
  const distinctArguments = parts.every((part, i) => parts.every((other, j) => i === j || !valuesAgree(undefined, part.answer.binding.args, other.answer.binding.args)));
  const partsOfCount = fact.type === 'number' && sameCall && distinctArguments;
  // A value beside a part with nothing recorded: half a count is no count, and a value and a blank are not one value.
  if (empty) return partsOfCount ? { kind: 'none', system: empty.answer.binding.system, displayName: empty.answer.system.displayName } : conflict;
  if (partsOfCount) {
    // Parts are added or the fact is a conflict. Equal parts are never read as one value: that would show half of the total.
    if (!values.every((part) => typeof part.value === 'number' && Number.isSafeInteger(part.value))) return conflict;
    const total = values.reduce((sum, part) => sum + (part.value as number), 0);
    return Number.isSafeInteger(total) ? valueTier(values, total, true) : conflict;
  }
  return values.every((part) => valuesAgree(fact.type, first.value, part.value)) ? valueTier(values, first.value, false) : conflict;
}

function crossCheckOf(settled: Settled, fact: MergeFactDef, supplied: ValueTier | undefined): FactCrossCheck {
  const { binding, system } = settled.answer;
  const entry: FactCrossCheck = { bindingId: binding.bindingId, system: binding.system, displayName: system.displayName, sample: system.sample, tool: binding.tool, agrees: null };
  if (settled.kind === 'failed') entry.unavailable = settled.unavailable;
  if (settled.kind === 'value') {
    entry.source = settled.source;
    entry.value = settled.value;
    entry.agrees = supplied ? valuesAgree(fact.type, supplied.value, settled.value) : null;
  }
  return entry;
}

function unavailableFact(fact: MergeFactDef, unavailable: FactUnavailable, crossChecks: FactCrossCheck[]): MergedFact {
  return { fact: fact.fact, status: 'not_available', unavailable, bindingIds: [], notes: [], crossChecks };
}

function valueFact(fact: MergeFactDef, tier: ValueTier, extraNotes: string[], crossChecks: FactCrossCheck[]): MergedFact {
  const [first] = tier.parts;
  const notes = [...extraNotes];
  if (tier.summed) notes.push(`Added together from ${tier.parts.length} answers.`);
  for (const part of tier.parts) for (const note of part.notes) if (!notes.includes(note)) notes.push(note);
  const merged: MergedFact = {
    fact: fact.fact,
    status: tier.stale ? 'stale' : 'ok',
    value: tier.value,
    source: first.source,
    contract: first.answer.binding.contract,
    bindingIds: tier.parts.map((part) => part.answer.binding.bindingId),
    notes,
    crossChecks,
  };
  if (tier.atLeast) merged.atLeast = true;
  if (first.stateMap) merged.stateMap = first.stateMap;
  if (tier.staleBecause) merged.staleBecause = tier.staleBecause;
  return merged;
}

function mergeOne(fact: MergeFactDef, answers: readonly BoundAnswer[], ctx: Context): MergedFact {
  const settled = [...answers].sort(byBindingId).map((answer) => settle(answer, fact, ctx));
  const ofAuthority = (authority: Binding['authority']) => settled.filter((part) => part.answer.binding.authority === authority);
  const primary = reduceTier(ofAuthority('source_of_truth'), fact);
  const finish = (supplied: ValueTier | undefined, build: (crossChecks: FactCrossCheck[]) => MergedFact): MergedFact =>
    build(ofAuthority('cross_check').map((part) => crossCheckOf(part, fact, supplied)));

  if (primary.kind === 'value') return finish(primary, (crossChecks) => valueFact(fact, primary, [], crossChecks));
  if (primary.kind === 'failed' || primary.kind === 'conflict') return finish(undefined, (crossChecks) => unavailableFact(fact, primary.unavailable, crossChecks));
  if (primary.kind === 'empty') {
    const unavailable: FactUnavailable = { reason: 'no_source', retryable: false, note: 'No source of truth is bound to this fact.' };
    return finish(undefined, (crossChecks) => unavailableFact(fact, unavailable, crossChecks));
  }

  // The source of truth answered and has nothing recorded: only now may a fallback binding supply the value.
  const fallback = reduceTier(ofAuthority('fallback'), fact);
  if (fallback.kind === 'value') {
    const note = `Taken from ${fallback.parts[0].source.displayName} because ${primary.displayName} has nothing recorded.`;
    return finish(fallback, (crossChecks) => valueFact(fact, fallback, [note], crossChecks));
  }
  if (fallback.kind === 'failed' || fallback.kind === 'conflict') return finish(undefined, (crossChecks) => unavailableFact(fact, fallback.unavailable, crossChecks));
  const unavailable: FactUnavailable = { reason: 'not_recorded', system: primary.system, retryable: false, note: 'The system answered and has nothing recorded for this.' };
  return finish(undefined, (crossChecks) => unavailableFact(fact, unavailable, crossChecks));
}

/** One merged fact for each fact asked for, in the order asked. Pure: the same input gives the same output, whatever order the answers arrive in. */
export function mergeFacts(input: MergeFactsInput): MergedFact[] {
  const ctx: Context = { maps: indexStateMaps(input.stateMaps), limits: input.limits, now: input.now };
  const byFact = new Map<FactPath, BoundAnswer[]>();
  for (const answer of input.answers) {
    const { target } = answer.binding;
    if (target.kind !== 'fact') continue;
    const list = byFact.get(target.fact) ?? [];
    list.push(answer);
    byFact.set(target.fact, list);
  }
  return input.facts.map((fact) => mergeOne(fact, byFact.get(fact.fact) ?? [], ctx));
}
