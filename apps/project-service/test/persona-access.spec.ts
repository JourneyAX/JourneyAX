import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { ADMIN_GROUP, normaliseGroups } from '@journeyax/shared-types';
import { connectorToolState, pluginGate, usableConnectors, type ConnectorsExtension } from '@journeyax/business-pack';
import { DEMO_STAFF } from '../../../scripts/placemakers/demo-staff';
import { buildAccessPreview } from '../src/access-preview';
import { planDemoStaff } from '../../../scripts/placemakers/demo-staff';

/**
 * Who may do what with each connector tool, written out as a plain table and checked against the real rule engine and the draft pack.
 * A allows, K asks the person first (a card), - blocks. Columns, in order: admin, customer service, sales, sales manager, marketing,
 * insights, leadership, a shopper. A table like this is the point: the owner can read it and say "no, marketing should not see that".
 */
const COLUMNS = ['admin', 'csr', 'sales', 'sales.manager', 'marketing', 'insights', 'exec', 'shopper'] as const;
const TABLE: Record<string, string> = {
  //                                  admin csr sales sm mkt ins exec shopper
  'commercetools.find_product':       'A A A A A - A -',
  'commercetools.get_product':        'A A A A A - A -',
  'commercetools.get_cart':           'A A A A - - A -',
  'commercetools.add_to_cart':        'K K K K - - - -',
  'commercetools.get_order':          'A A A A - - A -',
  'commercetools.order_history':      'A A A A - - A -',
  'commercetools.stock_by_branch':    'A A A A - - A -',
  'commercetools.find_account':       'A A A A - - A -',
  'commercetools.get_account':        'A A A A - - A -',
  'salesforce.find_account':          'A A A A A - A -',
  'salesforce.get_account':           'A A A A - - A -',
  'salesforce.list_cases':            'A A A A - - A -',
  'salesforce.get_case':              'A A A A - - A -',
  'salesforce.find_lead':             'A - A A A - A -',
  'salesforce.list_opportunities':    'A - A A - - A -',
  'salesforce.get_opportunity':       'A - A A - - A -',
  'salesforce.pipeline_summary':      'A - - A - - A -',
  'salesforce.list_campaigns':        'A - A A A - A -',
  'salesforce.get_campaign':          'A - A A A - A -',
  'zendesk.find_tickets':             'A A A A - - A -',
  'zendesk.get_ticket':               'A A A A - - A -',
  'zendesk.create_ticket':            'K K - - - - - -',
  'zendesk.add_ticket_note':          'K K K K - - - -',
  'salesforce.create_case':           'K K - - - - - -',
  'google-analytics.traffic_by_page': 'A - - - A A A -',
  'google-analytics.top_searches':    'A - - - A A A -',
  'google-analytics.daily_traffic':   'A - - - A A A -',
  'google-analytics.conversion_summary': 'A - - - A A A -',
  'power-bi.list_reports':            'A - - A A A A -',
  'power-bi.get_report_figures':      'A - - A A A A -',
  'power-bi.report_totals':           'A - - A A A A -',
  'marketing-cloud.list_messages':    'A A A A A - A -',
  'marketing-cloud.get_message':      'A A A A A - A -',
  'marketing-cloud.list_templates':   'A A A A A - A -',
  'marketing-cloud.send_message':     'K - - - K - - -',
};
const STATE: Record<string, string> = { A: 'allow', K: 'ask', '-': 'blocked' };
const PARKED = ['sap-commerce', 'ace-erp', 'mulesoft', 'salsify', 'bloomreach', 'uxcam', 'location'];

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const published = draft.extensions.connectors as ConnectorsExtension;
const REAL = ['commercetools', 'salesforce', 'google-analytics', 'power-bi', 'zendesk'];
/** The pack as published switches the real systems on one at a time, as each vendor account is ready. The table below is about who may do what once they are all on, so it works on a copy with the four real ones on. */
const connectors = { ...published, connectors: published.connectors.map((connector) => (REAL.includes(connector.connectorId) ? { ...connector, enabled: true } : connector)) } as ConnectorsExtension;
const plan = planDemoStaff('placemakers');

/** Who each column is, the way the gateway would sign them: staff with the group their team becomes, the admin with the reserved group, a shopper with nothing. */
const people = {
  admin: { audience: 'staff' as const, groups: [ADMIN_GROUP] },
  ...Object.fromEntries(DEMO_STAFF.filter((person) => person.teams.length).map((person) => [person.email.split('@')[0], { audience: 'staff' as const, groups: normaliseGroups(person.teams) }])),
  shopper: { audience: 'shopper' as const, groups: [] as string[] },
} as Record<(typeof COLUMNS)[number], { audience: 'staff' | 'shopper'; groups: string[] }>;

const suite = createSuite('project-service: who may do what with each connector, by person');

async function main() {
  await suite.test('each person is the group their team becomes, and nobody but the admin has the reserved administrators group', () => {
    assert.deepEqual(people['sales.manager'].groups, ['sales-managers']);
    assert.deepEqual(people.exec.groups, ['leadership']);
    assert.deepEqual(people.csr.groups, ['customer-service']);
    assert.equal(Object.entries(people).filter(([, person]) => person.groups.includes(ADMIN_GROUP)).length, 1);
    assert.equal(plan.members.length, 6);
  });

  await suite.test('the table: every tool of every connector in scope is allowed, asked about or blocked for each person exactly as written', () => {
    const wrong: string[] = [];
    for (const [key, row] of Object.entries(TABLE)) {
      const [connectorId, tool] = key.split('.');
      const cells = row.split(' ');
      assert.equal(cells.length, COLUMNS.length, `${key} has a cell for each person`);
      COLUMNS.forEach((who, index) => {
        const got = connectorToolState(connectors, connectorId, tool, people[who]);
        if (got.state !== STATE[cells[index]]) wrong.push(`${key} for ${who}: wanted ${STATE[cells[index]]}, got ${got.state}`);
        assert.equal(got.known, true, `${key} is a tool the pack lists`);
      });
    }
    assert.deepEqual(wrong, []);
  });

  await suite.test('the table covers every tool the pack lists for the connectors in scope, so nothing is open by accident', () => {
    const inScope = ['commercetools', 'salesforce', 'google-analytics', 'power-bi', 'marketing-cloud', 'zendesk'];
    const listed = connectors.connectors.filter((connector) => inScope.includes(connector.connectorId)).flatMap((connector) => connector.tools.map((tool) => `${connector.connectorId}.${tool.name}`));
    assert.deepEqual([...listed].sort(), Object.keys(TABLE).sort());
  });

  await suite.test('a tool that changes something is never simply allowed for anyone: it asks first, or it is blocked', () => {
    for (const connector of connectors.connectors) {
      for (const tool of connector.tools.filter((entry) => entry.sideEffect === 'write')) {
        for (const who of COLUMNS) assert.notEqual(connectorToolState(connectors, connector.connectorId, tool.name, people[who]).state, 'allow', `${connector.connectorId}.${tool.name} for ${who}`);
      }
    }
  });

  await suite.test('a shopper, signed in or not, can use no connector at all', () => {
    assert.deepEqual(usableConnectors(connectors, people.shopper), []);
    assert.deepEqual(usableConnectors(connectors, { audience: 'shopper', groups: ['sales'] }), [], 'a group claimed by a shopper changes nothing');
  });

  await suite.test('the pack as published has only the systems that are really connected switched on: commercetools and Salesforce, and Marketing Cloud as a sample', () => {
    const on = published.connectors.filter((connector) => connector.enabled !== false).map((connector) => connector.connectorId).sort();
    assert.deepEqual(on, ['commercetools', 'marketing-cloud', 'salesforce'], 'switch Google Analytics and Power BI on here only when their vendor accounts are connected');
  });

  await suite.test('the parked systems are switched off for everyone, the admin included, and are still in the pack so they can be switched back on', () => {
    for (const id of PARKED) {
      const entry = connectors.connectors.find((connector) => connector.connectorId === id);
      assert.ok(entry, `${id} is still in the pack`);
      assert.equal(entry!.enabled, false, `${id} is switched off`);
      for (const who of COLUMNS) assert.equal(usableConnectors(connectors, people[who]).some((connector) => connector.connectorId === id), false, `${id} for ${who}`);
    }
  });

  await suite.test('what each person sees in the "+" menu, after the plugins have had their say', () => {
    const menu = (who: (typeof COLUMNS)[number]) => {
      const gate = pluginGate(draft.extensions.plugins, people[who]);
      return usableConnectors(connectors, people[who]).filter((connector) => gate.allows('connectors', connector.connectorId)).map((connector) => connector.connectorId).sort();
    };
    const all = ['commercetools', 'google-analytics', 'marketing-cloud', 'power-bi', 'salesforce', 'zendesk'];
    assert.deepEqual(menu('admin'), all);
    assert.deepEqual(menu('exec'), all);
    assert.deepEqual(menu('csr'), ['commercetools', 'marketing-cloud', 'salesforce', 'zendesk']);
    assert.deepEqual(menu('sales'), ['commercetools', 'marketing-cloud', 'salesforce', 'zendesk']);
    assert.deepEqual(menu('sales.manager'), ['commercetools', 'marketing-cloud', 'power-bi', 'salesforce', 'zendesk']);
    assert.deepEqual(menu('marketing'), all.filter((id) => id !== 'zendesk'), 'marketing has no use for the ticket desk');
    assert.deepEqual(menu('insights'), ['google-analytics', 'power-bi']);
    assert.deepEqual(menu('shopper'), []);
  });

  await suite.test('the assistant each person opens on: customer service and sales on theirs, everyone else on the product advisor', () => {
    const project = { agents: draft.agents, extensions: draft.extensions, defaultAgentId: draft.defaultAgentId };
    const opens = (who: (typeof COLUMNS)[number]) => buildAccessPreview(project as any, plan.teams, people[who]).agents.find((agent) => agent.opensFirst)?.agentId;
    assert.equal(opens('csr'), 'placemakers_customer_service');
    assert.equal(opens('sales'), 'placemakers_sales_quote');
    assert.equal(opens('sales.manager'), 'placemakers_sales_quote');
    for (const who of ['admin', 'marketing', 'insights', 'exec', 'shopper'] as const) assert.equal(opens(who), 'placemakers_product_advisor', who);
  });

  await suite.test('every assistant that staff may open can use connectors, so a marketing or insights person does not have to pick the customer-service assistant', () => {
    for (const agent of draft.agents) {
      for (const tool of ['list_connectors', 'get_connector_tools', 'call_connector_tool']) assert.ok(agent.allowedTools.includes(tool), `${agent.agentId} names ${tool}`);
    }
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
