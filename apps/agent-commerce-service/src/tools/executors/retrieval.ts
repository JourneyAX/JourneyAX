import { adapterRegistry } from '@journeyax/integration';

export async function resolveSkuByName(tenantId: string, nameOrSku: string): Promise<string> {
  try {
    const port = await adapterRegistry.getKnowledge(tenantId);
    const result: any = await port.search({ tenantId }, { query: nameOrSku, type: 'product', limit: 3 });
    const hit = (result?.results || []).find((product: any) => product?.sku);
    return hit?.sku ? String(hit.sku) : '';
  } catch {
    return '';
  }
}

export async function lookupOptions(tenantId: string, rawArgs: string): Promise<unknown> {
  let sku = '';
  try { sku = String(JSON.parse(rawArgs || '{}').sku || '').trim(); } catch { /* fall through */ }
  if (!sku) return { found: false, message: 'No item code supplied.' };
  try {
    const port = await adapterRegistry.getKnowledge(tenantId);
    if (typeof port.options !== 'function') {
      return { found: false, sku, message: 'Option data is not available for this catalogue.' };
    }
    const result = await port.options({ tenantId }, sku);
    if (!result.found) {
      const resolved = await resolveSkuByName(tenantId, sku);
      if (resolved && resolved !== sku) {
        const resolvedResult = await port.options({ tenantId }, resolved);
        if (resolvedResult.found) return { ...resolvedResult, sku: resolved, resolvedFrom: sku };
      }
    }
    return result.found
      ? result
      : { found: false, sku, message: `No per-variant colour/size list is recorded for ${sku}. Do NOT tell the customer you "couldn't retrieve" or "failed to find" anything — that reads as a broken feature. Instead, describe the item's known details (fabric, fit, materials, care) confidently, and if they want a specific colour or size, say it can be confirmed at checkout. Never invent specific colours or sizes you have not verified.` };
  } catch (error) {
    console.error('[AgentService] getProductOptions error:', error);
    return { found: false, sku, message: 'Option lookup failed.' };
  }
}

export async function lookupRelated(tenantId: string, rawArgs: string): Promise<unknown> {
  let sku = '';
  try { sku = String(JSON.parse(rawArgs || '{}').sku || '').trim(); } catch { /* fall through */ }
  if (!sku) return { found: false, message: 'No item code supplied.' };
  try {
    const port = await adapterRegistry.getKnowledge(tenantId);
    if (typeof port.related !== 'function') {
      return { found: false, sku, message: 'Relationship data is not available for this catalogue.' };
    }
    const result = await port.related({ tenantId }, sku);
    const found = !!(result.collections.length || result.outfittingSets.length || result.sizingGroup);
    if (!found) {
      const resolved = await resolveSkuByName(tenantId, sku);
      if (resolved && resolved !== sku) {
        const resolvedResult = await port.related({ tenantId }, resolved);
        if (resolvedResult.collections.length || resolvedResult.outfittingSets.length || resolvedResult.sizingGroup) {
          return { found: true, ...resolvedResult, sku: resolved, resolvedFrom: sku };
        }
      }
    }
    return found
      ? { found: true, ...result }
      : { found: false, sku, message: `No collection, coordinating set or alternate-size version is recorded for ${sku}. Say so plainly — do not infer or construct one.` };
  } catch (error) {
    console.error('[AgentService] findRelated error:', error);
    return { found: false, sku, message: 'Relationship lookup failed.' };
  }
}
