import { CaseIntakeStore } from './case-intake';

/** Minimal source outcomes retained with the case. Proposed payloads and model prose cannot manufacture receipts. */
export function recordCaseAction(workspace: any, confirmationId: string, action: any, result: any, declined = false): void {
  const review = workspace?.facts?.case_review?.value;
  if (!/^[a-f0-9]{64}$/.test(review?.caseId ?? '')) return;
  const body = result?.result ?? result;
  const sourceRecord = body?.record;
  const keys = ['accountId', 'unitKey', 'orderId', 'orderNumber', 'ticketId', 'version', 'sourceUpdatedAt', 'updated', 'status', 'changedFields'];
  const record = sourceRecord && typeof sourceRecord === 'object' ? Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(sourceRecord, key)).map(key => [key, sourceRecord[key]])) : undefined;
  const entry = { confirmationId, connector: action?.connector, tool: action?.tool, outcome: declined ? 'declined' : result?.ok === true ? 'confirmed' : 'failed', ...(result?.ok === true ? { receipt: { ...(record ? { record } : {}), ...(body?.receipt ? { auditId: body.receipt.auditId, commentId: body.receipt.commentId } : {}), unchanged: body?.unchanged === true } } : {}) };
  const prior = workspace.facts.case_action_receipts?.value;
  const entries = Array.isArray(prior) ? prior.filter(item => item.confirmationId !== confirmationId) : [];
  workspace.facts.case_action_receipts = { value: [...entries, entry].slice(-40), source: 'system', confidence: 1, extractedAt: new Date().toISOString() };
}

/** Runs from the durable turn-completed outbox, after the authoritative workspace commit.
 * A failed canvas projection retries independently; it must never make an executed business action look failed.
 */
export async function projectCaseProgress(db: any, event: { tenantId: string; environmentId: string; payload?: { workspaceId?: string } }): Promise<void> {
  if (!db) throw new Error('Durable case projection storage is required.');
  if (!event.payload?.workspaceId) return;
  const workspace = await db.collection('workspaces').findOne({ tenantId: event.tenantId, environmentId: event.environmentId, workspaceId: event.payload.workspaceId });
  const review = workspace?.facts?.case_review?.value;
  const actions = workspace?.facts?.case_action_receipts?.value;
  if (!/^[a-f0-9]{64}$/.test(review?.caseId ?? '') || !review.reviewer || !review.deskId || !workspace?.pins?.packChecksum || !Array.isArray(actions) || !actions.length) return;
  const history = workspace.facts.conversation_history?.value;
  const lastReply = Array.isArray(history) ? [...history].reverse().find(entry => entry.role === 'assistant')?.content : undefined;
  await new CaseIntakeStore(async () => db).recordProgress({ tenantId: event.tenantId, environmentId: event.environmentId, deskId: review.deskId, releaseChecksum: workspace.pins.packChecksum }, review.caseId, review.reviewer, { summary: typeof lastReply === 'string' ? lastReply : '', actions });
}
