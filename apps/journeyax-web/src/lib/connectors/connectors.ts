/**
 * Connectors in the chat: the list a person sees in the "+" menu and which of them they have switched off for one conversation.
 *
 * The server decides what a person may use; the browser can only switch things off, and a conversation sends the list of the ones it
 * switched off. A name the server does not know, or a person may not use, changes nothing.
 */
export interface ConnectorTool {
  name: string;
  summary?: string;
  kind: 'read' | 'write';
  state: 'allow' | 'ask';
}

export interface ConnectorItem {
  connector: string;
  name: string;
  description: string;
  owner: string;
  sample: boolean;
  tools: ConnectorTool[];
}

/** The server's list, keeping only well-formed entries (a bad one is dropped, never shown half-made). */
export function parseConnectorList(json: unknown): ConnectorItem[] {
  const list = Array.isArray((json as any)?.connectors) ? (json as any).connectors : [];
  const items: ConnectorItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw.connector !== 'string' || typeof raw.name !== 'string') continue;
    items.push({
      connector: raw.connector,
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : '',
      owner: typeof raw.owner === 'string' ? raw.owner : '',
      sample: raw.sample === true,
      tools: (Array.isArray(raw.tools) ? raw.tools : [])
        .filter((tool: any) => tool && typeof tool.name === 'string')
        .map((tool: any) => ({ name: tool.name, ...(typeof tool.summary === 'string' ? { summary: tool.summary } : {}), kind: tool.kind === 'write' ? 'write' : 'read', state: tool.state === 'ask' ? 'ask' : 'allow' })),
    });
  }
  return items;
}

/** One plain line about what a connector does for this person: "Looks things up", or "Looks things up; asks you first before changing anything". */
export function connectorCapability(item: ConnectorItem): string {
  const looksUp = item.tools.some((tool) => tool.kind === 'read');
  const changes = item.tools.some((tool) => tool.kind === 'write');
  const askFirst = item.tools.some((tool) => tool.state === 'ask');
  const parts: string[] = [];
  if (looksUp) parts.push('Looks things up');
  if (changes) parts.push(askFirst ? 'asks you first before changing anything' : 'can change things');
  return parts.length ? parts.join('; ') : 'No tools';
}

export const connectorsOffKey = (projectId: string | undefined, convoId: string) => `jx_connectors_off_${projectId || 'default'}_${convoId}`;

/** The connectors this conversation has switched off, still limited to the ones the person is shown. */
export function readOff(projectId: string | undefined, convoId: string, shown: ConnectorItem[]): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(connectorsOffKey(projectId, convoId)) || '[]');
    const known = new Set(shown.map((item) => item.connector));
    return Array.isArray(raw) ? raw.filter((id: unknown): id is string => typeof id === 'string' && known.has(id)) : [];
  } catch {
    return [];
  }
}

export function writeOff(projectId: string | undefined, convoId: string, off: string[]): void {
  try {
    if (off.length) localStorage.setItem(connectorsOffKey(projectId, convoId), JSON.stringify(off));
    else localStorage.removeItem(connectorsOffKey(projectId, convoId));
  } catch { /* storage unavailable: the switch lasts until the page is closed */ }
}

export const toggled = (off: string[], id: string): string[] => (off.includes(id) ? off.filter((entry) => entry !== id) : [...off, id]);
