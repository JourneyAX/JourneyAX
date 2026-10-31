import { ConnectorsSchema, type ConnectorsExtension } from '@journeyax/business-pack';

/**
 * TEST FIXTURE ONLY. A made-up `extensions.connectors` block for the dictionaries in this folder: the tools they bind to, one write tool,
 * and the connector that offers the JAX IQ chat tools (off, no rows, no claim class on its tools). Not a copy of any real pack.
 */
const READERS = ['customer-service', 'sales', 'sales-managers', 'finance', 'leadership'];

const read = (name: string, claimClasses?: string[]) => ({ name, sideEffect: 'read' as const, ...(claimClasses ? { claimClasses } : {}) });

const connectors = [
  {
    connectorId: 'ace-erp', displayName: 'ERP', description: 'Accounts, balances, deliveries and branches.', owner: 'Test owner', sample: true,
    tools: [read('find_account', ['catalog_fact']), read('account_balance', ['catalog_fact']), read('list_account_balances', ['catalog_fact']),
      read('list_deliveries', ['catalog_fact']), read('delivery_status', ['catalog_fact']), read('list_branches'), read('stock_by_branch', ['stock', 'catalog_fact'])],
  },
  {
    connectorId: 'commercetools', displayName: 'Commerce platform', description: 'Online accounts and orders.', owner: 'Test owner', sample: false,
    tools: [read('find_account', ['catalog_fact']), read('get_account', ['catalog_fact']), read('order_history', ['catalog_fact']), read('get_order', ['catalog_fact']),
      read('stock_by_branch', ['stock', 'catalog_fact'])],
  },
  {
    connectorId: 'salesforce', displayName: 'CRM', description: 'Accounts, sales opportunities and cases.', owner: 'Test owner', sample: false,
    tools: [read('find_account'), read('get_account'), read('list_cases'), read('list_opportunities', ['catalog_fact']), read('get_opportunity', ['catalog_fact'])],
  },
  {
    connectorId: 'zendesk', displayName: 'Support desk', description: 'Support tickets.', owner: 'Test owner', sample: false,
    tools: [read('find_tickets'), read('get_ticket'), { name: 'add_ticket_note', sideEffect: 'write' as const }],
  },
  {
    connectorId: 'jax-iq', displayName: 'JAX IQ', description: 'Questions about accounts, orders and the other things in the dictionary.', owner: 'Test owner', sample: false,
    enabled: false,
    tools: [read('jaxiq_find'), read('jaxiq_get'), read('jaxiq_related'), read('jaxiq_explain')],
  },
];

/** One row per read tool of the connectors that are on, allowed for the teams above; the write tool asks first. The `jax-iq` tools have no row. */
const policy = [
  ...connectors
    .filter((connector) => connector.connectorId !== 'jax-iq')
    .flatMap((connector) => connector.tools
      .filter((tool) => tool.sideEffect === 'read')
      .map((tool) => ({ connectorId: connector.connectorId, tool: tool.name, audience: 'staff' as const, groups: READERS, state: 'allow' as const }))),
  { connectorId: 'zendesk', tool: 'add_ticket_note', audience: 'staff' as const, groups: ['customer-service'], state: 'ask' as const },
];

export const connectorsFixture: ConnectorsExtension = ConnectorsSchema.parse({ askVia: 'card', announceSample: false, connectors, policy });
