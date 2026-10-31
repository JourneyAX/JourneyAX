/**
 * The systems the assistant itself reaches (the project's `extensions.connectors`: Salesforce, commercetools, the ticket desk...), read for the
 * back office's Connectors gallery. These are separate from the platform's own adapters (the gallery's logo cards): an adapter is how the
 * platform stores and fetches its own data; a connected system is something the assistant can look things up in and, with a person's yes,
 * change. Pure and defensive: the project document is loose JSON, so anything that is not as expected is left out.
 */
export interface AssistantSystem { id: string; name: string; enabled: boolean; sample: boolean; tools: number; writes: number }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function readAssistantSystems(project: { extensions?: unknown } | null | undefined): AssistantSystem[] {
  const ext = isRecord(project?.extensions) ? (project!.extensions as Record<string, unknown>) : {};
  const list = isRecord(ext.connectors) && Array.isArray(ext.connectors.connectors) ? ext.connectors.connectors : [];
  const seen = new Set<string>();
  const out: AssistantSystem[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = text(entry.connectorId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const tools = Array.isArray(entry.tools) ? entry.tools.filter(isRecord) : [];
    out.push({ id, name: text(entry.displayName) || id, enabled: entry.enabled !== false, sample: entry.sample === true, tools: tools.length, writes: tools.filter((tool) => tool.sideEffect === 'write').length });
  }
  return out;
}

/** The gallery cards that stand for a system the assistant can also reach directly, by card id. */
export const ASSISTANT_SYSTEM_OF_CARD: Record<string, string> = { commercetools: 'commercetools', salesforce: 'salesforce' };

/** One plain line about what the assistant does with a system. */
export function describeAssistantSystem(system: AssistantSystem | undefined): string {
  if (!system) return 'The assistant does not reach this system directly.';
  if (!system.enabled) return 'The assistant can reach this system, but it is switched off.';
  return `The assistant reaches this system directly (${system.sample ? 'sample data' : 'real data'}, ${system.tools} tool${system.tools === 1 ? '' : 's'}${system.writes ? `, ${system.writes} that change${system.writes === 1 ? 's' : ''} data and ask first` : ''}).`;
}
