import type { Product } from './types';

const CATALOG_TOOLS = new Set(['catalog.search', 'catalog-search', 'products']);

/** What the live catalogue search did this turn, in the three ways it can end: not run, failed, or returned a (possibly empty) list. */
export interface CatalogOutcome {
  ran: boolean;
  /** It ran but produced no usable result: an error, or no list at all. */
  failed: boolean;
  items: Product[];
  error?: string;
}

export function catalogOutcome(executed: Array<{ toolId: string; status?: string; output?: any; error?: unknown }>): CatalogOutcome {
  const searches = executed.filter((entry) => CATALOG_TOOLS.has(entry.toolId));
  const usable = searches.find((entry) => entry.status === 'success' && Array.isArray(entry.output?.items) && !entry.output?.error);
  if (usable) return { ran: true, failed: false, items: usable.output.items };
  const broken = searches.find((entry) => entry.output?.error || entry.error || entry.status !== 'success');
  const reason = broken?.output?.error ?? (broken?.error as any)?.message ?? broken?.error ?? (broken ? `status ${broken.status ?? 'unknown'}` : undefined);
  return { ran: searches.length > 0, failed: searches.length > 0, items: [], ...(reason ? { error: String(reason).slice(0, 160) } : {}) };
}
