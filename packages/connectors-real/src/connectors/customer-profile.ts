import { ToolError, type Rec, type ToolSpec } from '../types';

type Api = (method: string, path: string, request?: { body?: unknown; query?: Rec }) => Promise<Rec>;
const literal = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const properties = { email: { type: 'string', minLength: 3, maxLength: 254 }, fullName: { type: 'string', minLength: 1, maxLength: 160 }, externalCustomerKey: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,120}$' } };
function profile(args: Rec) {
  const email = String(args.email || '').trim().toLowerCase(); const fullName = String(args.fullName || '').trim(); const key = String(args.externalCustomerKey || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName || /[\u0000-\u001f\u007f]/.test(fullName) || !/^[A-Za-z0-9_.-]{1,120}$/.test(key)) throw new ToolError('invalid_arguments', 'An existing verified customer profile and scoped reference are required.');
  const names = fullName.split(/\s+/); const lastName = names.pop()!;
  return { email, fullName, key, lastName, ...(names.length ? { firstName: names.join(' ') } : {}) };
}

/** Source records only: no password, login credential, email or invitation is created. */
export function salesforceCustomerProfile(api: Api, version: () => string): ToolSpec[] {
  const find = async (email: string) => {
    const result = await api('GET', '/query', { query: { q: `SELECT Id,AccountId,Email,Name,Account.Description FROM Contact WHERE Email = ${literal(email)} LIMIT 3` } });
    const rows = Array.isArray(result.records) ? result.records : [];
    if (rows.length > 1 || Number(result.totalSize) > 1) throw new ToolError('identity_ambiguous', 'Several CRM contacts use this email. No customer was selected.');
    return rows[0];
  };
  const asRecord = (row: any) => ({ accountId: row.AccountId, contactId: row.Id, name: row.Name, externalCustomerKey: /JourneyAX customer reference: ([A-Za-z0-9_.-]{1,120})(?:\s|$)/.exec(String(row.Account?.Description || ''))?.[1] });
  return [{ name: 'get_customer_profile', readOnly: true, staffOnly: true,
    description: 'Read one exact CRM contact ID and its previously registered canonical customer reference. Returns source IDs only, with no email/address or name-based matching.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['contactId'], properties: { contactId: { type: 'string', pattern: '^[A-Za-z0-9]{15,18}$' } } },
    async run(args) {
      const contactId = String(args.contactId || '');
      if (!/^[A-Za-z0-9]{15,18}$/.test(contactId)) throw new ToolError('invalid_arguments', 'An exact CRM contact ID is required.');
      const answer = await api('GET', '/query', { query: { q: `SELECT Id,AccountId,Account.Description FROM Contact WHERE Id = ${literal(contactId)} LIMIT 2` } });
      if (!Array.isArray(answer.records) || answer.records.length !== 1 || Number(answer.totalSize) !== 1 || answer.records[0].Id !== contactId) throw new ToolError('not_found', 'The exact registered CRM contact was not returned.');
      const row = asRecord(answer.records[0]);
      if (!row.externalCustomerKey || !/^[A-Za-z0-9]{15,18}$/.test(String(row.accountId))) throw new ToolError('identity_conflict', 'The CRM contact has no verified canonical customer/account reference.');
      return { record: { accountId: row.accountId, contactId: row.contactId, externalCustomerKey: row.externalCustomerKey } };
    } }, { name: 'find_customer_profile', readOnly: true, staffOnly: true, description: 'Find one exact customer contact and its CRM account. Ambiguous email identities are refused.', inputSchema: { type: 'object', required: ['email'], properties: { email: properties.email } },
    async run(args) { const row = await find(String(args.email).trim().toLowerCase()); return { record: row ? asRecord(row) : null }; } },
  { name: 'create_customer_profile', readOnly: false, staffOnly: true, requiredWorkflowGrant: 'customer-profile-provisioning',
    description: 'Create CRM account/contact records from an existing verified customer profile after explicit approval. No login, password, invitation or customer communication is created.',
    inputSchema: { type: 'object', required: ['email','fullName','externalCustomerKey'], properties },
    async run(args) {
      const p = profile(args); const marker = `JourneyAX customer reference: ${p.key}`;
      const prior = await find(p.email);
      if (prior) {
        if (!prior.AccountId || asRecord(prior).externalCustomerKey !== p.key) throw new ToolError('identity_conflict', 'The existing CRM contact needs an explicit identity mapping; it was not changed.');
        return { created: false, record: asRecord(prior) };
      }
      const root = `/services/data/${version()}/sobjects`;
      const response = await api('POST', '/composite', { body: { allOrNone: true, compositeRequest: [
        { method: 'POST', url: `${root}/Account`, referenceId: 'account', body: { Name: p.fullName, Description: marker } },
        { method: 'POST', url: `${root}/Contact`, referenceId: 'contact', body: { ...(p.firstName ? { FirstName: p.firstName } : {}), LastName: p.lastName, Email: p.email, AccountId: '@{account.id}', Description: marker } },
      ] } });
      const results = response.compositeResponse;
      if (!Array.isArray(results) || results.length !== 2 || results.some((r: any) => r.httpStatusCode < 200 || r.httpStatusCode >= 300 || r.body?.success !== true)) throw new ToolError('source_rejected', 'CRM did not confirm the account/contact transaction. No success is claimed.');
      const saved = await find(p.email);
      if (!saved || saved.Id !== results[1].body.id || saved.AccountId !== results[0].body.id || asRecord(saved).externalCustomerKey !== p.key) throw new ToolError('receipt_mismatch', 'The CRM customer identity could not be verified after creation.');
      return { created: true, record: asRecord(saved) };
    } }];
}

export function commerceCustomerProfile(api: Api, shapeOrder?: (order: any, withLines: boolean) => Rec): ToolSpec[] {
  const orderLink = async (orderNumber: string) => {
    const order = await api('GET', `/orders/order-number=${encodeURIComponent(orderNumber)}`);
    const refs = order.paymentInfo?.payments || [];
    if (!Array.isArray(refs) || refs.length > 20 || refs.some((r: any) => typeof r.id !== 'string')) throw new ToolError('invalid_source', 'The source payment references exceed their bound.');
    const payments = [];
    for (const ref of refs) payments.push(await api('GET', `/payments/${encodeURIComponent(ref.id)}`));
    return { order, payments };
  };
  const linkRecord = (order: any, payments: any[]) => ({ orderId: order.id, orderNumber: order.orderNumber, version: order.version, customerId: order.customerId,
    linkedPaymentIds: payments.map(p => p.id), paymentCustomersLinked: Boolean(order.customerId) && payments.length > 0 && payments.every(p => p.customer?.id === order.customerId) });
  const find = async (email: string) => {
    const result = await api('GET', '/customers', { query: { where: `email=${JSON.stringify(email)}`, limit: 3 } });
    const rows = Array.isArray(result.results) ? result.results : [];
    if (rows.length > 1 || Number(result.total) > 1) throw new ToolError('identity_ambiguous', 'Several commerce customers match this identity.');
    return rows[0];
  };
  const asRecord = (row: any) => ({ customerId: row.id, externalCustomerKey: row.key, version: row.version });
  const ownProfile = async (email: unknown) => {
    const requester = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requester)) throw new ToolError('invalid_arguments', 'A signed-in requester is required.');
    const row = await find(requester);
    if (!row || String(row.email || '').toLowerCase() !== requester || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(row.id) || typeof row.key !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(row.key) || !Number.isSafeInteger(row.version)) throw new ToolError('identity_conflict', 'The source did not confirm the signed-in registered customer.');
    return row;
  };
  const requester = { requesterEmail: { type: 'string', minLength: 3, maxLength: 254 } };
  const ownTools: ToolSpec[] = [
    { name: 'get_my_customer_profile', readOnly: true, shopperIdentityFields: ['requesterEmail'], description: 'Read only the signed-in registered customer canonical reference and revision. The source checks the requester against the signed caller; no arbitrary customer ID is accepted.', inputSchema: { type: 'object', additionalProperties: false, required: ['requesterEmail'], properties: requester }, async run(args) { return { record: asRecord(await ownProfile(args.requesterEmail)) }; } },
    { name: 'get_my_orders', readOnly: true, shopperIdentityFields: ['requesterEmail'], description: 'Read a bounded page of orders belonging to the signed-in registered customer. Confirms the source customer on every order and returns an opaque continuation offset.', inputSchema: { type: 'object', additionalProperties: false, required: ['requesterEmail'], properties: { ...requester, limit: { type: 'integer', minimum: 1, maximum: 25 }, afterCursor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,5})$' } } }, async run(args) {
      if (!shapeOrder) throw new ToolError('not_connected', 'The existing commerce order formatter is unavailable.');
      const customer = await ownProfile(args.requesterEmail);
      const limit = args.limit === undefined ? 10 : Number(args.limit); const offset = args.afterCursor === undefined ? 0 : Number(args.afterCursor);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25 || !Number.isSafeInteger(offset) || offset < 0 || offset > 999999) throw new ToolError('invalid_arguments', 'The requested order page is outside its bounded scope.');
      const answer = await api('GET', '/orders', { query: { where: `customerId=${JSON.stringify(customer.id)}`, limit: limit + 1, offset, sort: 'createdAt desc' } });
      if (!Array.isArray(answer.results) || !Number.isSafeInteger(answer.total) || answer.total < 0 || answer.results.some((order: any) => order.customerId !== customer.id || typeof order.orderNumber !== 'string' || !order.orderNumber)) throw new ToolError('identity_conflict', 'The source order page did not confirm its registered owner.');
      const more = answer.results.length > limit || offset + answer.results.length < answer.total;
      return { record: { externalCustomerKey: customer.key }, records: answer.results.slice(0, limit).map((order: any) => shapeOrder(order, false)), total: answer.total, more, ...(more ? { nextCursor: String(offset + limit) } : {}) };
    } },
    { name: 'get_my_order', readOnly: true, shopperIdentityFields: ['requesterEmail'], description: 'Read one order only after the source confirms it belongs to the signed-in registered customer. Requires its exact order number, not an arbitrary vendor UUID.', inputSchema: { type: 'object', additionalProperties: false, required: ['requesterEmail', 'orderId'], properties: { ...requester, orderId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' } } }, async run(args) {
      if (!shapeOrder || !/^[A-Za-z0-9._-]{1,64}$/.test(String(args.orderId || ''))) throw new ToolError('invalid_arguments', 'An exact owned order number is required.');
      const customer = await ownProfile(args.requesterEmail);
      const order = await api('GET', `/orders/order-number=${encodeURIComponent(String(args.orderId))}`);
      if (order.customerId !== customer.id || order.orderNumber !== args.orderId) throw new ToolError('identity_conflict', 'That order is not owned by the signed-in registered customer.');
      return { record: shapeOrder(order, true) };
    } },
  ];
  return [...ownTools, { name: 'get_customer_profile', readOnly: true, staffOnly: true,
    description: 'Read one exact commerce customer ID and its previously registered canonical customer reference. Does not return email, address or other profile details.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['customerId'], properties: { customerId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } } },
    async run(args) {
      const customerId = String(args.customerId || '');
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(customerId)) throw new ToolError('invalid_arguments', 'An exact commerce customer ID is required.');
      const row = await api('GET', `/customers/${encodeURIComponent(customerId)}`);
      if (row.id !== customerId || typeof row.key !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(row.key) || !Number.isSafeInteger(row.version)) throw new ToolError('identity_conflict', 'The source did not confirm the exact registered commerce customer identity.');
      return { record: asRecord(row) };
    } }, { name: 'find_customer_profile', readOnly: true, staffOnly: true, description: 'Find the exact commerce customer by verified email.', inputSchema: { type: 'object', required: ['email'], properties: { email: properties.email } },
    async run(args) { const row = await find(String(args.email).trim().toLowerCase()); return { record: row ? asRecord(row) : null }; } },
  { name: 'create_customer_profile', readOnly: false, staffOnly: true, requiredWorkflowGrant: 'customer-profile-provisioning', description: 'Create a commerce customer record for an existing verified external-login profile after approval. No password or customer message is created.', inputSchema: { type: 'object', required: ['email','fullName','externalCustomerKey'], properties },
    async run(args) {
      const p = profile(args); const prior = await find(p.email);
      if (prior) {
        if (prior.key !== p.key) throw new ToolError('identity_conflict', 'The existing commerce customer requires an explicit mapping and was not changed.');
        return { created: false, record: asRecord(prior) };
      }
      const result = await api('POST', '/customers', { body: { email: p.email, key: p.key, ...(p.firstName ? { firstName: p.firstName } : {}), lastName: p.lastName, authenticationMode: 'ExternalAuth' } });
      const saved = await find(p.email);
      if (!saved || saved.id !== result.customer?.id || saved.key !== p.key) throw new ToolError('receipt_mismatch', 'The commerce customer identity could not be verified.');
      return { created: true, record: asRecord(saved) };
    } }, {
    name: 'get_order_customer_link', readOnly: true, staffOnly: true,
    description: 'Read the exact order and payment customer references without returning customer profile details.',
    inputSchema: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' } } },
    async run(args) { const { order, payments } = await orderLink(String(args.orderId)); return { record: linkRecord(order, payments) }; },
  }, {
    name: 'link_order_customer', readOnly: false, staffOnly: true, requiredWorkflowGrant: 'customer-profile-provisioning',
    description: 'Attach one existing owned order and its payment references to its exact registered customer. Refuses conflicting identities and changes no prices, addresses or charges.',
    inputSchema: { type: 'object', required: ['orderNumber','externalCustomerKey','email'], properties: { orderNumber: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' }, externalCustomerKey: properties.externalCustomerKey, email: properties.email } },
    async run(args) {
      const customer = await api('GET', `/customers/key=${encodeURIComponent(String(args.externalCustomerKey))}`);
      let { order, payments } = await orderLink(String(args.orderNumber));
      if (!customer.id || String(customer.email).toLowerCase() !== String(args.email).toLowerCase() || customer.key !== args.externalCustomerKey || String(order.customerEmail).toLowerCase() !== String(args.email).toLowerCase() || order.customerId && order.customerId !== customer.id) throw new ToolError('identity_conflict', 'The exact order and registered customer do not have the same verified owner.');
      if (order.paymentState !== 'Paid' || payments.length === 0) throw new ToolError('receipt_mismatch', 'A paid source order with actual payment references is required.');
      for (const payment of payments) {
        if (payment.customer?.id && payment.customer.id !== customer.id) throw new ToolError('identity_conflict', 'An order payment belongs to a different registered customer.');
      }
      if (order.customerId !== customer.id) order = await api('POST', `/orders/${order.id}`, { body: { version: order.version, actions: [{ action: 'setCustomerId', customerId: customer.id }] } });
      if (order.customerId !== customer.id) throw new ToolError('receipt_mismatch', 'Order customer linkage was not confirmed.');
      for (let payment of payments) {
        if (payment.customer?.id !== customer.id) payment = await api('POST', `/payments/${payment.id}`, { body: { version: payment.version, actions: [{ action: 'setCustomer', customer: { typeId: 'customer', id: customer.id } }] } });
        if (payment.customer?.id !== customer.id) throw new ToolError('receipt_mismatch', 'Payment customer linkage was not confirmed.');
      }
      const confirmed = await orderLink(String(args.orderNumber));
      const receipt = linkRecord(confirmed.order, confirmed.payments);
      if (receipt.customerId !== customer.id || !receipt.paymentCustomersLinked) throw new ToolError('receipt_mismatch', 'The source customer links could not be independently read back.');
      return { record: receipt };
    },
  }];
}
