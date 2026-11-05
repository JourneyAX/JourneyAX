import type { RealConnector, ToolSpec } from '../types';
import { ToolError } from '../types';

export const DEMO_ERP_COLLECTIONS = {
  accounts: 'jax_v5_demo_erp_accounts', orders: 'jax_v5_demo_erp_orders', invoices: 'jax_v5_demo_erp_invoices',
  deliveries: 'jax_v5_demo_erp_deliveries', stock: 'jax_v5_demo_erp_stock', prices: 'jax_v5_demo_erp_prices',
} as const;
export interface DemoErpScope { tenantId: string; environmentId: 'dev' | 'test' | 'staging'; datasetId: string }
export interface DemoErpReadStore { find(collection: string, filter: Record<string, unknown>, limit: number): Promise<Record<string, any>[]> }

const text = { type: 'string', minLength: 1, maxLength: 120 };
const key = (value: unknown): string => { if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new ToolError('invalid_arguments', 'A valid source identifier is required.'); return value.trim(); };
const limitOf = (value: unknown) => typeof value === 'number' && Number.isInteger(value) ? Math.max(1, Math.min(50, value)) : 20;

/** Explicit synthetic ERP adapter. Every read is tenant/environment scoped and every answer carries its origin. No generated stock or prices. */
export function mongoDemoErp(scope: DemoErpScope, store: DemoErpReadStore, connectorId = 'erp-demo'): RealConnector {
  if (!scope.tenantId || !/^demo-[a-z0-9][a-z0-9-]{0,63}$/.test(scope.datasetId) || !['dev', 'test', 'staging'].includes(scope.environmentId)) throw new Error('Demo ERP requires an explicit non-production scope.');
  const find = async (collection: keyof typeof DEMO_ERP_COLLECTIONS, filters: Record<string, unknown>, limit: number) => {
    const rows = await store.find(DEMO_ERP_COLLECTIONS[collection], { ...filters, tenantId: scope.tenantId, environmentId: scope.environmentId, datasetId: scope.datasetId, synthetic: true }, limit);
    return rows.filter(row => row.tenantId === scope.tenantId && row.environmentId === scope.environmentId && row.datasetId === scope.datasetId && row.synthetic === true).map(({ _id, ...row }) => row);
  };
  const one = async (collection: keyof typeof DEMO_ERP_COLLECTIONS, field: string, value: unknown) => {
    const rows = await find(collection, { [field]: key(value) }, 2);
    if (rows.length !== 1) throw new ToolError(rows.length ? 'conflict' : 'not_found', 'The demo ERP record is not uniquely available.');
    return { record: rows[0], sample: true, source: 'mongo-demo-erp' };
  };
  const read = (name: string, description: string, properties: Record<string, any>, required: string[], run: ToolSpec['run']): ToolSpec => ({ name, description, readOnly: true, inputSchema: { type: 'object', properties, required, additionalProperties: false }, run });
  const tools: ToolSpec[] = [
    read('find_account', 'Find synthetic ERP account candidates by trading-name words. These are demonstration records.', { query: text, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['query'], async args => {
      const words = key(args.query).split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const rows = await find('accounts', { $and: words.map(word => ({ name: { $regex: word, $options: 'i' } })) }, limitOf(args.limit) + 1);
      const limit = limitOf(args.limit);
      return { records: rows.slice(0, limit), returned: Math.min(rows.length, limit), more: rows.length > limit, sample: true, source: 'mongo-demo-erp' };
    }),
    read('account_balance', 'Read the stored synthetic ERP account, currency, balance and terms.', { accountId: text }, ['accountId'], args => one('accounts', 'accountId', args.accountId)),
    read('get_order', 'Read one synthetic ERP order by its ERP order ID.', { orderId: text }, ['orderId'], args => one('orders', 'orderId', args.orderId)),
    read('get_invoice', 'Read one synthetic ERP invoice by its ERP invoice ID.', { invoiceId: text }, ['invoiceId'], args => one('invoices', 'invoiceId', args.invoiceId)),
    ...(['orders', 'invoices', 'deliveries'] as const).map(collection => read(`list_${collection}`, `Read this account's synthetic ERP ${collection}.`, { accountId: text, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['accountId'], async args => {
      const limit = limitOf(args.limit); const rows = await find(collection, { accountId: key(args.accountId) }, limit + 1);
      return { records: rows.slice(0, limit), returned: Math.min(limit, rows.length), more: rows.length > limit, sample: true, source: 'mongo-demo-erp' };
    })),
    read('stock_by_branch', 'Read stored demonstration branch quantities. This is not live availability.', { sku: text, branch: text, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['sku'], async args => {
      const limit = limitOf(args.limit); const rows = await find('stock', { sku: key(args.sku), ...(args.branch ? { branch: key(args.branch) } : {}) }, limit + 1);
      return { records: rows.slice(0, limit), returned: Math.min(limit, rows.length), more: rows.length > limit, sample: true, source: 'mongo-demo-erp' };
    }),
    read('account_price', 'Read the stored demonstration price for this account and SKU; no price is calculated or inferred.', { accountId: text, sku: text }, ['accountId', 'sku'], async args => {
      const rows = await find('prices', { accountId: key(args.accountId), sku: key(args.sku) }, 2);
      if (rows.length !== 1) throw new ToolError('not_found', 'No authoritative demo price is stored for this account and SKU.');
      return { record: rows[0], sample: true, source: 'mongo-demo-erp' };
    }),
  ];
  return { connectorId, title: 'Demonstration ERP (MongoDB)', description: 'Explicit synthetic ERP records; not SAP or live business data.', required: [], missing: () => [], tools };
}
