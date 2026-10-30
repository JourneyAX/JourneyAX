import { ClaimClassSchema } from '@journeyax/knowledge';
import type { ExecutionContext } from '@journeyax/capability-sdk';
import type { AgentToolDefinition } from '../kernel/model.gateway';
import type { AgentToolContext } from './agent-tools';
import type { ConnectorPerson, ConnectorSummary } from '../kernel/connector.runtime';
import { cardsShownNote, showRecordCards } from './record-cards';

/**
 * The three tools through which the model reaches connectors. They are generic: they know nothing about any one connector. The model sees
 * connectors by name and description (in its instructions and with list_connectors), loads the tools of one only when a request needs them
 * (get_connector_tools), and calls them (call_connector_tool). Every call goes through the connector runtime and the dispatcher's policy gate.
 */
export const CONNECTOR_META_TOOL_NAMES = ['list_connectors', 'get_connector_tools', 'call_connector_tool'] as const;

export function isConnectorMetaTool(toolName: string): boolean {
  return (CONNECTOR_META_TOOL_NAMES as readonly string[]).includes(toolName);
}

/** A connector or tool id as it is safe to show the page (letters, digits, dot, dash, underscore); anything else is left out. */
export function plainId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(value.trim()) ? value.trim() : undefined;
}

export const CONNECTOR_META_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: 'list_connectors',
    description: 'List the connectors you can use. A connector is another system the business keeps data in or acts on. Returns a name and a short description for each, not their tools. Use get_connector_tools to see what one connector can do.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_connector_tools',
    description: 'Load the tools of one connector so you can call them. Returns each tool\'s name, what it does and its inputs, and says which tools ask the person first and which change data. Load a connector\'s tools only when the request needs it. Optional query narrows the list.',
    parameters: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: 'The connector id, as listed.' },
        query: { type: 'string', description: 'Optional words describing the tool you are looking for.' },
      },
      required: ['connector'],
    },
  },
  {
    name: 'call_connector_tool',
    description: 'Call one tool of a connector. Load the connector\'s tools first and follow their inputs exactly; never invent a tool name. A tool that changes data may need a person\'s approval first: you then get status needs_approval and nothing has been done; tell the person what is waiting, and call again with the approvalRequestId only after they say they approved.',
    parameters: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: 'The connector id.' },
        tool: { type: 'string', description: 'The tool name, as returned by get_connector_tools.' },
        arguments: { type: 'object', description: 'The tool\'s inputs.' },
        approvalRequestId: { type: 'string', description: 'Only the id from an earlier needs_approval for this exact call, after the person approved it.' },
      },
      required: ['connector', 'tool'],
    },
  },
];

/** The connector list as a block of the agent's instructions. Empty when the person has no connector. */
export function formatConnectors(summaries: ConnectorSummary[]): string {
  if (summaries.length === 0) return '';
  // Said only when a listed system is sample data and the pack wants that announced (the summaries carry the mark only then).
  const sampleLine = summaries.some((summary) => summary.sample) ? ' If a result is marked sample, say it is sample data.' : '';
  return (
    '# Connectors you can use\n' +
    'Connectors are other systems the business keeps data in or acts on. Their tools are not loaded yet: when a request needs one, load that connector\'s tools with get_connector_tools, then use call_connector_tool. The connectors you can use are listed below, so you do not need list_connectors first: go straight to get_connector_tools for the one you need, and when a request needs two systems, load and call both in the same step. Do not guess tool names or inputs.' + sampleLine + '\n' +
    summaries.map((summary) => `- ${summary.connector}: ${summary.description}${summary.sample ? ' (sample data)' : ''}`).join('\n')
  );
}

const ANONYMOUS_SHOPPER: ConnectorPerson = { audience: 'shopper', groups: [] };

/** Runs one of the three tools. The tenant, environment and person come from the server-side context, never from the model's arguments. */
export async function executeConnectorMetaTool(
  toolName: string,
  args: Record<string, any>,
  ctx: AgentToolContext,
  execContext: ExecutionContext,
  options: {
    /** True only when the person has just allowed this exact call on an ask-first card (set by the server, never by the model). */
    confirmed?: boolean;
    /** Keeps the call and asks the person on a card; present when the chat can show one. */
    hold?: (args: Record<string, any>, details: Record<string, unknown>, prompt?: string) => any;
  } = {},
): Promise<any> {
  const runtime = ctx.connectorRuntime;
  if (!runtime) return { ok: false, error: 'Connectors are not available in this conversation.' };
  const person = ctx.principal ?? ANONYMOUS_SHOPPER;

  const switchedOff = ctx.disabledConnectors;
  const offered = () => runtime.summaries(ctx.release as any, person).filter((summary) => !switchedOff?.has(summary.connector));

  if (toolName === 'list_connectors') {
    const connectors = offered();
    return { ok: true, connectors, ...(connectors.length === 0 ? { message: 'You have no connectors.' } : {}) };
  }

  const connector = String(args.connector ?? '').trim();
  if (!connector) return { ok: false, error: 'Say which connector.', available: offered().map((summary) => summary.connector) };
  if (switchedOff?.has(connector)) return { ok: false, error: `The ${connector} connector is switched off for this chat. The person can switch it on from the + menu in the chat box.`, available: offered().map((summary) => summary.connector) };

  if (toolName === 'get_connector_tools') {
    const loaded = await runtime.loadTools(ctx.release as any, person, execContext, connector, typeof args.query === 'string' ? args.query : undefined);
    if (loaded.ok) (ctx.usedConnectorIds ||= new Set()).add(connector);
    return loaded;
  }

  // call_connector_tool
  const tool = String(args.tool ?? '').trim();
  if (!tool) return { ok: false, error: 'Say which tool.' };
  const rawArguments = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? { ...(args.arguments as Record<string, unknown>) } : {};
  // The tenant is whoever the server says; a model cannot name another.
  delete rawArguments.tenantId;
  delete rawArguments.environmentId;
  // How an ask-first tool waits: on a card for the person in the chat, or as a pending approval for an approver (the pack's choice).
  const viaCard = (ctx.release as any)?.extensions?.connectors?.askVia === 'card' && !!options.hold;
  const result = await runtime.call(ctx.release as any, person, execContext, connector, tool, rawArguments, viaCard
    ? { confirmedByPerson: options.confirmed === true }
    : {
        approvals: ctx.approvalService as any,
        approvalRequestId: typeof args.approvalRequestId === 'string' ? args.approvalRequestId : undefined,
      });
  if (viaCard && (result as any).status === 'needs_approval') {
    const display = runtime.summaries(ctx.release as any, person).find((entry) => entry.connector === connector)?.name || connector;
    return options.hold!({ connector, tool, arguments: rawArguments }, { Connector: display, Tool: tool.replace(/_/g, ' '), ...flatten(rawArguments) });
  }
  ctx.emitTrace?.('connector_call', { connector, tool, outcome: result.ok ? 'success' : (result as any).status });
  if (result.ok) {
    (ctx.usedConnectorIds ||= new Set()).add(connector);
    // What the tool says it supports, if the reply checker knows the class, is unlocked for the reply.
    for (const name of (result as any).claimClasses ?? []) {
      const parsed = ClaimClassSchema.safeParse(name);
      if (parsed.success) ctx.allowedClaimClasses.add(parsed.data);
    }
    const { claimClasses: _claimClasses, ...forModel } = result as any;
    // A team's lookups can show as cards (pack `extensions.dashboard.cards`); the model is then told the records are on screen.
    const shown = showRecordCards(ctx, connector, tool, forModel.result);
    return shown.length ? { ...forModel, shownAsCards: cardsShownNote(shown, recordCount(forModel.result)) } : forModel;
  }
  return result;
}

/** How many records a tool's answer holds: a list's length, or one for a single record. */
function recordCount(result: unknown): number {
  const body = result as any;
  if (Array.isArray(body?.records)) return body.records.length;
  if (Array.isArray(body)) return body.length;
  return 1;
}

/** The scalar inputs of a call, for the card ("sku: S-1", "quantity: 2"); a list is counted. */
function flatten(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value;
  }
  return out;
}
