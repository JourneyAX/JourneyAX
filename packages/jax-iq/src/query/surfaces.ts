import type { JaxOntologyRelease } from '../model';
import { IqQuerySchema, type IqQuery, type IqResponse } from './contracts';

/** Adapter for existing canvas/desk configurations. It derives queries from dictionary bindings, never source-specific code. */
export function iqQueryForSource(block: JaxOntologyRelease, connector: string, tool: string, args: Record<string, unknown>): { covered: boolean; query?: IqQuery } {
  if (!block.enabled) return { covered: false };
  if (connector === block.selfConnector) {
    const operation = tool.replace(/^jaxiq_/, '');
    const { thing, canonicalId, keyKind, keyValue, query, facts, link, ...filters } = args;
    const subject = typeof canonicalId === 'string' ? { thing, canonicalId } : { thing, key: { kind: keyKind, value: keyValue } };
    const parsed = IqQuerySchema.safeParse(operation === 'find' ? { operation, thing, query } : { operation, subject, ...(typeof facts === 'string' ? { facts: facts.split(',').map(value => value.trim()).filter(Boolean) } : {}), ...(operation === 'related' ? { link } : {}), ...(operation !== 'explain' && Object.keys(filters).length ? { filters } : {}) });
    return { covered: true, ...(parsed.success ? { query: parsed.data } : {}) };
  }
  const lookupThing = block.things.find(thing => thing.lookups?.some(lookup => lookup.system === connector && lookup.tool === tool));
  if (lookupThing) {
    const lookup = lookupThing.lookups!.find(lookup => lookup.system === connector && lookup.tool === tool)!;
    const parsed = IqQuerySchema.safeParse({ operation: 'find', thing: lookupThing.thing, query: args[lookup.queryArg] });
    return { covered: true, ...(parsed.success ? { query: parsed.data } : {}) };
  }
  const bindings = block.bindings.filter(binding => binding.system === connector && binding.tool === tool);
  if (!bindings.length) return { covered: false };
  const subjects = new Map<string, { thing: string; key: { kind: string; value: string } }>();
  const facts = new Set<string>(); const links = new Set<string>();
  for (const binding of bindings) {
    const thing = binding.target.kind === 'fact' ? block.facts.find(fact => fact.fact === (binding.target as any).fact)?.thing : block.links.find(link => link.link === (binding.target as any).link)?.from;
    if (!thing) continue;
    for (const [arg, source] of Object.entries(binding.args)) if (source.from === 'key') {
      const raw = args[arg];
      const value = typeof raw === 'string' ? raw : source.valueType === 'integer' && Number.isSafeInteger(raw) && (raw as number) >= 0 ? String(raw) : undefined;
      if (value === undefined) continue;
      const subject = { thing, key: { kind: source.kind, value } };
      subjects.set(JSON.stringify(subject), subject);
    }
    if (binding.target.kind === 'fact') facts.add(binding.target.fact); else links.add(binding.target.link);
  }
  if (subjects.size === 0 && block.retailCustomerIdentity && bindings.every(binding => Object.values(binding.args).some(source => source.from === 'principal'))) {
    const mapping = block.retailCustomerIdentity;
    const targets = new Set(bindings.map(binding => (binding.target.kind === 'fact' ? binding.target.fact : binding.target.link).split('.')[0]));
    if (targets.size === 1 && targets.has(mapping.thing)) {
      const subject: any = { thing: mapping.thing, canonicalId: mapping.selfAlias };
      subjects.set(JSON.stringify(subject), subject);
    }
  }
  if (subjects.size !== 1 || links.size > 1 || (links.size > 0 && facts.size > 0)) return { covered: true };
  const subject = [...subjects.values()][0];
  // Only declared request filters pass through. Source IDs cannot ride along as arbitrary filters or replace verified keys.
  const filters: Record<string, unknown> = {};
  for (const binding of bindings) for (const [arg, source] of Object.entries(binding.args)) if (source.from === 'request' && Object.prototype.hasOwnProperty.call(args, arg)) filters[source.param] = args[arg];
  const parsed = IqQuerySchema.safeParse(links.size ? { operation: 'related', subject, link: [...links][0], filters } : { operation: 'get', subject, facts: [...facts], filters });
  return { covered: true, ...(parsed.success ? { query: parsed.data } : {}) };
}

/** Existing record canvases read values that IQ actually supplied. Unknown facts stay absent, with their reasons alongside. */
export function iqRecordsView(response: IqResponse): unknown {
  if (response.ok === false) return { ok: false, code: response.code };
  const records = response.records.map(record => ({
    canonicalId: record.subject.canonicalId, thing: record.subject.thing,
    ...Object.fromEntries(record.facts.filter(fact => fact.status === 'ok').map(fact => [fact.fact.slice(fact.fact.indexOf('.') + 1), fact.value])),
    provenance: record.facts.map(fact => ({ fact: fact.fact, status: fact.status, source: fact.source, contract: fact.contract, unavailable: fact.unavailable })),
  }));
  return { ok: true, records, ...(records.length === 1 ? { record: records[0] } : {}), ...(response.pages ? { pages: response.pages } : {}), total: records.length, partial: response.status === 'partial', ambiguous: response.status === 'ambiguous', sample: response.sources.some(source => source.sample), release: response.release, queryId: response.queryId };
}
