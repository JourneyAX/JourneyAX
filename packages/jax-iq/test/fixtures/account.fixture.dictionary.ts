import type { Binding, JaxOntologyRelease } from '../../src/model';
import { emptySetting, engineSettingsFixture } from './minimal.dictionary';

/**
 * TEST FIXTURE ONLY. The Account example of the build specification (section 3.8), rebuilt as a complete block. Tenant words are allowed
 * in a test folder; the real dictionary is release data. Nothing here is a business value: every setting is empty.
 *
 * Two changes from the example, both on purpose: the settings also hold the seven the engine reads and one freshness limit for every
 * kind the facts use; and the third rule names the Ticket thing (the example named the whole Account, which would have let the support
 * teams read the credit facts).
 *
 * Links lead to things this fixture does not define (Order, Ticket, Deal, Contact, Consignment, Branch): check it as a part, with those
 * named as external.
 */

/** Where the ERP's balance answer puts each fact. Money says "read the currency from the record". */
const erpBalanceFields = {
  creditLimit: { path: 'creditLimit', money: true },
  balance: { path: 'balance', money: true },
  overdue: { path: 'overdue', money: true },
  terms: { path: 'terms', money: false },
  lastPaid: { path: 'lastPaymentAt', money: false },
  tier: { path: 'tier', money: false },
} as const;

const notApplicable = { unit: 'not_applicable', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: 'not_applicable' } as const;

export const accountFixtureDictionary: JaxOntologyRelease = {
  schemaVersion: '1.0.0',
  ontologyId: 'account-example',
  enabled: true,
  selfConnector: 'jax-iq',
  severities: ['watch'],
  things: [{
    thing: 'Account', meaning: 'A customer account: charge (credit terms) or cash.', aliases: ['account', 'customer'],
    group: 'Customer', status: 'active',
    key: { canonical: 'account_number', pattern: '^ACC-\\d{4}$' },
    keyKinds: [
      { kind: 'account_number', system: 'ace-erp', evidence: 'real_field', caseRule: 'upper', ready: true },
      { kind: 'ct_unit_key', system: 'commercetools', evidence: 'real_field', caseRule: 'lower', ready: true },
      { kind: 'sf_account_id', system: 'salesforce', evidence: 'real_field', caseRule: 'as_is', pattern: '^[a-zA-Z0-9]{15,18}$', ready: true },
      { kind: 'sf_account_note', system: 'salesforce', evidence: 'text_note', caseRule: 'upper', ready: true },
      { kind: 'zd_tag', system: 'zendesk', evidence: 'tag', caseRule: 'lower', ready: true },
    ],
    labelFact: 'Account.name', searchFacts: ['Account.name'],
    defaultFacts: ['Account.name', 'Account.owner', 'Account.tier', 'Account.terms', 'Account.balance'],
    expectedIn: ['ace-erp', 'commercetools', 'salesforce'],
  }],
  facts: [
    { fact: 'Account.name', thing: 'Account', label: 'Name', type: 'text', meaning: "The account holder's trading name.", freshnessKind: 'reference', allowStale: true },
    { fact: 'Account.owner', thing: 'Account', label: 'Account owner', type: 'text', meaning: 'The sales rep who owns the account, from the CRM.', freshnessKind: 'reference', allowStale: true },
    { fact: 'Account.tier', thing: 'Account', label: 'Price tier', type: 'enum', enumValues: ['bronze', 'silver', 'gold'], meaning: 'The price tier the ERP prices this account at.', freshnessKind: 'price', allowStale: false },
    { fact: 'Account.terms', thing: 'Account', label: 'Payment terms', type: 'text', meaning: 'When the account must pay, as the ERP writes it.', freshnessKind: 'credit', allowStale: false },
    { fact: 'Account.creditLimit', thing: 'Account', label: 'Credit limit', type: 'money', meaning: 'The most the ERP lets the account owe us.', freshnessKind: 'credit', allowStale: false },
    { fact: 'Account.balance', thing: 'Account', label: 'Balance', type: 'money', meaning: 'What the account owes us today, from the ERP.', freshnessKind: 'credit', allowStale: false, claimClasses: ['catalog_fact'] },
    { fact: 'Account.overdue', thing: 'Account', label: 'Overdue', type: 'money', meaning: 'The part of the balance past its due date, from the ERP.', freshnessKind: 'credit', allowStale: false },
    { fact: 'Account.lastPaid', thing: 'Account', label: 'Last payment', type: 'date', meaning: 'The date of the last payment the ERP recorded.', freshnessKind: 'credit', allowStale: false },
    { fact: 'Account.status', thing: 'Account', label: 'Online status', type: 'text', meaning: 'Whether the online account is active. Not a credit hold.', freshnessKind: 'reference', allowStale: true },
    { fact: 'Account.openOrderCount', thing: 'Account', label: 'Open orders', type: 'number', meaning: 'How many orders are open (see the contract for which).', freshnessKind: 'order', allowStale: false },
  ],
  links: [
    { link: 'Account.orders', from: 'Account', to: 'Order', meaning: 'Orders the account placed.', cardinality: '1:n', rollsUpDivisions: true },
    { link: 'Account.tickets', from: 'Account', to: 'Ticket', meaning: 'Support items for the account.', cardinality: '1:n' },
    { link: 'Account.deals', from: 'Account', to: 'Deal', meaning: 'Sales opportunities.', cardinality: '1:n' },
    { link: 'Account.contacts', from: 'Account', to: 'Contact', meaning: 'People at the account.', cardinality: '1:n' },
    { link: 'Account.consignments', from: 'Account', to: 'Consignment', meaning: 'Deliveries for the account.', cardinality: '1:n' },
    { link: 'Account.homeBranch', from: 'Account', to: 'Branch', meaning: 'The branch that serves it.', cardinality: 'n:1' },
  ],
  bindings: [
    // One ERP call fills six facts: same system, tool and arguments.
    ...Object.entries(erpBalanceFields).map(([name, field]): Binding => ({
      bindingId: `Account.${name}@ace-erp.account_balance`,
      target: { kind: 'fact', fact: `Account.${name}` },
      system: 'ace-erp', tool: 'account_balance',
      args: { accountId: { from: 'key', kind: 'account_number' } },
      select: `record.${field.path}`,
      ...(field.money ? { currencyFrom: 'record.currency' } : {}),
      presence: 'required', authority: 'source_of_truth',
      freshnessKind: name === 'tier' ? 'price' : 'credit',
      contract: field.money
        ? { unit: 'currency amount', currency: 'from_record', tax: 'unknown', asOf: 'retrieved', counts: 'unknown' }
        : notApplicable,
      selfTest: { fixtureId: 'account-erp-ok' },
    })),
    {
      bindingId: 'Account.name@salesforce.get_account', target: { kind: 'fact', fact: 'Account.name' },
      system: 'salesforce', tool: 'get_account', args: { accountId: { from: 'key', kind: 'sf_account_id' } },
      select: 'record.name', presence: 'required', authority: 'source_of_truth', freshnessKind: 'reference',
      contract: notApplicable, selfTest: { fixtureId: 'account-crm-ok' },
    },
    {
      bindingId: 'Account.owner@salesforce.get_account', target: { kind: 'fact', fact: 'Account.owner' },
      system: 'salesforce', tool: 'get_account', args: { accountId: { from: 'key', kind: 'sf_account_id' } },
      select: 'record.owner', presence: 'optional', authority: 'source_of_truth', freshnessKind: 'reference',
      contract: notApplicable, selfTest: { fixtureId: 'account-crm-ok' },
    },
    {
      bindingId: 'Account.status@commercetools.get_account', target: { kind: 'fact', fact: 'Account.status' },
      system: 'commercetools', tool: 'get_account', args: { accountId: { from: 'key', kind: 'ct_unit_key' } },
      select: 'record.status', presence: 'optional', authority: 'source_of_truth', freshnessKind: 'reference',
      contract: { ...notApplicable, counts: "the online business unit's status; not a credit hold" }, selfTest: { fixtureId: 'account-commerce-ok' },
    },
    // The cross-check that shows a disagreement between two systems without replacing the ERP value.
    {
      bindingId: 'Account.creditLimit@commercetools.get_account', target: { kind: 'fact', fact: 'Account.creditLimit' },
      system: 'commercetools', tool: 'get_account', args: { accountId: { from: 'key', kind: 'ct_unit_key' } },
      select: 'record.creditLimit', currencyFrom: 'record.currency', presence: 'optional', authority: 'cross_check', freshnessKind: 'credit',
      contract: { unit: 'currency amount', currency: 'from_record', tax: 'unknown', asOf: 'retrieved', counts: 'unknown' },
    },
    // The open-order count: one status per call. Which states count is for the owner to confirm.
    {
      bindingId: 'Account.openOrderCount@commercetools.order_history#open', target: { kind: 'fact', fact: 'Account.openOrderCount' },
      system: 'commercetools', tool: 'order_history',
      args: { accountId: { from: 'key', kind: 'ct_unit_key' }, status: { from: 'literal', value: 'open' }, limit: { from: 'literal', value: 1 } },
      select: 'total', presence: 'required', authority: 'source_of_truth', freshnessKind: 'order',
      precondition: 'the connector must run with the account kind set to business unit, else the account id means a customer id',
      contract: { unit: 'orders', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: 'orders in state Open and Confirmed (to confirm); this binding is the Open part' },
      selfTest: { fixtureId: 'account-commerce-ok' },
    },
    {
      bindingId: 'Account.orders@commercetools.order_history', target: { kind: 'link', link: 'Account.orders' },
      system: 'commercetools', tool: 'order_history', args: { accountId: { from: 'key', kind: 'ct_unit_key' }, status: { from: 'request', param: 'status' } },
      select: 'records', rows: { path: 'records', keyField: 'orderNumber' }, page: { totalPath: 'total' },
      presence: 'required', authority: 'source_of_truth', freshnessKind: 'order',
      precondition: "as above; one call per unit key: the account's own and its divisions",
      contract: { unit: 'orders', currency: 'not_applicable', tax: 'unknown', asOf: 'retrieved', counts: "newest first, at most the tool's limit" },
      selfTest: { fixtureId: 'account-commerce-ok' },
    },
    {
      bindingId: 'Account.tickets@zendesk.find_tickets', target: { kind: 'link', link: 'Account.tickets' },
      system: 'zendesk', tool: 'find_tickets', args: { tag: { from: 'key', kind: 'zd_tag' }, status: { from: 'request', param: 'status' } },
      select: 'records', rows: { path: 'records', keyField: 'ticketId' }, page: { totalPath: 'total', morePath: 'more' },
      presence: 'required', authority: 'source_of_truth', freshnessKind: 'ticket',
      contract: { unit: 'tickets', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: '"unsolved" means a status below solved: new, open, pending, hold' },
      selfTest: { fixtureId: 'account-support-ok' },
    },
    {
      bindingId: 'Account.deals@salesforce.list_opportunities', target: { kind: 'link', link: 'Account.deals' },
      system: 'salesforce', tool: 'list_opportunities', args: { accountId: { from: 'key', kind: 'sf_account_id' }, stage: { from: 'request', param: 'stage' } },
      select: 'records', rows: { path: 'records', keyField: 'opportunityId' }, page: { totalPath: 'total', morePath: 'more' },
      presence: 'required', authority: 'source_of_truth', freshnessKind: 'deal',
      contract: { unit: 'deals', currency: 'unknown', tax: 'unknown', asOf: 'retrieved', counts: 'open means not closed' },
      selfTest: { fixtureId: 'account-crm-ok' },
    },
    {
      bindingId: 'Account.consignments@ace-erp.list_deliveries', target: { kind: 'link', link: 'Account.consignments' },
      system: 'ace-erp', tool: 'list_deliveries', args: { accountId: { from: 'key', kind: 'account_number' }, status: { from: 'request', param: 'status' } },
      select: 'records', rows: { path: 'records', keyField: 'deliveryId' },
      presence: 'required', authority: 'source_of_truth', freshnessKind: 'fulfilment',
      contract: { unit: 'consignments', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: 'guest deliveries have no account and are not listed' },
      selfTest: { fixtureId: 'account-erp-ok' },
    },
  ],
  permissionRules: [
    {
      ruleId: 'pr-account-credit-see', mode: 'see',
      target: { thing: 'Account', facts: ['Account.balance', 'Account.creditLimit', 'Account.overdue', 'Account.lastPaid'] },
      who: [{ audience: 'staff', groups: ['finance', 'sales-managers', 'leadership'] }],
      note: 'A shopper or another customer never sees these.',
    },
    {
      ruleId: 'pr-account-basic-see', mode: 'see',
      target: { thing: 'Account', facts: ['Account.name', 'Account.owner', 'Account.tier', 'Account.terms', 'Account.status', 'Account.openOrderCount'] },
      who: [{ audience: 'staff', groups: [] }],
    },
    {
      ruleId: 'pr-ticket-see', mode: 'see',
      target: { thing: 'Ticket' },
      who: [{ audience: 'staff', groups: ['customer-service', 'sales', 'sales-managers', 'leadership'] }],
    },
  ],
  settings: [
    ...engineSettingsFixture,
    emptySetting('freshness.credit', 'How old a credit figure may be', 'freshness', 'seconds', 'finance'),
    emptySetting('freshness.price', 'How old a price tier may be', 'freshness', 'seconds', 'finance'),
    emptySetting('freshness.reference', 'How old a reference fact may be', 'freshness', 'seconds', 'operations'),
    emptySetting('freshness.order', 'How old an order fact may be', 'freshness', 'seconds', 'operations'),
    emptySetting('freshness.ticket', 'How old a ticket fact may be', 'freshness', 'seconds', 'service'),
    emptySetting('freshness.deal', 'How old a deal fact may be', 'freshness', 'seconds', 'sales'),
    emptySetting('freshness.fulfilment', 'How old a delivery fact may be', 'freshness', 'seconds', 'operations'),
    emptySetting('credit.useWatch', 'Credit use watch level', 'threshold', 'ratio', 'finance'),
  ],
  stateMaps: [],
  contractChanges: [],
  signalRules: [{
    signalId: 'sig-credit-use', name: 'Credit use', meaning: 'How much of the credit limit the balance uses.', appliesTo: 'Account', severity: 'watch',
    inputs: [
      { name: 'balance', fact: 'Account.balance', maxAge: 'freshness.credit', requireAuthority: 'source_of_truth' },
      { name: 'limit', fact: 'Account.creditLimit', maxAge: 'freshness.credit', requireAuthority: 'source_of_truth' },
    ],
    formula: {
      op: 'compare', cmp: 'gte',
      left: { formula: { op: 'ratio', num: { input: 'balance' }, den: { input: 'limit' } } },
      right: { setting: 'credit.useWatch' },
    },
    settings: ['credit.useWatch'], status: 'draft',
    wording: ['Credit use is at or above the watch level.'],
  }],
};
