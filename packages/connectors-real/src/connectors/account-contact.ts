import { ToolError, type Rec, type ToolSpec } from '../types';

const phone = /^\+[1-9]\d{7,14}$/;
const sfId = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const etag = /^"[^"\r\n\\]{1,300}"$/;
type SfApi = { read(id: string): Promise<{ record: Rec; etag?: string }>; patch(id: string, value: string, expectedEtag: string): Promise<void> };
type CommerceApi = (method: string, path: string, options?: { body?: Rec }) => Promise<Rec>;

/** Provider-specific commands, not customer scenarios. Identity and approval are enforced by the shared source boundary. */
export function salesforceAccountContact(api: SfApi): ToolSpec[] {
  const props = { accountId: { type: 'string', pattern: sfId.source } };
  return [
    { name: 'get_account_contact', readOnly: true, staffOnly: true,
      description: 'Read the exact Salesforce business account phone and its current ETag before proposing an approved correction. This is the business account phone, not an individual Contact mobile. Never infer an account match by a similar name.',
      inputSchema: { type: 'object', required: ['accountId'], properties: props, additionalProperties: false },
      async run(args) {
        if (!sfId.test(args.accountId)) throw new ToolError('invalid_arguments', 'The exact Salesforce account ID is required.');
        const current = await api.read(args.accountId);
        if (current.record.Id !== args.accountId || !current.etag || !etag.test(current.etag)) throw new ToolError('not_recorded', 'A current conditional-update token is unavailable. No correction can be proposed.');
        return { record: { accountId: current.record.Id, name: current.record.Name, phone: current.record.Phone, updatedAt: current.record.LastModifiedDate, etag: current.etag } };
      } },
    { name: 'correct_account_phone', readOnly: false, staffOnly: true,
      description: 'Correct the phone on one exact Salesforce business Account after human approval, using its current ETag. Does not update individual Contact mobiles, commerce accounts, addresses, tickets or send a customer message. Each other system requires a separately reviewed action.',
      inputSchema: { type: 'object', required: ['accountId', 'expectedEtag', 'phone'], properties: { ...props, expectedEtag: { type: 'string', maxLength: 302 }, phone: { type: 'string', pattern: phone.source } }, additionalProperties: false },
      async run(args) {
        if (!sfId.test(args.accountId) || !etag.test(args.expectedEtag) || !phone.test(args.phone)) throw new ToolError('invalid_arguments', 'An exact account, current ETag and international phone number are required.');
        const current = await api.read(args.accountId);
        if (current.record.Id !== args.accountId || current.etag !== args.expectedEtag) throw new ToolError('revision_conflict', 'The account changed. Read it again and request new approval.');
        if (current.record.Phone === args.phone) return { updated: false, unchanged: true, record: { accountId: args.accountId, etag: current.etag, changedFields: [] } };
        // Salesforce Account ETags support atomic If-Match on PATCH.
        // https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-retrieve-patch.html
        await api.patch(args.accountId, args.phone, args.expectedEtag);
        const saved = await api.read(args.accountId);
        if (saved.record.Id !== args.accountId || saved.record.Phone !== args.phone || !saved.etag || !etag.test(saved.etag)) throw new ToolError('receipt_mismatch', 'The account correction could not be confirmed. Reconcile the source before retrying.');
        return { updated: true, record: { accountId: args.accountId, etag: saved.etag, sourceUpdatedAt: saved.record.LastModifiedDate, changedFields: ['phone'] } };
      } },
  ];
}

export function commerceAccountContact(api: CommerceApi): ToolSpec[] {
  const key = /^[A-Za-z0-9_-]{2,256}$/;
  const props = { unitKey: { type: 'string', minLength: 2, maxLength: 256, pattern: key.source } };
  const path = (value: string) => `/business-units/key=${encodeURIComponent(value)}`;
  return [
    { name: 'get_account_contact', readOnly: true, staffOnly: true,
      description: 'Read the exact commerce business-unit key, current version and all recorded addresses/contact fields. Select the intended address explicitly; do not assume the first address or that an address mobile is the general account phone.',
      inputSchema: { type: 'object', required: ['unitKey'], properties: props, additionalProperties: false },
      async run(args) {
        if (typeof args.unitKey !== 'string' || !key.test(args.unitKey)) throw new ToolError('invalid_arguments', 'The exact commerce business-unit key is required.');
        const current = await api('GET', path(args.unitKey));
        if (current.key !== args.unitKey || !Number.isSafeInteger(current.version)) throw new ToolError('not_recorded', 'No exact commerce account/version was returned.');
        return { record: { unitKey: current.key, version: current.version, name: current.name, addresses: current.addresses ?? [], updatedAt: current.lastModifiedAt } };
      } },
    { name: 'correct_account_address_contact', readOnly: false, staffOnly: true,
      description: 'Correct one explicitly selected business-unit address phone or mobile after exact human approval. Requires the current unit version and address ID. Preserves address, tax, custom data and other contact fields. Does not modify a person, existing orders, CRM or send messages.',
      inputSchema: { type: 'object', required: ['unitKey', 'expectedVersion', 'addressId', 'field', 'value'], properties: { ...props, expectedVersion: { type: 'integer', minimum: 1 }, addressId: { type: 'string', minLength: 1, maxLength: 256 }, field: { type: 'string', enum: ['phone', 'mobile'] }, value: { type: 'string', pattern: phone.source } }, additionalProperties: false },
      async run(args) {
        if (typeof args.unitKey !== 'string' || !key.test(args.unitKey) || !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 1 || typeof args.addressId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(args.addressId) || !['phone', 'mobile'].includes(args.field) || !phone.test(args.value)) throw new ToolError('invalid_arguments', 'An exact account, selected address, current version and international contact number are required.');
        const current = await api('GET', path(args.unitKey));
        if (current.key !== args.unitKey || current.version !== args.expectedVersion) throw new ToolError('revision_conflict', 'The commerce account changed. Read it again and request new approval.');
        const matches = Array.isArray(current.addresses) ? current.addresses.filter((address: any) => address.id === args.addressId) : [];
        if (matches.length !== 1) throw new ToolError('not_found', 'The selected address is not recorded uniquely on this account.');
        if (matches[0][args.field] === args.value) return { updated: false, unchanged: true, record: { unitKey: current.key, version: current.version, addressId: args.addressId, changedFields: [] } };
        // https://docs.commercetools.com/api/projects/business-units#change-address
        const saved = await api('POST', path(args.unitKey), { body: { version: args.expectedVersion, actions: [{ action: 'changeAddress', addressId: args.addressId, address: { ...matches[0], [args.field]: args.value } }] } });
        const result = saved.addresses?.find((address: any) => address.id === args.addressId);
        if (saved.key !== current.key || !Number.isSafeInteger(saved.version) || saved.version <= current.version || result?.[args.field] !== args.value) throw new ToolError('receipt_mismatch', 'The commerce contact update could not be confirmed. Reconcile the source before retrying.');
        return { updated: true, record: { unitKey: saved.key, version: saved.version, addressId: args.addressId, changedFields: [args.field], sourceUpdatedAt: saved.lastModifiedAt } };
      } },
  ];
}
