/**
 * Looking things up before the agent is asked, when the customer's tap makes it certain they are needed.
 *
 * A tenant can list, per kind of tap (pack `extensions.eventPrefetch`), tool calls to run the moment the tap arrives; the results
 * are put in front of the agent with the tap, so a follow-up that must always happen (the accessories and warranty of an item that
 * was just added) does not depend on the agent deciding to look. A call can name the tapped product as `{sku}`, `{title}` or
 * `{quantity}`. Only tools the agent is allowed to use run, and a lookup that fails is left out, never fatal.
 */
export interface PrefetchCall { tool: string; args: Record<string, unknown>; showAs?: 'accessories' | 'review' }

const normaliseEventName = (name: string) => String(name || '').toLowerCase().replace(/[-_.\s]/g, '');

/** The calls configured for this kind of tap, with the tapped product filled in. Empty when none are configured or the tap names no product. */
export function prefetchCallsFor(config: unknown, event: { type?: string; payload?: any } | undefined): PrefetchCall[] {
  if (!config || typeof config !== 'object' || !event?.type) return [];
  const wanted = normaliseEventName(event.type);
  const entry = Object.entries(config as Record<string, unknown>).find(([name]) => normaliseEventName(name) === wanted)?.[1];
  if (!Array.isArray(entry)) return [];
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const values: Record<string, string> = {
    sku: String(payload.sku ?? (Array.isArray(payload.skus) ? payload.skus[0] : '') ?? '').trim(),
    title: String(payload.title ?? '').trim(),
    quantity: String(payload.quantity ?? payload.qty ?? '').trim(),
  };
  const fill = (value: unknown): unknown => (typeof value === 'string'
    ? value.replace(/\{(sku|title|quantity)\}/g, (_, key: string) => values[key])
    : value);
  const calls: PrefetchCall[] = [];
  for (const raw of entry.slice(0, 6)) {
    const tool = typeof (raw as any)?.tool === 'string' ? (raw as any).tool.trim() : '';
    if (!tool) continue;
    const args = Object.fromEntries(Object.entries((raw as any)?.args && typeof (raw as any).args === 'object' ? (raw as any).args : {}).map(([key, value]) => [key, fill(value)]));
    // A call that needs the tapped product but has none to name is not made.
    const needsProduct = JSON.stringify((raw as any)?.args || {}).includes('{sku}') || JSON.stringify((raw as any)?.args || {}).includes('{title}');
    if (needsProduct && !values.sku && !values.title) continue;
    const showAs = (raw as any)?.showAs;
    calls.push({ tool, args, ...(showAs === 'accessories' || showAs === 'review' ? { showAs: showAs as 'accessories' | 'review' } : {}) });
  }
  return calls;
}

/**
 * The accessories card for a lookup that found groups (what get_related_products returns), built only from the groups and SKUs the
 * lookup returned; undefined when it found none. The card's note says they are suggestions, in the tenant's words when it set them.
 */
export function accessoriesCardFrom(result: any, forSku: string): { cardType: 'accessories'; state: Record<string, unknown> } | undefined {
  const groups = (Array.isArray(result?.groups) ? result.groups : [])
    .map((group: any) => ({
      key: String(group?.key || group?.label || 'group'),
      label: String(group?.label || ''),
      items: (Array.isArray(group?.items) ? group.items : []).filter((item: any) => typeof item?.sku === 'string' && item.sku).map((item: any) => ({ sku: item.sku })),
    }))
    .filter((group: any) => group.label && group.items.length > 0);
  if (groups.length === 0) return undefined;
  return { cardType: 'accessories', state: { ...(forSku ? { forSku } : {}), ...(typeof result?.note === 'string' && result.note ? { note: result.note } : {}), groups } };
}

/** How the looked-up results are shown to the agent, next to the tap. */
export function formatPrefetched(results: Array<{ call: PrefetchCall; result: unknown }>, maxChars = 3500): string {
  if (results.length === 0) return '';
  const blocks = results.map(({ call, result }) => {
    let text = '';
    try { text = JSON.stringify(result); } catch { text = '(not readable)'; }
    return `<looked_up tool="${call.tool}" args=${JSON.stringify(call.args)}>\n${text.length > maxChars ? `${text.slice(0, maxChars)} …(shortened)` : text}\n</looked_up>`;
  });
  return `<already_looked_up_for_you>\nThese lookups were made for you because of this action. Use them: do not repeat them, and build on them.\n${blocks.join('\n')}\n</already_looked_up_for_you>`;
}
