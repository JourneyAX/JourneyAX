import type { JaxOntologyRelease, SettingDef } from '../../src/model';

/**
 * TEST FIXTURE ONLY. The smallest block that passes the schema and has nothing the release checks would refuse: one thing, one fact, one
 * binding, and every setting the engine reads plus the one freshness limit the fact uses. Every setting is empty (`null`).
 */

/** A setting with no value yet. */
export const emptySetting = (key: string, label: string, kind: SettingDef['kind'], unit: SettingDef['unit'], ownerRole: string): SettingDef => ({ key, label, kind, unit, ownerRole, value: null });

/** The seven settings the engine reads, declared with no value. */
export const engineSettingsFixture: SettingDef[] = [
  emptySetting('timeout.call', 'How long one call to a system may take', 'timeout', 'milliseconds', 'operations'),
  emptySetting('timeout.query', 'How long a whole question may take', 'timeout', 'milliseconds', 'operations'),
  emptySetting('retry.attempts', 'How many times a failed call is repeated', 'retry', 'count', 'operations'),
  emptySetting('retry.delay', 'How long to wait before a failed call is repeated', 'retry', 'milliseconds', 'operations'),
  emptySetting('cooldown.rateLimited', 'How long to leave a system alone after it asked us to slow down', 'retry', 'seconds', 'operations'),
  emptySetting('limit.parallelPerSystem', 'How many calls to one system may run at once', 'limit', 'count', 'operations'),
  emptySetting('evidence.retention', 'How long the evidence behind an answer is kept', 'limit', 'seconds', 'operations'),
];

export const minimalDictionary: JaxOntologyRelease = {
  schemaVersion: '1.0.0',
  ontologyId: 'minimal',
  enabled: true,
  selfConnector: 'jax-iq',
  things: [{
    thing: 'Account', meaning: 'A customer account.', aliases: ['account', 'customer'], group: 'Customer', status: 'active',
    key: { canonical: 'account_number', pattern: '^ACC-\\d{4}$' },
    keyKinds: [{ kind: 'account_number', system: 'ace-erp', evidence: 'real_field', caseRule: 'upper', ready: true }],
    labelFact: 'Account.name', searchFacts: ['Account.name'], defaultFacts: ['Account.name'], expectedIn: ['ace-erp'],
  }],
  facts: [{ fact: 'Account.name', thing: 'Account', label: 'Name', meaning: "The account holder's trading name.", type: 'text', freshnessKind: 'reference', allowStale: true }],
  links: [],
  bindings: [{
    bindingId: 'Account.name@ace-erp.account_balance',
    target: { kind: 'fact', fact: 'Account.name' },
    system: 'ace-erp', tool: 'account_balance',
    args: { accountId: { from: 'key', kind: 'account_number' } },
    select: 'record.name',
    presence: 'required', authority: 'source_of_truth', freshnessKind: 'reference',
    contract: { unit: 'not_applicable', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: 'not_applicable' },
    selfTest: { fixtureId: 'account-erp-ok' },
  }],
  permissionRules: [],
  signalRules: [],
  settings: [...engineSettingsFixture, emptySetting('freshness.reference', 'How old a reference fact may be', 'freshness', 'seconds', 'operations')],
  severities: [],
  stateMaps: [],
  contractChanges: [],
};
