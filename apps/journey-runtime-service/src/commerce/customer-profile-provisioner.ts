import { createHash, randomUUID } from 'node:crypto';
import { getVerifiedBusinessPackMetadata, mcpServerNameOf } from '@journeyax/business-pack';
import type { CapabilityDispatcher, ExecutionContext } from '@journeyax/capability-sdk';
import { actionIdentity } from '@journeyax/capability-sdk';
import { hashScopeArguments, readIqPath, signScope } from '@journeyax/jax-iq';

/** Explicitly approved registration of an existing tenant login in configured
 * business systems. Profile values come from server-owned users, never the LLM. */
export class CustomerProfileProvisioner {
  constructor(private readonly db: any, private readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>) {}

  async provision(release: any, email: string, approval: { reference: string; approvedOwner: string; environmentId: string }, orderId?: string) {
    const meta = getVerifiedBusinessPackMetadata(release);
    if (!meta || meta.environmentId !== approval.environmentId || !approval.reference || approval.approvedOwner !== email || !release.extensions?.customerProfiles?.enabled) throw new Error('An explicit owned profile approval and verified source policy are required.');
    const user = await this.db.collection('users').findOne({ tenantId: meta.tenantId, email, isActive: true }, { projection: { _id: 0, email: 1, fullName: 1 } });
    if (!user || typeof user.fullName !== 'string' || !user.fullName.trim() || user.email !== email) throw new Error('The existing approved tenant profile is unavailable. No customer details were invented.');
    const canonicalId = `jax_${createHash('sha256').update(JSON.stringify([meta.tenantId, meta.environmentId, email])).digest('hex')}`;
    const scope = { tenantId: meta.tenantId, environmentId: meta.environmentId, principalId: email };
    const links = this.db.collection('customer_profile_links');
    await links.createIndex({ tenantId: 1, environmentId: 1, principalId: 1 }, { unique: true });
    const references: Record<string, Record<string, string>> = {};
    for (const source of release.extensions.customerProfiles.sources) {
      const connector = release.extensions.connectors?.connectors.find((c: any) => c.connectorId === source.connectorId);
      if (!connector || connector.sample || connector.enabled === false || !connector.connectionRef) throw new Error('A real scoped profile connection is required.');
      const actor = 'process:approved-customer-profile-provisioning';
      const context: ExecutionContext = { tenantId: meta.tenantId, environmentId: meta.environmentId as ExecutionContext['environmentId'], principalId: actor, principalRole: 'operator', workspaceId: canonicalId, sessionId: canonicalId,
        stageId: 'customer_profile_provisioning', packVersionId: meta.version, correlationId: approval.reference, release };
      const input = { email: user.email, fullName: user.fullName, externalCustomerKey: canonicalId };
      const actionId = `${canonicalId}:${connector.connectorId}`;
      const invoke = async (name: string, args: any, write: boolean) => {
        const callActionId = name === source.orderLinkTool && orderId ? `${actionId}:${orderId}` : actionId;
        const definition = connector.tools.find((t: any) => t.name === name && t.sideEffect === (write ? 'write' : 'read'));
        if (!definition) throw new Error('A profile tool is not declared in the verified release.');
        const secret = process.env[write ? 'JAX_COMMAND_SIGNING_SECRET' : 'JAX_IQ_CONNECTOR_SIGNING_SECRET'];
        if (!secret || secret.length < 32) throw new Error('Scoped profile authority is unavailable.');
        const iat = Math.floor(Date.now() / 1000);
        const callerScope = signScope({ v: 2, operation: write ? 'command' : 'read', ...(write ? { actionId: callActionId } : {}), tenantId: meta.tenantId, environmentId: meta.environmentId,
          queryId: randomUUID(), correlationId: approval.reference, principal: { id: actor, audience: 'staff', groups: [] }, connectorId: connector.connectorId, connectionRef: connector.connectionRef,
          tool: name, toolState: 'allow', toolStateVia: 'tool', capRuleIds: ['customer-profile-provisioning'], argsHash: hashScopeArguments(args), fields: write ? [] : ['record'], release: { version: meta.version, checksum: meta.checksum }, iat, exp: iat + 60, jti: randomUUID() }, secret).header;
        const toolId = `connector:${connector.connectorId}.${name}`;
        const result = await this.dispatcher.dispatch({ toolId, version: '1.0.0', displayName: name, description: 'Approved customer profile provisioning', inputSchema: {}, outputSchema: {}, sideEffect: write ? 'write' : 'read', risk: 'low' } as any,
          { toolId, tenantId: meta.tenantId, environmentId: meta.environmentId, bindingVersion: '1.0.0', enabled: true, executor: { type: 'mcp_tool', mcpServerName: mcpServerNameOf(connector), mcpToolName: name, connectionRef: connector.connectionRef, secretRef: connector.secretRef } } as any,
          { toolId, input: args, policyState: 'allow', idempotencyKey: callActionId, userConfirmationConfirmed: true }, { ...context, idempotencyKey: callActionId, actionId: callActionId, callerScope });
        if (result.status !== 'success') throw new Error(`Profile source ${connector.connectorId} did not confirm the approved action.`);
        const output: any = result.output; return output?.data ?? output;
      };
      let receipt = await invoke(source.readTool, { email: user.email }, false);
      if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'record')) throw new Error('The profile source did not return an authoritative result.');
      if (receipt.record === null) receipt = await invoke(source.createTool, input, true);
      if (receipt.record?.externalCustomerKey !== canonicalId) throw new Error('The source customer does not match the approved canonical identity.');
      const ids: Record<string, string> = {};
      for (const [name, path] of Object.entries(source.references)) {
        const value = readIqPath(receipt, path as string);
        if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new Error('The source did not confirm all configured identity references.');
        ids[name] = value;
      }
      const identity = actionIdentity(`connector:${connector.connectorId}.${source.createTool}`, input, { ...context, actionId, idempotencyKey: actionId });
      await this.db.collection('action_receipts').updateOne({ _id: identity.id, tenantId: meta.tenantId, environmentId: meta.environmentId, inputHash: identity.inputHash, status: { $in: ['running','uncertain'] } },
        { $set: { status: 'succeeded', output: { data: receipt }, completedAt: new Date(), reconciledBy: approval.reference } });
      references[connector.connectorId] = ids;
      await links.updateOne(scope, { $set: { canonicalId, email: user.email, [`references.${connector.connectorId}`]: ids, status: 'partial', approvalReference: approval.reference, release: { version: meta.version, checksum: meta.checksum }, updatedAt: new Date() }, $setOnInsert: { ...scope, createdAt: new Date() } }, { upsert: true });
      if (orderId && source.orderLinkTool && source.orderReadTool) {
        const order = await this.db.collection('orders').findOne({ ...scope, orderId, status: 'paid' });
        if (!order?.externalOrder?.orderId || order.externalOrder.system !== connector.connectorId) throw new Error('Only the approved profile owner’s delivered order can be linked.');
        const current = await invoke(source.orderReadTool, { orderId }, false);
        if (current.record?.orderId !== order.externalOrder.orderId || current.record.orderNumber !== orderId || !Number.isSafeInteger(current.record.version)) throw new Error('The owned source order and current version could not be verified.');
        const linkArgs = { orderNumber: orderId, externalCustomerKey: canonicalId, email: user.email };
        const linked = current.record.customerId === ids.customerId && current.record.paymentCustomersLinked === true ? current : await invoke(source.orderLinkTool, linkArgs, true);
        if (linked.record?.orderId !== order.externalOrder.orderId || linked.record.customerId !== ids.customerId || linked.record.paymentCustomersLinked !== true) throw new Error('The source did not confirm the order/payment customer links.');
        const linkActionId = `${actionId}:${orderId}`;
        const linkIdentity = actionIdentity(`connector:${connector.connectorId}.${source.orderLinkTool}`, linkArgs, { ...context, actionId: linkActionId, idempotencyKey: linkActionId });
        await this.db.collection('action_receipts').updateOne({ _id: linkIdentity.id, tenantId: meta.tenantId, environmentId: meta.environmentId, inputHash: linkIdentity.inputHash, status: { $in: ['running', 'uncertain'] } }, { $set: { status: 'succeeded', output: { data: linked }, completedAt: new Date(), reconciledBy: approval.reference } });
        await this.db.collection('orders').updateOne({ ...scope, orderId, status: 'paid' }, { $set: { customerProfile: { canonicalId, email: user.email, references: { ...references } }, customerLinkReceipt: { connectorId: connector.connectorId, orderId: linked.record.orderId, version: linked.record.version, paymentIds: linked.record.linkedPaymentIds, at: new Date().toISOString() } } });
      }
    }
    await links.updateOne(scope, { $set: { status: 'ready' } });
    return { canonicalId, references, status: 'ready' };
  }
}
