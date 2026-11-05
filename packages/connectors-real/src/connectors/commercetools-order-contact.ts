import { ToolError, type Rec, type ToolSpec } from '../types';

type OrderApi = (method: string, path: string, options?: { body?: Rec }) => Promise<Rec>;
const allowed = new Set(['streetName', 'streetNumber', 'additionalStreetInfo', 'phone']);

/** Staff correction command. Geography/tax changes require an order-edit/repricing workflow. */
export function orderContactCorrection(api: OrderApi): ToolSpec {
  return {
    name: 'correct_order_contact', readOnly: false, staffOnly: true,
    description: 'Correct an unshipped order’s street details or international phone number after exact human approval. Requires the current source version. Does not change country, state, city, postcode, items, tax, price or payment. Return a real update receipt; never imply a customer was contacted.',
    inputSchema: { type: 'object', required: ['orderId', 'expectedVersion', 'corrections'], properties: {
      orderId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
      expectedVersion: { type: 'integer', minimum: 1 },
      corrections: { type: 'object', properties: {
        streetName: { type: 'string', minLength: 1, maxLength: 120, description: 'Correct street name/address line.' },
        streetNumber: { type: 'string', minLength: 1, maxLength: 30 },
        additionalStreetInfo: { type: 'string', maxLength: 120 },
        phone: { type: 'string', minLength: 9, maxLength: 16, description: 'International format, beginning with +.' },
      } },
    } },
    async run(args) {
      if (typeof args.orderId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(args.orderId) || !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 1) throw new ToolError('invalid_arguments', 'A valid order and its current version are required.');
      const corrections = args.corrections;
      if (!corrections || typeof corrections !== 'object' || Array.isArray(corrections) || !Object.keys(corrections).length || Object.keys(corrections).some(field => !allowed.has(field))) throw new ToolError('invalid_arguments', 'Only street detail and phone corrections are supported. Location changes require a reviewed order edit.');
      for (const [field, value] of Object.entries(corrections)) {
        const max = field === 'streetNumber' ? 30 : field === 'phone' ? 16 : 120;
        if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (field !== 'additionalStreetInfo' && !value.trim())) throw new ToolError('invalid_arguments', 'A correction is incomplete or invalid.');
      }
      if (corrections.phone && !/^\+[1-9]\d{7,14}$/.test(corrections.phone)) throw new ToolError('invalid_arguments', 'Provide the complete international phone number.');
      const key = /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(args.orderId) ? args.orderId : `order-number=${encodeURIComponent(args.orderId)}`;
      const current = await api('GET', `/orders/${key}`);
      if (!current.id || current.version !== args.expectedVersion) throw new ToolError('revision_conflict', 'The order changed. Read its current details and request approval again.');
      if (['Complete', 'Cancelled'].includes(current.orderState) || ['Shipped', 'PartiallyShipped'].includes(current.shipmentState) || (Array.isArray(current.shippingInfo?.deliveries) && current.shippingInfo.deliveries.length)) throw new ToolError('fulfilment_started', 'This order has entered fulfilment. A shipping correction needs the fulfilment team.');
      if (!current.shippingAddress || typeof current.shippingAddress !== 'object' || !current.shippingAddress.country) throw new ToolError('not_recorded', 'The source has no shipping address to correct.');
      // The API replaces the entire address. Preserve untouched fields and custom data explicitly.
      // https://docs.commercetools.com/api/projects/orders#set-shipping-address
      const address = { ...current.shippingAddress, ...corrections };
      const updated = await api('POST', `/orders/${current.id}`, { body: { version: args.expectedVersion, actions: [{ action: 'setShippingAddress', address }] } });
      if (updated.id !== current.id || !Number.isSafeInteger(updated.version) || updated.version <= current.version || Object.entries(corrections).some(([field, value]) => updated.shippingAddress?.[field] !== value)) throw new ToolError('receipt_mismatch', 'The order update could not be confirmed. Reconcile the source before retrying.');
      return { updated: true, record: { orderId: updated.id, orderNumber: updated.orderNumber, version: updated.version, changedFields: Object.keys(corrections).sort(), sourceUpdatedAt: updated.lastModifiedAt } };
    },
  };
}
