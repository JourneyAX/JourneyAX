import { SupportHandoffSchema } from '@journeyax/business-pack';
import { readIqPath } from '@journeyax/jax-iq';
import type { AgentToolContext } from './agent-tools';

export { SupportHandoffSchema } from '@journeyax/business-pack';

export function supportHandoffSetting(release: any) {
  const parsed = SupportHandoffSchema.safeParse(release?.extensions?.supportHandoff);
  if (!parsed.success) return undefined;
  const config = parsed.data;
  const tool = release.extensions?.connectors?.connectors?.find((connector: any) => connector.connectorId === config.connector && connector.enabled !== false)?.tools?.find((entry: any) => entry.name === config.tool);
  return tool?.sideEffect === 'write' ? config : undefined;
}

/** Only an actual connector receipt can put a support request on the canvas or mark the conversation handed over. */
export function captureSupportReceipt(ctx: AgentToolContext, connector: string, tool: string, result: unknown): { ticketId: string; connector: string } | undefined {
  const setting = supportHandoffSetting(ctx.release);
  if (!setting || setting.connector !== connector || setting.tool !== tool || !ctx.workspace) return undefined;
  const value = readIqPath(result, setting.ticketIdPath);
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || String(value).length > 200) return undefined;
  const receipt = { ticketId: String(value), connector };
  const previous = ctx.workspace.facts?.support_requests?.value;
  const list = Array.isArray(previous) ? previous : [];
  ctx.workspace.facts ??= {};
  ctx.workspace.facts.support_requests = { value: [...list.filter(entry => entry?.ticketId !== receipt.ticketId || entry?.connector !== connector), { ...receipt, recordedAt: new Date().toISOString() }].slice(-20), source: 'system', confidence: 1, extractedAt: new Date().toISOString() };
  ctx.isHumanHandoffRequested = true;
  ctx.emitUiAction?.({ name: 'handoff', arguments: { ...receipt, status: 'created' } });
  const wording = setting.receiptCard;
  const allowed = ctx.release.experience?.cards?.allowedCardTypes;
  if (wording && (!Array.isArray(allowed) || allowed.includes('records'))) {
    const text = (value: string) => value.replace(/\{ticketId\}/g, receipt.ticketId);
    const state = { heading: wording.heading, rows: [{ title: text(wording.title), ...(wording.detail ? { detail: text(wording.detail) } : {}), ...(wording.badge ? { badge: wording.badge } : {}), tone: 'good' }], total: 1, shown: 1 };
    ctx.presentedCards.push({ cardType: 'records', state });
    ctx.emitUiAction?.({ name: 'presentCard', arguments: { card: { id: `support-${receipt.ticketId}`, cardType: 'records', state } } });
  }
  return receipt;
}

export function supportRequestArgs(ctx: AgentToolContext, reason: string): { connector: string; tool: string; arguments: Record<string, unknown> } | undefined {
  const setting = supportHandoffSetting(ctx.release);
  const email = ctx.principalId ?? '';
  if (!setting || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === 'guest@anonymous') return undefined;
  const thread = ctx.workspace?.facts?.conversation_history?.value;
  const messages = Array.isArray(thread) ? thread.filter(entry => entry?.role === 'customer' || entry?.role === 'assistant').slice(-8).map(entry => `${entry.role}: ${String(entry.content).slice(0, 500)}`).join('\n') : '';
  return { connector: setting.connector, tool: setting.tool, arguments: {
    [setting.inputs.subject]: setting.subject,
    [setting.inputs.description]: `${reason}\n\n${messages}`.slice(0, 4000),
    [setting.inputs.requesterEmail]: email,
  } };
}
