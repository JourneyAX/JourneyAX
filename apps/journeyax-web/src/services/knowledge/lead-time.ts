/**
 * Production lead-time capture (CAP-1 / C6).
 *
 * A team ordering a custom kit needs to know when it arrives, and for
 * made-to-order goods that is not a shipping estimate — it is a PRODUCTION
 * window that depends on how the garment is built. The platform states it in
 * `priceAndLeadTime`, a flat map of ~2,300 rules whose keys encode the rule
 * type, the decoration type and either a product-type token or an internal
 * numeric id.
 *
 * Only one family is needed for the standard question "how long until it
 * ships": `MinimumDays_LeadTime_{productType}` — the base production window per
 * product type (CUT_SEW 15, TURBO 5, REVERSIBLE 15, …). The rest of the feed is
 * rush switches, reorder rules and per-decoration surcharges, none of which the
 * base quote needs; they are left for a later pass rather than half-read here.
 *
 * The value is keyed by the platform's OWN product-type vocabulary, which is the
 * same vocabulary our products already carry in
 * `optionSpace.descriptive.productType` — so the join is on the catalogue's own
 * classification, not a guess. One alias is needed: the feed has no REGULAR
 * key because a plain sublimated garment is cut-and-sewn, so REGULAR reads
 * CUT_SEW. Aliases are data, listed here, not scattered through the code.
 */

export interface LeadTimeIndex {
  /** productType (upper-cased) → standard production days. */
  days: Record<string, number>;
  /** How many rules the feed held, for the audit trail. */
  ruleCount: number;
}

/**
 * Product types that are the same production process under another name.
 * REGULAR is a plain cut-and-sew sublimated garment; the feed files it as
 * CUT_SEW. Kept as data so a new alias is a one-line addition, not a code edit.
 */
const PRODUCT_TYPE_ALIAS: Record<string, string> = {
  REGULAR: 'CUT_SEW',
};

/** Build the production-days map from the platform's priceAndLeadTime feed. */
export function parseLeadTimes(feed: any): LeadTimeIndex {
  const rules = feed?.leadTimeAndPrice;
  if (!rules || typeof rules !== 'object') return { days: {}, ruleCount: 0 };

  const days: Record<string, number> = {};
  const prefix = 'MinimumDays_LeadTime_';
  for (const [key, val] of Object.entries(rules)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    /* The BASE per-type rule has a bare product-type token and no trailing
       numeric id (CUT_SEW, TURBO). A key like CUT_SEW_206697 is an override
       for one specific style — skipped here; the base window is what a standard
       quote wants, and reading the overrides without their matching styles
       would attach a number to the wrong garment. */
    if (/_\w*\d/.test(rest)) continue;          // has a digit → id-specific override
    const n = Math.round(Number(val));
    if (Number.isFinite(n) && n > 0) days[rest.toUpperCase()] = n;
  }
  return { days, ruleCount: Object.keys(rules).length };
}

/** The production days for a product type, following aliases. */
export function leadTimeForProductType(
  index: LeadTimeIndex,
  productType?: string,
): number | undefined {
  /* A style may list more than one process ("REVERSIBLE, TURBO"); the honest
     answer is the LONGER of the two, because the order is not done until every
     part of it is. */
  const tokens = String(productType || '')
    .split(/[,/]/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  let max: number | undefined;
  for (const raw of tokens) {
    const t = PRODUCT_TYPE_ALIAS[raw] || raw;
    const d = index.days[t] ?? index.days[PRODUCT_TYPE_ALIAS[t] || ''];
    if (d !== undefined) max = max === undefined ? d : Math.max(max, d);
  }
  return max;
}

/** Fetch the lead-time feed from the platform. */
export async function fetchLeadTimes(
  base: string,
  storeId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LeadTimeIndex> {
  const url = `${base.replace(/\/$/, '')}/wcs/resources/store/${encodeURIComponent(storeId)}`
    + `/priceAndLeadTime/getPriceAndLeadTime?responseFormat=json&rq=1`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`getPriceAndLeadTime ${res.status}`);
  return parseLeadTimes(await res.json());
}
