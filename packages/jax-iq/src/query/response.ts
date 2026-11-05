import type { IqResponse } from './contracts';

const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const words = (value: unknown, max: number): boolean => Array.isArray(value) && value.length <= max && value.every(entry => text(entry, 4000));
const time = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Validate the complete wire contract before any response enters model context or a canvas. Fact values remain untrusted source data. */
export function validIqResponse(value: unknown): value is IqResponse {
  if (!object(value) || !text(value.queryId) || typeof value.ok !== 'boolean') return false;
  if (!value.ok) return text(value.code, 100);
  if (!object(value.release) || !text(value.release.version) || !text(value.release.checksum) || value.untrustedText !== true || !['complete', 'partial', 'ambiguous', 'no_match'].includes(value.status)) return false;
  if (!Array.isArray(value.sources) || value.sources.length > 50 || !value.sources.every((source: any) => object(source) && text(source.system) && typeof source.sample === 'boolean' && typeof source.truncated === 'boolean')) return false;
  if (!Array.isArray(value.records) || value.records.length > 50) return false;
  if (value.candidates !== undefined && (!Array.isArray(value.candidates) || value.candidates.length > 100)) return false;
  if (value.pages !== undefined && (!Array.isArray(value.pages) || value.pages.length > 50 || !value.pages.every((page: any) => object(page) && text(page.bindingId) && object(page.subject) && text(page.subject.thing) && text(page.subject.canonicalId) && text(page.cursorParam, 64) && /^[A-Za-z][A-Za-z0-9_]*$/.test(page.cursorParam) && typeof page.more === 'boolean' && (page.nextCursor === undefined ? !page.more : text(page.nextCursor, 1000) && !/[\u0000-\u001f\u007f]/.test(page.nextCursor))))) return false;
  return value.records.every((record: any) => {
    if (!object(record) || !object(record.subject) || !text(record.subject.thing) || !text(record.subject.canonicalId) || !Array.isArray(record.facts) || record.facts.length > 100) return false;
    return record.facts.every((fact: any) => {
      if (!object(fact) || !text(fact.fact) || !fact.fact.startsWith(`${record.subject.thing}.`) || !['ok', 'stale', 'not_available'].includes(fact.status) || !words(fact.bindingIds, 100) || !words(fact.notes, 100) || !Array.isArray(fact.crossChecks) || fact.crossChecks.length > 100) return false;
      if (fact.status === 'not_available') return fact.value === undefined && object(fact.unavailable) && text(fact.unavailable.reason) && typeof fact.unavailable.retryable === 'boolean';
      const source = fact.source;
      return Object.prototype.hasOwnProperty.call(fact, 'value') && object(source) && text(source.system) && text(source.displayName) && typeof source.sample === 'boolean' && text(source.tool) && ['source_of_truth', 'cross_check', 'fallback'].includes(source.authority) && typeof source.fromCache === 'boolean' && (source.sourceUpdatedAt === null || time(source.sourceUpdatedAt)) && time(source.retrievedAt) && object(source.asOf) && ['as_of', 'as_read_at'].includes(source.asOf.kind) && time(source.asOf.at);
    });
  });
}
