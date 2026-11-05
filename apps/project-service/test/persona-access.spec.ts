import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { ADMIN_GROUP, normaliseGroups } from '@journeyax/shared-types';
import { connectorToolState, pluginGate, resolveSkillTiers, usableConnectors, type ConnectorsExtension } from '@journeyax/business-pack';
import { DEMO_STAFF } from '../../../scripts/placemakers/demo-staff';
import { buildAccessPreview } from '../src/access-preview';
import { planDemoStaff } from '../../../scripts/placemakers/demo-staff';

/**
 * Who may do what with each connector tool, written out as a plain table and checked against the real rule engine and the draft pack.
 * A allows, K asks the person first (a card), - blocks. Columns, in order: admin, customer service, sales, sales manager, marketing,
 * insights, leadership, branch, finance, a shopper. A table like this is the point: the owner can read it and say "no, marketing should not see that".
 */
const COLUMNS = ['admin', 'csr', 'sales', 'sales.manager', 'marketing', 'insights', 'exec', 'branch', 'finance', 'shopper'] as const;
const TABLE: Record<string, string> = {
  'commercetools.get_my_customer_profile': '- - - - - - - - - -',
  'commercetools.get_my_orders': '- - - - - - - - - -',
  'commercetools.get_my_order': '- - - - - - - - - -',
  // Newly registered source tools stay blocked in this template until an evaluated release grants scoped access.
  'commercetools.get_customer_profile': '- - - - - - - - - -',
  'commercetools.find_customer_profile': '- - - - - - - - - -',
  'commercetools.create_customer_profile': '- - - - - - - - - -',
  'commercetools.get_order_customer_link': '- - - - - - - - - -',
  'commercetools.link_order_customer': '- - - - - - - - - -',
  'commercetools.get_order_payment_receipt': '- - - - - - - - - -',
  'commercetools.record_order_payment': '- - - - - - - - - -',
  'commercetools.get_account_contact': '- - - - - - - - - -',
  'commercetools.correct_account_address_contact': '- - - - - - - - - -',
  'commercetools.correct_order_contact': '- - - - - - - - - -',
  'commercetools.get_order_receipt': '- - - - - - - - - -',
  'salesforce.get_customer_profile': '- - - - - - - - - -',
  'salesforce.find_customer_profile': '- - - - - - - - - -',
  'salesforce.create_customer_profile': '- - - - - - - - - -',
  'salesforce.get_account_contact': '- - - - - - - - - -',
  'salesforce.correct_account_phone': '- - - - - - - - - -',
  'zendesk.count_tickets': '- - - - - - - - - -',
  'zendesk.get_customer_ticket': '- - - - - - - - - -',
  'zendesk.reply_to_ticket': '- - - - - - - - - -',
  'zendesk.update_ticket': '- - - - - - - - - -',
  //                                  admin csr sales sm mkt ins exec branch finance shopper
  'commercetools.find_product':       'A A A A A - A A A -',
  'commercetools.get_product':        'A A A A A - A A A -',
  'commercetools.get_cart':           'A A A A - - A A - -',
  'commercetools.add_to_cart':        'K K K K - - - K - -',
  'commercetools.place_order':        '- - - - - - - - - -',
  'commercetools.get_order':          'A A A A - - A A A -',
  'commercetools.order_history':      'A A A A - - A A A -',
  'commercetools.list_orders':        'A A - A - - A A A -',
  'commercetools.stock_by_branch':    'A A A A - - A A - -',
  'commercetools.find_account':       'A A A A - - A A A -',
  'commercetools.get_account':        'A A A A - - A A A -',
  'salesforce.find_account':          'A A A A A - A A A -',
  'salesforce.get_account':           'A A A A - - A A A -',
  'salesforce.list_cases':            'A A A A - - A A A -',
  'salesforce.get_case':              'A A A A - - A A A -',
  'salesforce.find_lead':             'A - A A A - A - - -',
  'salesforce.list_opportunities':    'A - A A - - A - - -',
  'salesforce.get_opportunity':       'A - A A - - A - - -',
  'salesforce.pipeline_summary':      'A - - A - - A - - -',
  'salesforce.list_campaigns':        'A - A A A - A - - -',
  'salesforce.get_campaign':          'A - A A A - A - - -',
  'zendesk.find_tickets':             'A A A A - - A - - -',
  'zendesk.list_recent_tickets':      '- - - - - - - - - -',
  'zendesk.get_ticket':               'A A A A - - A - - -',
  'zendesk.create_ticket':            'K K - - - - - - - -',
  'zendesk.add_ticket_note':          'K K K K - - - - - -',
  'salesforce.create_case':           'K K K - - - - K - -',
  'ace-erp.stock_by_branch':          'A A A A - - A A - -',
  'ace-erp.trade_price':              'A A A A - - A A A -',
  'ace-erp.delivery_status':          'A A A A - - A A - -',
  'ace-erp.list_deliveries':          'A A A A - - A A - -',
  'ace-erp.find_account':             'A A A A - - A A - -',
  'ace-erp.account_balance':          'A A - A - - A - A -',
  'ace-erp.list_account_balances':    'A A - A - - A - A -',
  'ace-erp.list_branches':            'A A A A - - A A A -',
  'google-analytics.traffic_by_page': 'A - - - A A A - - -',
  'google-analytics.top_searches':    'A - - - A A A - - -',
  'google-analytics.daily_traffic':   'A - - - A A A - - -',
  'google-analytics.conversion_summary': 'A - - - A A A - - -',
  'power-bi.list_reports':            'A - - A A A A - - -',
  'power-bi.get_report_figures':      'A - - A A A A - - -',
  'power-bi.report_totals':           'A - - A A A A - - -',
  'marketing-cloud.list_messages':    'A A A A A - A - - -',
  'marketing-cloud.get_message':      'A A A A A - A - - -',
  'marketing-cloud.list_templates':   'A A A A A - A - - -',
  'marketing-cloud.send_message':     'K - - - K - - - - -',
};
const STATE: Record<string, string> = { A: 'allow', K: 'ask', '-': 'blocked' };
/**
 * Who has which playbook, in the same plain-table style. O means the playbook is on demand for that person (its name and description are in
 * the prompt and the assistant opens it when a request fits); - means they do not have it at all. A shopper has none of them.
 */
const PLAYBOOKS: Record<string, string> = {
  //                                  admin csr sales sm mkt ins exec branch finance shopper
  'account-360':                      'O O O O - - O O O -',
  'order-enquiry':                    'O O O O - - - O O -',
  'case-queue-review':                'O O - O - - O - - -',
  'branch-stock-check':               'O O O - - - - O - -',
  'overdue-and-invoice-query':        'O O - O - - - - O -',
  'escalated-account-brief':          'O O - O - - O O - -',
  'special-order-handover':           'O O O O - - - - - -',
  'price-and-stock':                  'O O O O - - O O - -',
};

const PARKED = ['sap-commerce', 'mulesoft', 'salsify', 'bloomreach', 'uxcam', 'location'];

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
    assert.deepEqual(people.branch.groups, ['branch']);
    assert.deepEqual(people.finance.groups, ['finance']);
    assert.equal(plan.members.length, 8);
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
    const inScope = ['commercetools', 'salesforce', 'google-analytics', 'power-bi', 'marketing-cloud', 'zendesk', 'ace-erp'];
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

  await suite.test('the pack as published has only the systems that are really connected and wanted switched on: commercetools and Salesforce, and Marketing Cloud and the ERP as samples', () => {
    const on = published.connectors.filter((connector) => connector.enabled !== false).map((connector) => connector.connectorId).sort();
    assert.deepEqual(on, ['ace-erp', 'commercetools', 'marketing-cloud', 'salesforce', 'zendesk'], 'switch Google Analytics and Power BI on here only when their vendor accounts are connected');
  });

  await suite.test('Zendesk is the ticket desk: on, for the people whose rules name it (customer service, sales, sales managers, leadership, the admin) and for nobody else', () => {
    const zendesk = published.connectors.find((connector) => connector.connectorId === 'zendesk');
    assert.ok(zendesk, 'in the pack');
    assert.equal(zendesk!.enabled, true);
    const has = (who: (typeof COLUMNS)[number]) => usableConnectors(published, people[who]).some((connector) => connector.connectorId === 'zendesk');
    for (const who of ['csr', 'sales', 'sales.manager', 'exec', 'admin'] as const) assert.equal(has(who), true, `zendesk for ${who}`);
    for (const who of ['branch', 'finance', 'marketing', 'insights', 'shopper'] as const) assert.equal(has(who), false, `zendesk for ${who}`);
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
    const all = ['ace-erp', 'commercetools', 'google-analytics', 'marketing-cloud', 'power-bi', 'salesforce', 'zendesk'];
    assert.deepEqual(menu('admin'), all);
    assert.deepEqual(menu('exec'), all);
    assert.deepEqual(menu('csr'), ['ace-erp', 'commercetools', 'marketing-cloud', 'salesforce', 'zendesk']);
    assert.deepEqual(menu('sales'), ['ace-erp', 'commercetools', 'marketing-cloud', 'salesforce', 'zendesk']);
    assert.deepEqual(menu('sales.manager'), ['ace-erp', 'commercetools', 'marketing-cloud', 'power-bi', 'salesforce', 'zendesk']);
    assert.deepEqual(menu('marketing'), all.filter((id) => id !== 'zendesk' && id !== 'ace-erp'), 'marketing has no use for the ticket desk or the ERP');
    assert.deepEqual(menu('branch'), ['ace-erp', 'commercetools', 'salesforce'], 'the counter reads stock and prices from the ERP, and orders and cases; nothing else');
    assert.deepEqual(menu('finance'), ['ace-erp', 'commercetools', 'salesforce'], 'finance reads balances from the ERP');
    assert.deepEqual(menu('insights'), ['google-analytics', 'power-bi']);
    assert.deepEqual(menu('shopper'), []);
  });

  await suite.test('the assistant each person opens on: customer service and sales on theirs, everyone else on the product advisor', () => {
    const project = { agents: draft.agents, extensions: draft.extensions, defaultAgentId: draft.defaultAgentId };
    const opens = (who: (typeof COLUMNS)[number]) => buildAccessPreview(project as any, plan.teams, people[who]).agents.find((agent) => agent.opensFirst)?.agentId;
    assert.equal(opens('csr'), 'placemakers_customer_service');
    assert.equal(opens('sales'), 'placemakers_sales_quote');
    assert.equal(opens('sales.manager'), 'placemakers_sales_quote');
    assert.equal(opens('branch'), 'placemakers_customer_service');
    assert.equal(opens('finance'), 'placemakers_customer_service');
    for (const who of ['admin', 'marketing', 'insights', 'exec', 'shopper'] as const) assert.equal(opens(who), 'placemakers_product_advisor', who);
  });

  await suite.test('every assistant that staff may open can use connectors, so a marketing or insights person does not have to pick the customer-service assistant', () => {
    for (const agent of draft.agents) {
      for (const tool of ['list_connectors', 'get_connector_tools', 'call_connector_tool']) assert.ok(agent.allowedTools.includes(tool), `${agent.agentId} names ${tool}`);
    }
  });

  await suite.test('the playbook table: each playbook is on demand for exactly the people written, and for no shopper', () => {
    const wrong: string[] = [];
    const skills = draft.skills as Array<{ skillId: string; tier?: 'always' | 'on_demand' }>;
    const access = draft.extensions.skillAccess;
    for (const [skillId, row] of Object.entries(PLAYBOOKS)) {
      const cells = row.split(' ');
      assert.equal(cells.length, COLUMNS.length, `${skillId} has a cell for each person`);
      assert.ok(skills.some((skill) => skill.skillId === skillId), `${skillId} is a skill of the pack`);
      COLUMNS.forEach((who, index) => {
        const got = resolveSkillTiers(skills.filter((skill) => skill.skillId === skillId), access, people[who]);
        const cell = got.length === 0 ? '-' : got[0].tier === 'on_demand' ? 'O' : 'A';
        if (cell !== cells[index]) wrong.push(`${skillId} for ${who}: wanted ${cells[index]}, got ${cell}`);
      });
    }
    assert.deepEqual(wrong, []);
  });

  await suite.test('every playbook of the pack is in the table, is on demand, is carried by the customer-service and sales assistants and not by the product advisor', () => {
    const playbookIds = (draft.extensions.skillAccess.rows as Array<{ skillId: string }>).map((row) => row.skillId);
    assert.deepEqual([...new Set(playbookIds)].sort(), Object.keys(PLAYBOOKS).sort(), 'a playbook with access rows is in the table, and the other way round');
    for (const skillId of playbookIds) assert.equal((draft.skills as any[]).find((skill) => skill.skillId === skillId).tier, 'on_demand', `${skillId} is on demand: only its description is in the prompt`);
    const carried = (agentId: string) => (draft.agents.find((agent: any) => agent.agentId === agentId).skills ?? []) as string[];
    for (const agentId of ['placemakers_customer_service', 'placemakers_sales_quote']) for (const skillId of playbookIds) assert.ok(carried(agentId).includes(skillId), `${agentId} carries ${skillId}`);
    for (const skillId of playbookIds) assert.equal(carried('placemakers_product_advisor').includes(skillId), false, `the product advisor does not carry ${skillId}`);
    for (const row of draft.extensions.skillAccess.rows as Array<{ audience: string; level: string }>) assert.equal(row.audience, 'staff', 'no playbook has a shopper row');
  });

  await suite.test('a playbook only names tools the pack lists, and where a holder is not allowed one of them the table below says so and the playbook tells the assistant to carry on without it', () => {
    const toolsOf = new Map<string, Map<string, string>>(published.connectors.map((connector) => [connector.connectorId, new Map(connector.tools.map((tool) => [tool.name, tool.sideEffect ?? 'read']))]));
    const gaps: Record<string, Record<string, string[]>> = {};
    for (const skill of draft.skills.filter((entry: any) => PLAYBOOKS[entry.skillId])) {
      const named = [...new Set([...String(skill.instructions).matchAll(/\b(commercetools|salesforce)\.([a-z_]+)/g)].map((match) => `${match[1]}.${match[2]}`))];
      assert.ok(named.length > 0, `${skill.skillId} names the tools it relies on`);
      for (const key of named) assert.ok(toolsOf.get(key.split('.')[0])?.has(key.split('.')[1]), `${skill.skillId} names ${key}, which the pack lists`);
      COLUMNS.forEach((who, index) => {
        if (PLAYBOOKS[skill.skillId].split(' ')[index] !== 'O' || who === 'admin') return;
        const blocked = named.filter((key) => connectorToolState(connectors, key.split('.')[0], key.split('.')[1], people[who]).state === 'blocked');
        if (blocked.length) (gaps[skill.skillId] ??= {})[who] = blocked;
      });
    }
    // Who is sent to a tool they may not use, written out so the owner can read it and say "customer service should see deals".
    assert.deepEqual(gaps, {
      'account-360': { csr: ['salesforce.list_opportunities'], branch: ['salesforce.list_opportunities'], finance: ['salesforce.list_opportunities'] },
      'order-enquiry': { 'sales.manager': ['salesforce.create_case'], finance: ['salesforce.create_case'] },
      'escalated-account-brief': { csr: ['salesforce.list_opportunities'], branch: ['salesforce.list_opportunities'] },
      'special-order-handover': { 'sales.manager': ['salesforce.create_case'] },
    });
    for (const skillId of Object.keys(gaps)) {
      const text = String(draft.skills.find((skill: any) => skill.skillId === skillId).instructions);
      assert.match(text, /not allowed for this colleague|cannot raise cases|not allowed to raise cases/i, `${skillId} says what to do when a tool is not allowed`);
    }
  });

  await suite.test('the "view as" preview agrees: a colleague sees the playbooks on demand, a shopper sees none, and every group the pack names is a team the demo load creates (except the reserved administrators)', () => {
    const project = { agents: draft.agents, extensions: draft.extensions, skills: draft.skills, defaultAgentId: draft.defaultAgentId };
    const ids = Object.keys(PLAYBOOKS).sort();
    const csr = buildAccessPreview(project as any, plan.teams, people.csr);
    assert.deepEqual(csr.skills.filter((skill) => ids.includes(skill.skillId)).map((skill) => skill.skillId).sort(), ['account-360', 'branch-stock-check', 'case-queue-review', 'escalated-account-brief', 'order-enquiry', 'overdue-and-invoice-query', 'price-and-stock', 'special-order-handover'].sort());
    assert.ok(csr.skills.filter((skill) => ids.includes(skill.skillId)).every((skill) => skill.tier === 'on_demand' && skill.via === 'row'));
    const shopper = buildAccessPreview(project as any, plan.teams, people.shopper);
    assert.deepEqual(shopper.skills.filter((skill) => ids.includes(skill.skillId)), []);
    assert.equal(shopper.hiddenSkills.filter((skill) => ids.includes(skill.skillId)).length, ids.length, 'the preview shows them as hidden from a shopper');
    for (const who of COLUMNS) assert.deepEqual(buildAccessPreview(project as any, plan.teams, people[who]).unknownGroups, ['administrators'], `${who}: a group the pack names that no team defines`);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
