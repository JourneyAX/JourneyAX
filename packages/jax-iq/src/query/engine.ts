import { sourceIdentityKeys } from './source-identity';
import { connectorToolState } from '@journeyax/business-pack';
import { buildDictionaryIndex } from '../dictionary';
import { buildFreshnessLimits } from '../freshness';
import { resolveSubject, type KeyRepository, type KeyRow } from '../keys';
import { mergeFacts, type BoundAnswer, type BindingResult } from '../merge';
import { JaxOntologyReleaseSchema, type Binding, type FactDef, type JaxOntologyRelease } from '../model';
import { planBindingArguments, relationshipPath } from '../plan';
import { isReleaseFailure, type ConnectorOutcome, type LoadedRelease, type ReleaseSource } from '../ports';
import { allowedFacts, compileRules, toolStatesFor } from '../rules';
import { readIqPath } from '../shape';
import { normaliseKeyValue } from '../keys/normalise';
import { IqQuerySchema, type IqContext, type IqQuery, type IqRecord, type IqResponse } from './contracts';

export interface IqReadPort {
  read(call: { context: IqContext; system: string; tool: string; args: Record<string, unknown>; fields: string[]; signal: AbortSignal }, release: LoadedRelease): Promise<ConnectorOutcome>;
}
export interface IqEngineDeps {
  releases: ReleaseSource;
  keys: Pick<KeyRepository, 'findBySystemKey' | 'findByCanonicalId'>;
  reader: IqReadPort;
  clock?: () => Date;
  /** Service transport safety ceilings, not business thresholds. Tenant settings may only reduce them. */
  maxQueryMs?: number;
  maxRows?: number;
  maxSourceCalls?: number;
}

const no = (ctx: IqContext, code: string): IqResponse => ({ ok: false, code, queryId: ctx.queryId });
const valueFits = (fact: FactDef, value: unknown): boolean => {
  if (fact.type === 'number' || fact.type === 'percent') return typeof value === 'number' && Number.isFinite(value);
  if (fact.type === 'boolean') return typeof value === 'boolean';
  if (fact.type === 'enum') return typeof value === 'string' && !!fact.enumValues?.includes(value);
  if (fact.type === 'money') return typeof value === 'number' && Number.isFinite(value);
  if (fact.type === 'list') return Array.isArray(value);
  if (fact.type === 'datetime' || fact.type === 'date') return typeof value === 'string' && Number.isFinite(Date.parse(value));
  return typeof value === 'string';
};

/** Shared bounded read orchestration. It performs no writes and never chooses a customer conversation path. */
export class IqQueryEngine {
  constructor(private readonly deps: IqEngineDeps) {
    if (deps.maxSourceCalls !== undefined && (!Number.isSafeInteger(deps.maxSourceCalls) || deps.maxSourceCalls < 0 || deps.maxSourceCalls > 64)) throw new Error('IQ source-call ceiling must be an integer between zero and 64.');
  }

  async query(raw: unknown, ctx: IqContext, signal?: AbortSignal): Promise<IqResponse> {
    const parsed = IqQuerySchema.safeParse(raw);
    if (!parsed.success) return no(ctx, 'invalid_request');
    if (!ctx.principal?.id || ctx.principal.id === 'anonymous') return no(ctx, 'principal_missing');
    if (!['staff', 'shopper'].includes(ctx.principal.audience)) return no(ctx, 'refused_by_rule');
    const request = parsed.data;
    const loaded = await this.deps.releases.load(ctx.tenantId, ctx.environmentId, ctx.release);
    if (isReleaseFailure(loaded)) return no(ctx, loaded.code);
    if (loaded.version !== ctx.release.version || loaded.checksum !== ctx.release.checksum) return no(ctx, 'release_mismatch');
    const checked = JaxOntologyReleaseSchema.safeParse(loaded.ontology);
    if (!checked.success || !checked.data.enabled) return no(ctx, 'not_configured');
    const block = checked.data as JaxOntologyRelease;
    if (ctx.disabledConnectors?.includes(block.selfConnector)) return no(ctx, 'refused_by_rule');
    const keysRepo = sourceIdentityKeys(this.deps.keys, block, ctx, () => this.now());
    const index = buildDictionaryIndex(block);
    const rules = compileRules(block);
    const states = toolStatesFor(loaded.connectors, rules.caps, ctx.principal);
    const staffFacts = allowedFacts(block, ctx.principal, states, rules);
    const customerRules = (thing: string, role?: string) => (block.customerAccess ?? []).filter(entry => entry.thing === thing && (!entry.roles?.length || (!!role && entry.roles.includes(role))));
    const authorisedSubjects = [...ctx.principal.subjects];
    for (const identity of ctx.principal.identities ?? []) {
      const thing = index.thing(identity.thing);
      if (!thing || block.customerIdentity?.thing !== identity.thing || block.customerIdentity?.keyKind !== identity.keyKind) continue;
      const resolved = await resolveSubject({ repository: keysRepo, scope: { tenantId: ctx.tenantId, environmentId: ctx.environmentId, thing: thing.thing }, kinds: thing.keyKinds.map(kind => ({ ...kind, use: kind.kind === thing.key.canonical ? 'number' : 'own_id' })) }, { by: 'key', keyKind: identity.keyKind, value: identity.value });
      if (resolved.outcome === 'one' && resolved.canonicalId) authorisedSubjects.push({ thing: thing.thing, canonicalId: resolved.canonicalId, role: identity.role });
    }
    const owns = (subject: { thing: string; canonicalId: string }) => authorisedSubjects.some(entry => entry.thing === subject.thing && entry.canonicalId === subject.canonicalId);
    const permitted = (thing: string, role?: string) => ctx.principal.audience === 'staff' ? staffFacts : new Set(customerRules(thing, role).flatMap(entry => entry.facts));
    const toolAllowed = (system: string, tool: string) => {
      if (ctx.disabledConnectors?.includes(system)) return false;
      const connector = loaded.connectors.connectors.find(entry => entry.connectorId === system && entry.enabled !== false);
      const listed = connector?.tools.find(entry => entry.name === tool);
      return !!connector && listed?.sideEffect === 'read' && system !== block.selfConnector &&
        (ctx.principal.audience === 'staff' ? states(system, tool) : connectorToolState(loaded.connectors, system, tool, { audience: 'shopper', groups: [] }).state) === 'allow';
    };
    const setting = index.setting('timeout.query');
    const configuredMs = setting?.value == null ? undefined : setting.value * (setting.unit === 'seconds' ? 1000 : setting.unit === 'milliseconds' ? 1 : 0);
    const queryMs = Math.min(this.deps.maxQueryMs ?? 30_000, configuredMs && configuredMs > 0 ? configuredMs : Infinity);
    const deadline = AbortSignal.timeout(queryMs);
    const abort = signal ? AbortSignal.any([deadline, signal]) : deadline;
    const maxRows = this.deps.maxRows ?? 50;
    const configuredCalls = index.setting('limit.sourceCalls');
    if (configuredCalls && (configuredCalls.kind !== 'limit' || configuredCalls.unit !== 'count' || (configuredCalls.value !== null && (!Number.isSafeInteger(configuredCalls.value) || configuredCalls.value < 0)))) return no(ctx, 'not_configured');
    const maxSourceCalls = Math.min(this.deps.maxSourceCalls ?? 16, configuredCalls?.value ?? Infinity);
    let budgetExceeded = false;
    let sourceReadFailed = false;
    const sources = new Map<string, { system: string; sample: boolean; truncated: boolean }>();
    const pages = new Map<string, { bindingId: string; subject: IqRecord['subject']; cursorParam: string; more: boolean; nextCursor?: string }>();
    let invalidSourcePage = false;
    const pageFields = (binding: Binding) => [binding.page?.morePath, binding.page?.nextCursorPath].filter((value): value is string => !!value);
    const notePage = (binding: Binding, result: ConnectorOutcome, subject: IqRecord['subject']) => {
      if (!result.ok || !binding.page?.morePath || !binding.page.nextCursorPath || !binding.page.cursorParam) return;
      const more = readIqPath(result.data, binding.page.morePath);
      const cursor = readIqPath(result.data, binding.page.nextCursorPath);
      if (typeof more !== 'boolean' || more && (typeof cursor !== 'string' || !cursor || cursor.length > 1000 || /[\u0000-\u001f\u007f]/.test(cursor))) { invalidSourcePage = true; return; }
      pages.set(JSON.stringify([binding.bindingId, subject.thing, subject.canonicalId]), { bindingId: binding.bindingId, subject, cursorParam: binding.page.cursorParam, more, ...(more ? { nextCursor: cursor as string } : {}) });
    };
    const calls = new Map<string, Promise<ConnectorOutcome>>();
    const read = (system: string, tool: string, args: Record<string, unknown>, fields: string[]): Promise<ConnectorOutcome> => {
      if (!toolAllowed(system, tool)) return Promise.resolve({ ok: false, kind: 'not_read_only', message: 'Source read is not allowed.' });
      const identity = JSON.stringify([system, tool, Object.entries(args).sort(([a], [b]) => a.localeCompare(b)), [...new Set(fields)].sort()]);
      const existing = calls.get(identity);
      if (existing) return existing;
      if (calls.size >= maxSourceCalls) {
        budgetExceeded = true;
        return Promise.resolve({ ok: false, kind: 'tool_error', code: 'source_budget_exceeded', message: 'The query source-call budget is exhausted.' });
      }
      const promise = (async (): Promise<ConnectorOutcome> => {
        if (abort.aborted) return { ok: false, kind: 'timeout', message: 'Query deadline exceeded.' };
        let removeAbort = () => {};
        try {
          const cancelled = new Promise<ConnectorOutcome>(resolve => {
            const onAbort = () => resolve({ ok: false, kind: 'timeout', message: 'Query deadline exceeded.' });
            abort.addEventListener('abort', onAbort, { once: true });
            removeAbort = () => abort.removeEventListener('abort', onAbort);
          });
          const result = await Promise.race([this.deps.reader.read({ context: ctx, system, tool, args, fields, signal: abort }, loaded), cancelled]);
          const connector = loaded.connectors.connectors.find(entry => entry.connectorId === system)!;
          const previous = sources.get(system);
          sources.set(system, { system, sample: (connector as any).sample === true, truncated: previous?.truncated === true || (result.ok && (result.truncated || result.incomplete === true)) });
          if (!result.ok) sourceReadFailed = true;
          return result;
        } catch {
          sourceReadFailed = true;
          return { ok: false, kind: 'transport', message: 'Source read failed.' };
        } finally { removeAbort(); }
      })();
      calls.set(identity, promise);
      return promise;
    };
    const keysFor = async (thing: string, canonicalId: string): Promise<KeyRow[]> =>
      (await keysRepo.findByCanonicalId({ tenantId: ctx.tenantId, environmentId: ctx.environmentId, thing }, canonicalId))
        .filter(row => row.tenantId === ctx.tenantId && row.environmentId === ctx.environmentId && row.thing === thing && row.canonicalId === canonicalId && row.status === 'matched');
    const identityMatches = (binding: Binding, data: unknown, thingName: string, keys: KeyRow[]): boolean => {
      if (!binding.identity) return true;
      const identity = binding.identity;
      const keyKind = index.thing(thingName)?.keyKinds.find(kind => kind.system === binding.system && kind.kind === identity.keyKind && kind.ready);
      const received = readIqPath(data, identity.select);
      const value = typeof received === 'string' ? received : Number.isSafeInteger(received) ? String(received) : undefined;
      const normalised = keyKind && value !== undefined ? normaliseKeyValue(value, keyKind) : undefined;
      const expected = [...new Set(keys.filter(key => key.system === binding.system && key.keyKind === identity.keyKind && key.status === 'matched').map(key => key.systemKey))];
      return Boolean(normalised?.ok && expected.length === 1 && normalised.value === expected[0]);
    };

    const rowFacts = new Map<string, BoundAnswer[]>();
    const conflictingRows = new Set<string>();
    const subjectKey = (subject: IqRecord['subject']) => JSON.stringify([subject.thing, subject.canonicalId]);

    const getRecord = async (subject: IqRecord['subject'], requested?: string[], filters: Record<string, unknown> = {}, role?: string): Promise<IqRecord | undefined> => {
      const thing = index.thing(subject.thing);
      if (!thing) return undefined;
      const fields = requested ?? thing.defaultFacts;
      if (fields.some(path => index.factByPath(path)?.thing !== subject.thing)) return undefined;
      const facts = fields.filter(path => permitted(subject.thing, role).has(path)).map(path => index.factByPath(path)!);
      if (facts.length === 0) return undefined;
      const keys = await keysFor(subject.thing, subject.canonicalId);
      if (!keys.length) return undefined;
      const requestedFacts = new Set(facts.map(fact => fact.fact));
      const answers: BoundAnswer[] = (rowFacts.get(subjectKey(subject)) ?? []).filter(answer => answer.binding.target.kind === 'fact' && requestedFacts.has(answer.binding.target.fact));
      // Group bindings before execution: one record fetch supplies several allowed facts.
      type Group = { system: string; tool: string; args: Record<string, unknown>; bindings: Binding[] };
      const groups = new Map<string, Group>();
      const add = (binding: Binding, into: Map<string, Group>) => {
        if (!toolAllowed(binding.system, binding.tool)) return;
        const args = planBindingArguments(binding, keys, filters, ctx.principal);
        if (!args) return;
        const identity = JSON.stringify([binding.system, binding.tool, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))]);
        const group = into.get(identity) ?? { system: binding.system, tool: binding.tool, args, bindings: [] };
        group.bindings.push(binding); into.set(identity, group);
      };
      for (const fact of facts) {
        if (answers.some(answer => answer.binding.target.kind === 'fact' && answer.binding.target.fact === fact.fact && answer.result.kind === 'value')) continue;
        for (const binding of index.bindingsForFact(fact.fact)) if (binding.authority !== 'fallback') add(binding, groups);
      }
      // Bounded waves, independent reads overlap. There is no sequential model-mediated source selection here.
      const configuredParallel = index.setting('limit.parallelPerSystem')?.value;
      const parallel = configuredParallel != null && Number.isSafeInteger(configuredParallel) && configuredParallel > 0 ? Math.min(4, configuredParallel) : 4;
      const runGroups = async (pending: Group[]) => {
      for (let offset = 0; offset < pending.length; offset += parallel) await Promise.all(pending.slice(offset, offset + parallel).map(async group => {
        const result = await read(group.system, group.tool, group.args, group.bindings.flatMap(binding => [binding.select, ...(binding.identity ? [binding.identity.select] : []), ...(binding.currencyFrom ? [binding.currencyFrom] : []), ...pageFields(binding)]));
        const connector = loaded.connectors.connectors.find(entry => entry.connectorId === group.system)!;
        for (const binding of group.bindings) {
          let shaped: BindingResult;
          if (result.ok === false) shaped = { kind: 'failed', failure: { reason: result.kind === 'not_configured' ? 'source_not_connected' : 'source_failed', retryable: result.kind === 'timeout' || result.kind === 'transport', note: 'The source could not supply this fact.' } };
          else {
            if (!identityMatches(binding, result.data, thing.thing, keys)) {
                answers.push({ binding, system: { displayName: connector.displayName, sample: (connector as any).sample === true }, result: { kind: 'failed', failure: { reason: 'source_failed', code: 'source_identity_mismatch', retryable: false, note: 'The returned record did not confirm the exact requested source identity.' } } });
                continue;
            }
            notePage(binding, result, subject);
            const value = readIqPath(result.data, binding.select);
            const fact = index.factByPath((binding.target as { fact: string }).fact)!;
            if (value === undefined || value === null) shaped = binding.presence === 'optional'
              ? { kind: 'not_recorded', retrievedAt: this.now().toISOString(), fromCache: false }
              : { kind: 'failed', failure: { reason: 'source_failed', code: 'source_shape_mismatch', retryable: false, note: 'The source omitted a required field.' } };
            else if (!valueFits(fact, value) || result.truncated) shaped = { kind: 'failed', failure: { reason: 'source_failed', code: result.truncated ? 'source_truncated' : 'source_shape_mismatch', retryable: false, note: 'The source answer could not be verified.' } };
            else {
              const currency = binding.currencyFrom ? readIqPath(result.data, binding.currencyFrom) : undefined;
              const contract = binding.contract.currency === 'from_record' ? { ...binding.contract, currency: typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'unknown' } : binding.contract;
              shaped = { kind: 'value', value, retrievedAt: this.now().toISOString(), fromCache: false };
              answers.push({ binding: { ...binding, contract }, system: { displayName: connector.displayName, sample: (connector as any).sample === true }, result: shaped });
              continue;
            }
          }
          answers.push({ binding, system: { displayName: connector.displayName, sample: (connector as any).sample === true }, result: shaped });
        }
      }));
      };
      await runGroups([...groups.values()]);
      // A failure never authorises a fallback. Read it only after every primary explicitly answered "not recorded".
      const fallbacks = new Map<string, Group>();
      for (const fact of facts) {
        const primaries = index.bindingsForFact(fact.fact).filter(binding => binding.authority === 'source_of_truth');
        if (primaries.length && primaries.every(binding => answers.some(answer => answer.binding.bindingId === binding.bindingId && answer.result.kind === 'not_recorded'))) {
          for (const binding of index.bindingsForFact(fact.fact)) if (binding.authority === 'fallback') add(binding, fallbacks);
        }
      }
      await runGroups([...fallbacks.values()]);
      return { subject, facts: mergeFacts({ facts, answers, stateMaps: block.stateMaps, limits: buildFreshnessLimits(block.settings), now: this.now() }) };
    };
    const answer = (records: IqRecord[], status?: 'complete' | 'partial' | 'ambiguous' | 'no_match', candidates?: unknown[]): IqResponse => invalidSourcePage ? no(ctx, 'source_page_invalid') : budgetExceeded ? no(ctx, 'source_budget_exceeded') : sourceReadFailed && !records.length ? no(ctx, 'source_unavailable') : ({
      ok: true, queryId: ctx.queryId, release: ctx.release,
      status: status === 'ambiguous' ? status : [...sources.values()].some(source => source.truncated) || [...pages.values()].some(page => page.more) ? 'partial' : status ?? (records.some(record => record.facts.some(fact => fact.status !== 'ok')) ? 'partial' : 'complete'),
      records, ...(candidates ? { candidates } : {}), ...(pages.size ? { pages: [...pages.values()] } : {}), sources: [...sources.values()], untrustedText: true,
    });

    try {
      if (request.operation === 'find') {
        const thing = index.thing(request.thing);
        if (!thing) return no(ctx, 'invalid_request');
        if (ctx.principal.audience === 'staff' && !permitted(thing.thing).has(thing.labelFact)) return no(ctx, 'refused_by_rule');
        if (ctx.principal.audience === 'shopper') {
          const records: IqRecord[] = [];
          for (const subject of authorisedSubjects.filter(item => item.thing === thing.thing).slice(0, maxRows)) {
            const record = await getRecord(subject, [thing.labelFact], {}, subject.role);
            if (record && record.facts.some(fact => fact.status === 'ok' && String(fact.value).toLocaleLowerCase().includes(request.query.toLocaleLowerCase()))) records.push(record);
          }
          return answer(records, records.length ? 'complete' : 'no_match');
        }
        // An explicitly declared native record ID is an exact source lookup,
        // not a company-name search or a guessed cross-system association.
        const nativeId = request.query.trim();
        const registered = (await this.deps.keys.findByCanonicalId({ tenantId: ctx.tenantId, environmentId: ctx.environmentId, thing: thing.thing }, nativeId)).filter(row => row.tenantId === ctx.tenantId && row.environmentId === ctx.environmentId && row.thing === thing.thing && row.canonicalId === nativeId);
        if (registered.length) {
          if (registered.some(row => row.status === 'conflict')) return answer([], 'ambiguous');
          if (!registered.some(row => row.status === 'matched' && row.role === 'primary')) return answer([], 'no_match');
          const record = await getRecord({ thing: thing.thing, canonicalId: nativeId }, [thing.labelFact]);
          return answer(record ? [record] : [], record?.facts.some(fact => fact.status === 'ok') ? 'complete' : 'partial');
        }
        // A known vendor ID can identify a canonical subject only through stored, scoped evidence.
        // Do not treat that ID as a name or silently pick between the same key in different systems.
        const exactKeys = (await Promise.all(thing.keyKinds.filter(kind => kind.ready && kind.evidence !== 'name_only').map(async kind => {
          const normalised = normaliseKeyValue(nativeId, kind);
          if (!normalised.ok) return undefined;
          const row = await this.deps.keys.findBySystemKey({ tenantId: ctx.tenantId, environmentId: ctx.environmentId, thing: thing.thing }, kind.system, kind.kind, normalised.value);
          return row && row.tenantId === ctx.tenantId && row.environmentId === ctx.environmentId && row.thing === thing.thing && row.system === kind.system && row.keyKind === kind.kind && row.systemKey === normalised.value ? row : undefined;
        }))).filter((row): row is KeyRow => row !== undefined);
        if (exactKeys.some(row => row.status === 'conflict')) return answer([], 'ambiguous');
        const canonicalIds = [...new Set(exactKeys.filter(row => row.status === 'matched').map(row => row.canonicalId))];
        if (canonicalIds.length > 1) return answer([], 'ambiguous');
        if (canonicalIds.length === 1) {
          const record = await getRecord({ thing: thing.thing, canonicalId: canonicalIds[0] }, [thing.labelFact]);
          return answer(record ? [record] : [], record?.facts.some(fact => fact.status === 'ok') ? 'complete' : 'partial');
        }
        if (thing.sourceIdentity && new RegExp(thing.key.pattern).test(nativeId)) {
          const record = await getRecord({ thing: thing.thing, canonicalId: nativeId }, [thing.labelFact]);
          return answer(record ? [record] : [], record?.facts.some(fact => fact.status === 'ok') ? 'complete' : 'partial');
        }
        const searches = await Promise.all((thing.lookups ?? []).map(async lookup => {
          const result = await read(lookup.system, lookup.tool, { [lookup.queryArg]: request.query }, [lookup.rows]);
          const rows = result.ok ? readIqPath(result.data, lookup.rows) : undefined;
          return { system: lookup.system, answered: result.ok && Array.isArray(rows), cut: result.ok && (result.truncated || result.incomplete === true || (Array.isArray(rows) && rows.length > maxRows)), hits: Array.isArray(rows) ? rows.slice(0, maxRows).flatMap(row => {
            const rawKey = readIqPath(row, lookup.keyField), label = readIqPath(row, lookup.labelField);
            const key = typeof rawKey === 'string' ? rawKey : Number.isSafeInteger(rawKey) ? String(rawKey) : undefined;
            return typeof key === 'string' && typeof label === 'string' ? [{ keyKind: lookup.keyKind, systemKey: key, name: label }] : [];
          }) : [] };
        }));
        const resolved = await resolveSubject({ repository: keysRepo, scope: { tenantId: ctx.tenantId, environmentId: ctx.environmentId, thing: thing.thing }, kinds: thing.keyKinds.map(kind => ({ ...kind, use: kind.kind === thing.key.canonical ? 'number' : 'own_id' })) }, { by: 'name', words: request.query, expectedIn: thing.expectedIn, answers: searches });
        const records: IqRecord[] = [];
        // Candidate identity is not selection: no facts beyond the permitted label are exposed before disambiguation.
        for (const candidate of resolved.candidates.slice(0, maxRows)) if (candidate.canonicalId && candidate.status === 'matched') {
          const record = await getRecord({ thing: thing.thing, canonicalId: candidate.canonicalId }, [thing.labelFact]);
          if (record) records.push(record);
        }
        return answer(records, resolved.outcome === 'one' ? 'complete' : resolved.outcome === 'several' ? 'ambiguous' : 'no_match', resolved.candidates.map(candidate => ({ canonicalId: candidate.canonicalId, status: candidate.status })));
      }
      let subject: IqRecord['subject'];
      if ('canonicalId' in request.subject) subject = request.subject;
      else {
        const thing = index.thing(request.subject.thing);
        if (!thing) return no(ctx, 'invalid_request');
        const resolved = await resolveSubject({ repository: keysRepo, scope: { tenantId: ctx.tenantId, environmentId: ctx.environmentId, thing: thing.thing }, kinds: thing.keyKinds.map(kind => ({ ...kind, use: kind.kind === thing.key.canonical ? 'number' : 'own_id' })) }, { by: 'key', keyKind: request.subject.key.kind, value: request.subject.key.value });
        if (resolved.outcome !== 'one' || !resolved.canonicalId) return no(ctx, resolved.outcome === 'several' ? 'ambiguous' : 'no_match');
        subject = { thing: thing.thing, canonicalId: resolved.canonicalId };
      }
      if (ctx.principal.audience === 'shopper' && !owns(subject)) return no(ctx, 'refused_by_rule');
      const customerRole = authorisedSubjects.find(entry => entry.thing === subject.thing && entry.canonicalId === subject.canonicalId)?.role;
      if (request.operation !== 'related') {
        const record = await getRecord(subject, request.facts, request.operation === 'get' ? request.filters : {}, customerRole);
        return record ? answer([record]) : no(ctx, 'refused_by_rule');
      }
      const link = index.link(request.link);
      if (!link || link.from !== subject.thing) return no(ctx, 'invalid_request');
      const path = relationshipPath(block.links, link.link);
      if (!path?.length) return no(ctx, 'invalid_request');
      if (ctx.principal.audience === 'shopper' && !customerRules(link.from, customerRole).some(rule => rule.links.includes(link.link))) return no(ctx, 'refused_by_rule');
      if (!permitted(link.from, customerRole).size || !permitted(link.to, customerRole).size) return no(ctx, 'refused_by_rule');
      let partial = false;
      let parents = [subject];
      for (const hop of path) {
        if (ctx.principal.audience === 'shopper' && !customerRules(hop.from, customerRole).some(rule => rule.links.includes(hop.link))) return no(ctx, 'refused_by_rule');
        if (!permitted(hop.from, customerRole).size || !permitted(hop.to, customerRole).size) return no(ctx, 'refused_by_rule');
        const target = index.thing(hop.to);
        if (!target) return no(ctx, 'invalid_request');
        const bindings = index.bindingsForLink(hop.link).filter(binding => binding.authority === 'source_of_truth');
        if (!bindings.length) return no(ctx, 'not_configured');
        const childIds = new Set<string>();
        for (const parent of parents) {
          const keys = await keysFor(hop.from, parent.canonicalId);
          if (!keys.length) { partial = true; continue; }
          // Only a scoped source-of-truth relationship can introduce a child.
          for (const binding of bindings) {
            if (ctx.principal.audience === 'shopper' && !Object.values(binding.args).some(arg => arg.from === 'key' || arg.from === 'principal')) return no(ctx, 'refused_by_rule');
            if (!binding.rows) { partial = true; continue; }
            const args = planBindingArguments(binding, keys, request.filters, ctx.principal);
            if (!args) { partial = true; continue; }
            const result = await read(binding.system, binding.tool, args, [binding.rows.path, ...(binding.identity ? [binding.identity.select] : []), ...pageFields(binding)]);
            if (result.ok && !identityMatches(binding, result.data, hop.from, keys)) { sourceReadFailed = true; partial = true; continue; }
            notePage(binding, result, parent);
            const rows = result.ok ? readIqPath(result.data, binding.rows.path) : undefined;
            if (!result.ok || !Array.isArray(rows)) { partial = true; continue; }
            partial ||= result.truncated || result.incomplete === true || rows.length > maxRows;
            for (const row of rows.slice(0, maxRows)) {
              const sourceKey = readIqPath(row, binding.rows.keyField);
              const key = typeof sourceKey === 'string' ? sourceKey : Number.isSafeInteger(sourceKey) ? String(sourceKey) : undefined;
              if (key === undefined) { partial = true; continue; }
              const keyKind = binding.rows.keyKind ?? target.key.canonical;
              const found = await keysRepo.findBySystemKey({ tenantId: ctx.tenantId, environmentId: ctx.environmentId, thing: hop.to }, binding.system, keyKind, key);
              if (found?.status === 'matched' && found.tenantId === ctx.tenantId && found.environmentId === ctx.environmentId && found.thing === hop.to && found.system === binding.system && found.keyKind === keyKind && found.systemKey === key) {
                childIds.add(found.canonicalId);
                const id = subjectKey({ thing: hop.to, canonicalId: found.canonicalId });
                const projected: BoundAnswer[] = [];
                for (const [path, rowPath] of Object.entries(binding.rows.factFields ?? {})) {
                  const fact = index.factByPath(path);
                  const declared = index.bindingsForFact(path).find(entry => entry.system === binding.system && entry.authority === 'source_of_truth');
                  const value = readIqPath(row, rowPath);
                  // Reuse only declared, permitted non-financial facts from this exact authoritative source.
                  // Financial/unit contracts still resolve through their ordinary bindings.
                  if (!fact || fact.thing !== hop.to || !permitted(hop.to, customerRole).has(path) || !declared || ['money', 'percent'].includes(fact.type) || declared.currencyFrom || declared.stateMap || !valueFits(fact, value)) continue;
                  const connector = loaded.connectors.connectors.find(entry => entry.connectorId === binding.system)!;
                  projected.push({ binding: { ...declared, bindingId: `${binding.bindingId}#${path}`, tool: binding.tool, args: binding.args }, system: { displayName: connector.displayName, sample: connector.sample === true }, result: { kind: 'value', value, retrievedAt: this.now().toISOString(), fromCache: false } });
                }
                const prior = rowFacts.get(id);
                const values = (items: BoundAnswer[]) => items.map(item => [item.binding.target, item.result.kind === 'value' ? item.result.value : null]);
                if (prior && JSON.stringify(values(prior)) !== JSON.stringify(values(projected))) { rowFacts.delete(id); conflictingRows.add(id); }
                if (!prior && !conflictingRows.has(id) && projected.length) rowFacts.set(id, projected);
              } else partial = true;
              if (childIds.size > maxRows) { partial = true; break; }
            }
          }
          if (childIds.size > maxRows) break;
        }
        parents = [...childIds].slice(0, maxRows).map(canonicalId => ({ thing: hop.to, canonicalId }));
        if (!parents.length) break;
      }
      const records: IqRecord[] = [];
      for (const child of parents) {
        const record = await getRecord(child, request.facts, {}, customerRole);
        if (record) records.push(record); else partial = true;
      }
      return answer(records, partial ? 'partial' : records.length ? undefined : 'no_match');
    } catch {
      return no(ctx, abort.aborted ? 'deadline_exceeded' : 'key_table_unavailable');
    }
  }

  private now(): Date { return this.deps.clock?.() ?? new Date(); }
}
