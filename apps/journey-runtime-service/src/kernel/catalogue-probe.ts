import { CatalogSearchHandler, tokenizeQuery } from '../capabilities/handlers/catalog-search.handler';

/** A bare noun is only "shopping" if the live catalogue actually lists it; longer free text never qualifies. */
const MAX_PROBE_WORDS = 6;

/**
 * Cheap live existence check used to classify an otherwise unclassified request. It reuses the catalogue handler
 * (tenant isolation, lifecycle exclusion and field mapping all come from the tenant's catalogue mapping) and asks
 * for a single product whose record matches every significant word. Failure is "no evidence", never a guess.
 */
export async function probeCatalogue(
  dbProvider: () => Promise<any>,
  input: { tenantId: string; message: string; catalogMapping?: unknown },
): Promise<boolean> {
  const words = tokenizeQuery(input.message);
  if (words.length === 0 || words.length > MAX_PROBE_WORDS) return false;
  try {
    const handler = new CatalogSearchHandler(undefined, dbProvider);
    const result = await handler.execute(
      { query: input.message, maxResults: 1, matchAllTokens: true },
      { tenantId: input.tenantId, packSettings: { catalogMapping: input.catalogMapping } } as any,
    );
    return Array.isArray(result.items) && result.items.length > 0;
  } catch {
    return false;
  }
}

