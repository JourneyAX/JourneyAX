import { metricLengthEquivalents } from '@journeyax/shared-types';

export interface CatalogIntegrityIssue {
  code: 'conflicting_source_identity' | 'conflicting_price_sources' | 'conflicting_specification_sources' | 'nonportable_image' | 'ambiguous_identifier';
  field: string;
  paths: string[];
}
export interface CatalogIntegrity {
  status: 'clear' | 'review_required';
  identityConsistent: boolean;
  /** These are source-record consistency checks, never an installed-fit certification. */
  fitVerified: false;
  issues: CatalogIntegrityIssue[];
}

function at(doc: any, path: string): any { return path.split('.').reduce((value, key) => value?.[key], doc); }
function comparable(value: unknown): string {
  const length = metricLengthEquivalents(value);
  if (length) return `length-mm:${length.mm}`;
  return JSON.stringify(typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : value) ?? 'undefined';
}

/** Compare only source fields declared by the merchant mapping; never infer a product category or repair source values. */
export function inspectCatalogIntegrity(doc: unknown, mapping: {
  sourceUrlPaths: string[]; attributeContainers: string[];
  pricing: { sources: Array<{ path: string; unit: 'major' | 'minor'; rangeKey?: string; currencyPath?: string; currency?: string }> };
}, imageUrl: string): CatalogIntegrity {
  const issues: CatalogIntegrityIssue[] = [];
  const urls = mapping.sourceUrlPaths.flatMap(path => {
    try { const raw = at(doc, path); if (typeof raw !== 'string') return []; const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) return [];
      return [{ path, host: url.hostname.toLowerCase().replace(/^www\./, ''), route: url.pathname.replace(/\/+$/, '') }];
    } catch { return []; }
  });
  // Distinct vendor hosts can legitimately provide different views. Two conflicting
  // product routes on the same host cannot both establish one canonical identity.
  const divergent = urls.filter(url => urls.some(other => other.host === url.host && other.route !== url.route));
  if (divergent.length) issues.push({ code: 'conflicting_source_identity', field: 'identity', paths: [...new Set(divergent.map(url => url.path))] });
  const prices = mapping.pricing.sources.flatMap(source => {
    const candidate = at(doc, source.path), raw = source.rangeKey && candidate && typeof candidate === 'object' ? candidate[source.rangeKey] : candidate;
    const currency = (source.currencyPath ? at(doc, source.currencyPath) : undefined) ?? source.currency;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || typeof currency !== 'string') return [];
    return [{ path: source.path, currency: currency.toUpperCase(), minor: Math.round(raw * (source.unit === 'minor' ? 1 : 100)) }];
  });
  const mismatched = prices.filter(price => prices.some(other => other.currency === price.currency && other.minor !== price.minor));
  if (mismatched.length) issues.push({ code: 'conflicting_price_sources', field: 'price', paths: [...new Set(mismatched.map(price => price.path))] });
  const fields = new Map<string, Array<{ path: string; value: unknown }>>();
  for (const container of mapping.attributeContainers) {
    const value = at(doc, container); if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [key, entry] of Object.entries(value)) {
      const values = fields.get(key) ?? []; values.push({ path: `${container}.${key}`, value: entry }); fields.set(key, values);
    }
  }
  for (const [key, values] of fields) if (new Set(values.map(entry => comparable(entry.value))).size > 1) {
    issues.push({ code: 'conflicting_specification_sources', field: `specs.${key}`, paths: values.map(entry => entry.path) });
  }
  try { const host = new URL(imageUrl).hostname.toLowerCase(); if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0') issues.push({ code: 'nonportable_image', field: 'imageUrl', paths: [] }); } catch { /* No source image is a missing asset, not a consistency claim. */ }
  return { status: issues.length ? 'review_required' : 'clear', identityConsistent: !divergent.length, fitVerified: false, issues };
}
