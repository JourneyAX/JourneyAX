import { randomUUID } from 'node:crypto';
import { BusinessPackLoader, getVerifiedBusinessPackMetadata, mcpServerNameOf } from '@journeyax/business-pack';
import { actionIdentity, type CapabilityDispatcher, type ExecutionContext } from '@journeyax/capability-sdk';
import { hashScopeArguments, signScope } from '@journeyax/jax-iq';

/** Background payment workflow: authority is the committed provider receipt plus the pinned merchant policy.
 * Never called by the model; no staff identity is invented for a shopper's order.
 */
export class PaidOrderDelivery {
  constructor(private readonly db: any, private readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>,
    private readonly packs: Pick<BusinessPackLoader, 'loadPinned'> = new BusinessPackLoader({ db })) {}

  async deliver(event: any): Promise<void> {
    return this.apply(event);
  }

  /** Explicit operator reconciliation: preserve the historical quote pin; only link
   * its existing commerce order using a separately verified current repair policy. */
  async reconcilePaymentLink(event: any, policy: { version: string; checksum: string }): Promise<void> {
    return this.apply(event, policy);
  }

  private async apply(event: any, repairPolicy?: { version: string; checksum: string }): Promise<void> {
    if (!event.tenantId || !event.environmentId || typeof event.payload?.orderId !== 'string') throw new Error('Paid order event scope is incomplete.');
    const owner = { tenantId: event.tenantId, environmentId: event.environmentId };
    const order = await this.db.collection('orders').findOne({ ...owner, orderId: event.payload.orderId, status: 'paid' });
    if (!order || !order.principalId || !order.workspaceId || !order.stripeSessionId || order.paymentMode !== 'test' || !order.paidAt || !order.release || order.commerceSync?.eventId !== event.eventId) throw new Error('A committed, scoped test payment receipt is required for delivery.');
    const quote = await this.db.collection('quotes').findOne({ ...owner, principalId: order.principalId, quoteId: order.quoteId, version: order.quoteVersion, status: 'ordered', checkoutOrderId: order.orderId });
    if (!quote || quote.total !== order.total || quote.currency !== order.currency || JSON.stringify(quote.release) !== JSON.stringify(order.release)) throw new Error('The paid quote and order no longer match.');
    if (repairPolicy && (order.commerceSync.status !== 'ready' || !order.externalOrder?.orderId)) throw new Error('Payment reconciliation requires an already delivered commerce order.');
    const original = await this.packs.loadPinned(owner.tenantId, owner.environmentId, order.release.version, order.release.checksum);
    const originalMetadata = getVerifiedBusinessPackMetadata(original);
    if (!originalMetadata || originalMetadata.checksum !== order.release.checksum || originalMetadata.version !== order.release.version || originalMetadata.tenantId !== owner.tenantId || originalMetadata.environmentId !== owner.environmentId) throw new Error('Original paid configuration is not verified.');
    const configuration = repairPolicy || order.release;
    const pack = repairPolicy ? await this.packs.loadPinned(owner.tenantId, owner.environmentId, configuration.version, configuration.checksum) : original;
    const verified = getVerifiedBusinessPackMetadata(pack);
    if (!verified || verified.tenantId !== owner.tenantId || verified.environmentId !== owner.environmentId || verified.version !== configuration.version || verified.checksum !== configuration.checksum) throw new Error('Paid order configuration is not verified.');
    const delivery = pack.extensions?.payment?.delivery;
    const connector = pack.extensions?.connectors?.connectors.find(entry => entry.connectorId === delivery?.connectorId);
    if (!delivery || delivery.contract !== 'paid-order-v1' || !connector || connector.enabled === false || connector.sample || !connector.connectionRef ||
      !connector.tools.some(tool => tool.name === delivery.writeTool && tool.sideEffect === 'write') ||
      !connector.tools.some(tool => tool.name === delivery.receiptTool && tool.sideEffect === 'read')) throw new Error('The merchant has not configured a valid paid order delivery connection.');
    if (repairPolicy && !delivery.paymentWriteTool) throw new Error('The verified repair policy does not declare payment linkage.');
    if (order.commerceSync.status === 'ready' && order.externalOrder?.orderId && (!delivery.paymentWriteTool || order.externalPayment?.paymentId)) return;
    const context: ExecutionContext = { ...owner, principalId: order.principalId, principalRole: 'customer', workspaceId: order.workspaceId,
      sessionId: order.workspaceId, stageId: 'payment_delivery', packVersionId: verified.version, correlationId: event.eventId,
      idempotencyKey: event.eventId, actionId: event.eventId, release: pack };

    const invoke = async (name: string, args: Record<string, unknown>, write: boolean, phase = 'record') => {
      const actionId = phase === 'record' ? event.eventId : `${event.eventId}:${phase === 'confirm' ? 'confirm-payment' : phase}`;
      const secret = process.env[write ? 'JAX_COMMAND_SIGNING_SECRET' : 'JAX_IQ_CONNECTOR_SIGNING_SECRET'];
      if (!secret || secret.length < 32) throw new Error('Signed delivery source authority is not configured.');
      const iat = Math.floor(Date.now() / 1000);
      const callerScope = signScope({ v: 2, operation: write ? 'command' : 'read', ...(write ? { actionId } : {}),
        ...owner, queryId: randomUUID(), correlationId: event.eventId,
        principal: { id: order.principalId, audience: 'shopper', groups: [] }, connectorId: connector.connectorId,
        connectionRef: connector.connectionRef, tool: name, toolState: 'allow', toolStateVia: 'tool', capRuleIds: ['paid-order-delivery'],
        argsHash: hashScopeArguments(args), fields: write ? [] : ['record'], release: configuration, iat, exp: iat + 60, jti: randomUUID(),
      }, secret).header;
      const toolId = `connector:${connector.connectorId}.${name}`;
      const response = await this.dispatcher.dispatch({ toolId, version: '1.0.0', displayName: name, description: 'Merchant-configured paid order delivery', inputSchema: {}, outputSchema: {}, sideEffect: write ? 'write' : 'read', risk: 'low' } as any,
        { toolId, ...owner, bindingVersion: '1.0.0', enabled: true, executor: { type: 'mcp_tool', mcpServerName: mcpServerNameOf(connector), mcpToolName: name, connectionRef: connector.connectionRef, secretRef: connector.secretRef } } as any,
        { toolId, input: args, policyState: 'allow', idempotencyKey: actionId }, { ...context, idempotencyKey: actionId, actionId, callerScope });
      if (response.status !== 'success') throw new Error('Paid order delivery needs retry or receipt reconciliation.');
      const output: any = response.output;
      return output?.data ?? output;
    };

    const args = paidOrderArguments(order, delivery);
    const allowSourceKeyRetry = async (name: string, input: Record<string, unknown>, phase = 'record') => {
      const actionId = phase === 'record' ? event.eventId : `${event.eventId}:${phase}`;
      const identity = actionIdentity(`connector:${connector.connectorId}.${name}`, input, { ...context, actionId, idempotencyKey: actionId });
      // Only this pinned, source-key-idempotent payment workflow can reopen an uncertain
      // command, and only after its authoritative receipt lookup confirmed absence.
      await this.db.collection('action_receipts').updateOne({ _id: identity.id, tenantId: owner.tenantId, environmentId: owner.environmentId, principalId: order.principalId, inputHash: identity.inputHash, status: 'uncertain' },
        { $set: { status: 'retryable', reconciledBy: event.eventId, receiptCheckedAt: new Date() } });
    };
    // Read first on every attempt. A crash after vendor success must not cause a second write.
    const previous = await invoke(delivery.receiptTool, { orderId: order.orderId }, false);
    if (!previous || !Object.prototype.hasOwnProperty.call(previous, 'record')) throw new Error('The receipt source did not provide an authoritative result.');
    if (repairPolicy && (!previous.record || previous.record.orderId !== order.externalOrder.orderId || previous.record.paymentState !== 'Paid')) throw new Error('The existing paid commerce order cannot be verified; reconciliation stopped without creating an order.');
    if (previous.record === null) await allowSourceKeyRetry(delivery.writeTool, args);
    const items = (lines: any[]) => lines.map(line => [line.sku, line.quantity]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const matches = (receipt: any) => receipt && typeof receipt.orderId === 'string' && receipt.orderId && receipt.orderNumber === order.orderId &&
      receipt.currency === order.currency && receipt.total === order.total && receipt.lineCount === order.lines.length &&
      Array.isArray(receipt.lines) && JSON.stringify(items(receipt.lines)) === JSON.stringify(items(order.lines));
    let result = previous.record === null ? await invoke(delivery.writeTool, args, true) : previous;
    if (!matches(result?.record)) throw new Error('The commerce receipt does not match the paid order.');
    if (previous.record && result.record.paymentState !== 'Paid') {
      if (![undefined, 'Pending', 'BalanceDue'].includes(result.record.paymentState)) throw new Error('The commerce payment state requires manual reconciliation.');
      // The exact existing order is proved. Resume only its payment acknowledgement, under a separate durable action identity.
      result = await invoke(delivery.writeTool, { ...args, existingOrderId: result.record.orderId }, true, 'confirm');
    }
    const receipt = result?.record;
    if (!matches(receipt) || receipt.paymentState !== 'Paid') throw new Error('The commerce receipt does not confirm the paid order.');

    let externalPayment: any;
    if (delivery.paymentWriteTool) {
      if (!delivery.paymentReceiptTool || !connector.tools.some(tool => tool.name === delivery.paymentWriteTool && tool.sideEffect === 'write') || !connector.tools.some(tool => tool.name === delivery.paymentReceiptTool && tool.sideEffect === 'read')) throw new Error('Payment linkage is not fully configured.');
      const payment = order.paymentReceipt;
      if (payment?.provider !== 'stripe' || payment.mode !== 'test' || !payment.transactionId || payment.currency !== order.currency || !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0) throw new Error('An actual provider transaction receipt is required before payment linkage.');
      const paymentArgs = { orderNumber: order.orderId, transactionId: payment.transactionId, amountMinor: payment.amountMinor, currency: payment.currency, paymentInterface: payment.provider };
      let paymentResult = await invoke(delivery.paymentReceiptTool, { orderNumber: order.orderId, transactionId: payment.transactionId }, false);
      if (!paymentResult || !Object.prototype.hasOwnProperty.call(paymentResult, 'record')) throw new Error('The payment source did not return an authoritative result.');
      if (paymentResult.record === null || paymentResult.record.linked === false) {
        await allowSourceKeyRetry(delivery.paymentWriteTool, paymentArgs, 'record-provider-payment');
        paymentResult = await invoke(delivery.paymentWriteTool, paymentArgs, true, 'record-provider-payment');
      }
      const linked = paymentResult.record;
      if (!linked?.paymentId || linked.orderId !== receipt.orderId || linked.orderNumber !== order.orderId || linked.transactionId !== payment.transactionId || linked.amountMinor !== payment.amountMinor || linked.currency !== order.currency || linked.linked !== true || linked.chargeSucceeded !== true) throw new Error('The commerce payment linkage does not match the provider receipt.');
      const actionId = `${event.eventId}:record-provider-payment`;
      const identity = actionIdentity(`connector:${connector.connectorId}.${delivery.paymentWriteTool}`, paymentArgs, { ...context, actionId, idempotencyKey: actionId });
      await this.db.collection('action_receipts').updateOne({ _id: identity.id, tenantId: owner.tenantId, environmentId: owner.environmentId, principalId: order.principalId, inputHash: identity.inputHash, status: { $in: ['running', 'uncertain'] } },
        { $set: { status: 'succeeded', output: { data: paymentResult }, completedAt: new Date(), reconciledBy: event.eventId } });
      externalPayment = { system: connector.connectorId, paymentId: linked.paymentId, transactionId: linked.transactionId, at: new Date().toISOString() };
    }

    // A found vendor receipt can reconcile an uncertain action; no new vendor command is issued.
    if (previous.record) {
      for (const actionId of [event.eventId, `${event.eventId}:confirm-payment`]) {
        const actionArgs = actionId === event.eventId ? args : { ...args, existingOrderId: receipt.orderId };
        const identity = actionIdentity(`connector:${connector.connectorId}.${delivery.writeTool}`, actionArgs, { ...context, actionId, idempotencyKey: actionId });
        await this.db.collection('action_receipts').updateOne({ _id: identity.id, tenantId: owner.tenantId, environmentId: owner.environmentId, principalId: order.principalId, inputHash: identity.inputHash, status: { $in: ['running', 'uncertain'] } },
          { $set: { status: 'succeeded', output: { data: result }, completedAt: new Date(), reconciledBy: event.eventId } });
      }
    }
    const saved = await this.db.collection('orders').updateOne({ ...owner, principalId: order.principalId, orderId: order.orderId, status: 'paid', 'commerceSync.eventId': event.eventId },
      { $set: { externalOrder: { system: connector.connectorId, orderId: receipt.orderId, orderNumber: receipt.orderNumber, at: new Date().toISOString() }, ...(externalPayment ? { externalPayment, ...(repairPolicy ? { paymentLinkRelease: configuration } : {}) } : {}), 'commerceSync.status': 'ready' } });
    if (saved.matchedCount !== 1) throw new Error('The commerce receipt could not be recorded.');
  }
}

/** Stable cross-system identity uses the entire order id; the shortened display number is not an idempotency key. */
export function paidOrderArguments(order: any, policy: { taxCountry: string; taxLabel: string }): Record<string, unknown> {
  if (!Array.isArray(order.lines) || !order.lines.length || order.lines.some((line: any) => !Number.isFinite(line.unitPrice) || line.unitPrice <= 0 || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) || !Number.isFinite(order.taxRate)) throw new Error('The paid order has incomplete monetary lines.');
  if (!order.shipping?.address?.line1 || !/^[A-Z]{2}$/.test(order.shipping.address.country ?? '')) throw new Error('The paid order needs its provider-collected shipping address. No destination is inferred.');
  return { orderNumber: order.orderId, currency: order.currency, expectedTotal: order.total, taxRate: order.taxRate, taxCountry: policy.taxCountry, taxName: policy.taxLabel, discount: order.discount ?? 0, paid: true,
    lines: order.lines.map((line: any) => ({ sku: line.sku, name: line.name, quantity: line.quantity, unitPrice: line.unitPrice })),
    ...(order.customerProfile?.email || order.billing?.email || order.customer?.email ? { customerEmail: order.customerProfile?.email || order.billing?.email || order.customer?.email } : {}),
    ...(order.customerProfile?.canonicalId ? { customerKey: order.customerProfile.canonicalId } : {}),
    ...(order.shipping ? { shipping: { name: order.shipping.name, ...order.shipping.address } } : {}) };
}
