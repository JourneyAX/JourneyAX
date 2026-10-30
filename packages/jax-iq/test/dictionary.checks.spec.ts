import './setup/no-world';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import type { ConnectorsExtension } from '@journeyax/business-pack';
import { JaxOntologyReleaseSchema } from '../src/model';
import type { JaxOntologyRelease } from '../src/model';
import { checkDictionary } from '../src/dictionary';
import type { DictionaryCheckContext, DictionaryIssue, DictionaryIssueCode } from '../src/dictionary';
import { DICTIONARY_ISSUE_CODES, severityOf } from '../src/dictionary/issues';
import { ClaimClassSchema } from '../../knowledge/src/claim-classes';
import { accountFixtureDictionary } from './fixtures/account.fixture.dictionary';
import { connectorsFixture } from './fixtures/connectors.fixture';
import { minimalDictionary } from './fixtures/minimal.dictionary';

/**
 * The release checks for a dictionary block. TEST FIXTURE ONLY: every block, connector table and value below is made up for these tests.
 * Each check has a block that breaks it and a block that does not; the golden block of version 1.0.0 is frozen, and nothing the checks
 * learn later may turn it into an error. The last test fails when a finding code has no case here.
 */
const suite = createSuite('jax-iq: dictionary release checks');

const golden: JaxOntologyRelease = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/golden-v1.block.json'), 'utf8'));
const KNOWN_CLASSES: readonly string[] = ClaimClassSchema.options;
/** TEST FIXTURE ONLY: a value for a setting that ships empty. */
const TEST_VALUE = 1;

const clone = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

/** A copy of a block, changed by hand: the tests break blocks in ways the types do not allow. */
const edit = (block: JaxOntologyRelease, change: (draft: any) => void): any => {
  const draft = clone(block);
  change(draft);
  return draft;
};
/** A copy of the connector table, changed by hand. */
const connectorsEdit = (change: (draft: any) => void): ConnectorsExtension => {
  const draft: any = clone(connectorsFixture);
  change(draft);
  return draft;
};
const check = (block: unknown, over: Partial<DictionaryCheckContext> = {}): DictionaryIssue[] => checkDictionary(block, { connectors: connectorsFixture, knownClaimClasses: KNOWN_CLASSES, ...over });

const errorsOf = (issues: DictionaryIssue[]) => issues.filter((issue) => issue.severity === 'error');
const codesOf = (issues: DictionaryIssue[]) => [...new Set(issues.map((issue) => issue.code))].sort();
const pathsOf = (issues: DictionaryIssue[], code: DictionaryIssueCode) => issues.filter((issue) => issue.code === code).map((issue) => issue.path);

const seen = new Set<DictionaryIssueCode>();
/** Asserts a finding with this code (and, when given, this path and a message that matches) is in the list. */
function found(issues: DictionaryIssue[], code: DictionaryIssueCode, at?: string, message?: RegExp): DictionaryIssue {
  const sameCode = issues.filter((issue) => issue.code === code && (at === undefined || issue.path === at));
  assert.ok(sameCode.length > 0, `expected ${code}${at === undefined ? '' : ` at ${at}`}; got ${issues.map((issue) => `${issue.code}@${issue.path}`).join(', ') || 'nothing'}`);
  const hit = message ? sameCode.find((issue) => message.test(issue.message)) : sameCode[0];
  assert.ok(hit, `${code}${at === undefined ? '' : ` at ${at}`}: no message matches ${message}; got ${sameCode.map((issue) => issue.message).join(' | ')}`);
  assert.equal(hit.severity, severityOf(code), `${code} has its one fixed severity`);
  seen.add(code);
  return hit;
}
function absent(issues: DictionaryIssue[], code: DictionaryIssueCode, note = '') {
  assert.deepEqual(pathsOf(issues, code), [], `${code} should not be reported ${note}`);
}

const idx = <T>(items: readonly T[], match: (item: T) => boolean, what = 'item'): number => {
  const found = items.findIndex(match);
  assert.ok(found >= 0, `${what} is in the golden block`);
  return found;
};
const iThing = (name: string) => idx(golden.things, (item) => item.thing === name, name);
const iFact = (name: string) => idx(golden.facts, (item) => item.fact === name, name);
const iLink = (name: string) => idx(golden.links, (item) => item.link === name, name);
const iBinding = (id: string) => idx(golden.bindings, (item) => item.bindingId === id, id);
const iRule = (id: string) => idx(golden.permissionRules, (item) => item.ruleId === id, id);
const iSignal = (id: string) => idx(golden.signalRules, (item) => item.signalId === id, id);
const iSetting = (key: string) => idx(golden.settings, (item) => item.key === key, key);

const BALANCE = iBinding('Account.balance@ace-erp.account_balance');
const ERP_BINDINGS = golden.bindings.map((entry, index) => [entry, index] as const).filter(([entry]) => entry.system === 'ace-erp').map(([, index]) => index);

async function main() {
  // ---- passing fixtures ----

  await suite.test('a passing fixture: the minimal block has no error, and its findings are the warnings for settings that have no value', () => {
    assert.equal(JaxOntologyReleaseSchema.safeParse(minimalDictionary).success, true);
    const issues = check(minimalDictionary);
    assert.deepEqual(errorsOf(issues), []);
    assert.deepEqual(codesOf(issues), ['r9_setting_unset']);
    assert.deepEqual(pathsOf(issues, 'r9_setting_unset'), ['settings[0].value', 'settings[1].value', 'settings[2].value', 'settings[3].value', 'settings[4].value', 'settings[7].value']);
    found(issues, 'r9_setting_unset', 'settings[0].value', /timeout\.call.*no value yet.*default time limit/);
  });

  await suite.test('the frozen golden block of version 1.0.0 still passes: no error, and only the warnings a person is meant to read', () => {
    const issues = check(golden);
    assert.deepEqual(errorsOf(issues), []);
    assert.deepEqual(codesOf(issues), ['r14_state_map_lossy', 'r5_no_source', 'r6_contract_unknown', 'r9_setting_unset']);
    assert.deepEqual(pathsOf(issues, 'r5_no_source'), [iFact('Account.onCreditHold'), iFact('Account.discountRate'), iFact('Order.state')].map((index) => `facts[${index}]`));
    assert.deepEqual(check(JSON.parse(JSON.stringify(golden))), issues, 'read back from text, the same findings');
    assert.deepEqual(check(JaxOntologyReleaseSchema.parse(golden)), issues, 'read back through the schema, the same findings');
  });

  await suite.test('the specification\'s Account example passes as a part once the things it points at are named external, and not otherwise', () => {
    const outside = ['Order', 'Ticket', 'Deal', 'Contact', 'Consignment', 'Branch'];
    assert.deepEqual(errorsOf(check(accountFixtureDictionary, { partial: { external: outside } })), []);
    const whole = errorsOf(check(accountFixtureDictionary));
    assert.deepEqual(codesOf(whole), ['r4_unknown_name']);
    assert.deepEqual(whole.map((issue) => issue.path), ['links[0].to', 'links[1].to', 'links[2].to', 'links[3].to', 'links[4].to', 'links[5].to', 'permissionRules[2].target.thing']);
  });

  // ---- purity and robustness ----

  await suite.test('pure and deterministic: the same input gives the same findings in the same order, and nothing passed in is changed', () => {
    const broken = edit(golden, (draft) => {
      draft.bindings[0].system = 'nowhere';
      draft.bindings[1].tool = 'no_such_tool';
      draft.facts[0].claimClasses = ['made_up'];
      draft.notes = 'See /var/data/notes';
    });
    const classes = [...KNOWN_CLASSES];
    const before = [canonical(broken), canonical(connectorsFixture), canonical(classes)];
    const first = checkDictionary(broken, { connectors: connectorsFixture, knownClaimClasses: classes, partial: { external: ['Order'] } });
    const second = checkDictionary(broken, { connectors: connectorsFixture, knownClaimClasses: classes, partial: { external: ['Order'] } });
    assert.deepEqual(first, second);
    assert.ok(first.length > 4);
    assert.deepEqual([canonical(broken), canonical(connectorsFixture), canonical(classes)], before);
    const external = ['Order'];
    checkDictionary(broken, { connectors: connectorsFixture, knownClaimClasses: classes, partial: { external } });
    assert.deepEqual(external, ['Order'], 'the external list is untouched');
  });

  await suite.test('no clock, no I/O: the five source files read no time, file, network or environment, and hold no address or path', () => {
    const folder = path.resolve(__dirname, '../src/dictionary');
    for (const file of ['merge.ts', 'index-build.ts', 'checks.ts', 'issues.ts', 'index.ts']) {
      const source = readFileSync(path.join(folder, file), 'utf8');
      for (const banned of ['Date.now', 'new Date', 'Math.random', 'process.', "from 'node:", 'fetch(', 'console.', 'setTimeout', 'require(', '/Users/', 'http://', 'https://']) {
        assert.ok(!source.includes(banned), `dictionary/${file} holds '${banned}'`);
      }
    }
  });

  await suite.test('input of any shape gets findings and never an exception', () => {
    const odd: unknown[] = [
      undefined, null, 0, 'text', [], {}, { enabled: false }, { enabled: true },
      { ...clone(golden), permissionRules: [null, 3, 'x', {}, { who: 'nope', scope: 'own_branch' }, { who: [null, 5, 'y'], mode: 7 }] },
      { ...clone(golden), bindings: [null, { contract: 'x' }, { contract: null, bindingId: 7 }, []] },
      { ...clone(golden), contractChanges: [null, 4, {}, { approvedBy: 9 }], signalRules: [null, 'x', { status: 'active' }, { status: 'active', activatedBy: [] }] },
    ];
    for (const input of odd) {
      const issues = check(input);
      assert.ok(Array.isArray(issues));
      assert.ok(issues.every((issue) => issue.code && issue.path !== undefined && issue.message.length > 0 && issue.severity === severityOf(issue.code)));
      assert.ok(errorsOf(issues).length > 0, `${JSON.stringify(input)?.slice(0, 80)} is not a release block`);
    }
    assert.deepEqual(codesOf(check({ enabled: false })).filter((code) => code !== 'schema'), []);
  });

  // ---- the schema, and a block that is switched off ----

  await suite.test('a block that does not pass the schema gets the schema\'s findings, with where they are, and none of the meaning checks', () => {
    const cases: Array<[string, (draft: any) => void, string | undefined]> = [
      ['a wrong schema version', (draft) => { draft.schemaVersion = '2.0.0'; }, 'schemaVersion'],
      ['an unknown key on the block', (draft) => { draft.surprise = 1; }, undefined],
      ['an unknown key on a binding', (draft) => { draft.bindings[0].extra = true; }, 'bindings[0]'],
      ['an enum fact with no values', (draft) => { delete draft.facts[iFact('Account.tier')].enumValues; }, `facts[${iFact('Account.tier')}].enumValues`],
      ['a fact of a type that does not exist', (draft) => { draft.facts[0].type = 'colour'; }, 'facts[0].type'],
      ['a literal number written as a word in a formula', (draft) => { draft.signalRules[0].formula.right = { text: '90' }; }, undefined],
      ['a setting with a value that is not a number', (draft) => { draft.settings[0].value = 'soon'; }, 'settings[0].value'],
    ];
    for (const [label, change, at] of cases) {
      const issues = check(edit(golden, (draft) => { change(draft); draft.bindings[6].system = 'nowhere'; }));
      found(issues, 'schema', at);
      assert.equal(errorsOf(issues).length > 0, true, label);
      absent(issues, 'r1_system_unavailable', `when ${label} stops the meaning checks`);
      assert.ok(issues.filter((issue) => issue.code === 'schema').every((issue) => issue.severity === 'error'), label);
    }
  });

  await suite.test('a block with enabled: false is checked against the schema only', () => {
    const off = edit(golden, (draft) => {
      draft.enabled = false;
      draft.bindings[0].system = 'nowhere';
      draft.bindings[1].tool = 'no_such_tool';
      draft.facts[0].claimClasses = ['made_up'];
      draft.notes = 'Keep it at https://erp.example.test/x';
      draft.settings = [];
    });
    assert.deepEqual(check(off), [], 'a mistake in a block that is off cannot stop a release');
    assert.deepEqual(check(off, { connectors: undefined }), []);
    const brokenShape = edit(off, (draft) => { draft.surprise = 1; draft.permissionRules[0].mode = 'hold'; });
    const issues = check(brokenShape);
    found(issues, 'schema');
    assert.deepEqual(codesOf(issues), ['schema'], 'the schema findings only: not the mode check, not the address check');
    const unsigned = edit(off, (draft) => { draft.contractChanges[0].approvedBy = ''; });
    assert.deepEqual(codesOf(check(unsigned)), ['schema']);
  });

  // ---- R1 to R3: the connectors ----

  await suite.test('R1: a binding must name an enabled connector of the same pack', () => {
    const i = iBinding('Account.name@salesforce.get_account');
    const missing = check(edit(golden, (draft) => { draft.bindings[i].system = 'no-such-connector'; }));
    found(missing, 'r1_system_unavailable', `bindings[${i}].system`, /'no-such-connector'.*not a connector of this pack/);
    absent(missing, 'r2_tool_not_read', 'for a connector that is not there');

    const off = check(edit(golden, (draft) => { Object.assign(draft.bindings[i], { system: 'jax-iq', tool: 'jaxiq_get' }); }));
    found(off, 'r1_system_unavailable', `bindings[${i}].system`, /'jax-iq'.*switched off/);
    absent(off, 'r3_tool_blocked_for_all', 'for a connector that is switched off');

    const none = check(golden, { connectors: undefined });
    assert.deepEqual(pathsOf(none, 'r1_system_unavailable'), golden.bindings.map((_, index) => `bindings[${index}].system`), 'no connector table: nothing can be read');
    assert.deepEqual(pathsOf(check(golden), 'r1_system_unavailable'), []);
  });

  await suite.test('R2: a bound tool must be listed by its connector with sideEffect read; a write tool is refused', () => {
    const i = iBinding('Account.name@salesforce.get_account');
    const unlisted = check(edit(golden, (draft) => { draft.bindings[i].tool = 'no_such_tool'; }));
    found(unlisted, 'r2_tool_not_read', `bindings[${i}].tool`, /'no_such_tool'.*'salesforce' does not list/);

    const j = iBinding('Ticket.status@zendesk.get_ticket');
    const write = check(edit(golden, (draft) => { draft.bindings[j].tool = 'add_ticket_note'; }));
    found(write, 'r2_tool_not_read', `bindings[${j}].tool`, /'add_ticket_note'.*changes something.*read tool only/);
    absent(write, 'r3_tool_blocked_for_all', 'beside the write-tool finding');

    assert.deepEqual(pathsOf(check(golden), 'r2_tool_not_read'), []);
  });

  await suite.test('R3: a warning when no group can ever read through the bound tool, counting "ask first" as no', () => {
    const ownPolicy = (change: (rows: any[]) => void) => connectorsEdit((draft) => { change(draft.policy); });
    const sixPaths = ERP_BINDINGS.map((index) => `bindings[${index}].tool`);

    const noRow = check(golden, { connectors: ownPolicy((rows) => { rows.splice(0, rows.length, ...rows.filter((row) => !(row.connectorId === 'ace-erp' && row.tool === 'account_balance'))); }) });
    found(noRow, 'r3_tool_blocked_for_all', `bindings[${BALANCE}].tool`, /'account_balance'.*blocked.*every group.*never be read/);
    assert.ok(sixPaths.filter((at) => pathsOf(noRow, 'r3_tool_blocked_for_all').includes(at)).length >= 6, 'every binding that uses the tool');
    assert.ok(noRow.filter((issue) => issue.code === 'r3_tool_blocked_for_all').every((issue) => issue.severity === 'warning'));
    assert.deepEqual(errorsOf(noRow), [], 'a warning, not an error');

    for (const state of ['ask', 'blocked']) {
      const set = check(golden, { connectors: ownPolicy((rows) => { rows.filter((row) => row.connectorId === 'ace-erp' && row.tool === 'account_balance').forEach((row) => { row.state = state; }); }) });
      found(set, 'r3_tool_blocked_for_all', `bindings[${BALANCE}].tool`, undefined);
    }

    const oneTeam = check(golden, { connectors: ownPolicy((rows) => { rows.filter((row) => row.connectorId === 'ace-erp' && row.tool === 'account_balance').forEach((row) => { row.groups = ['finance']; }); }) });
    absent(oneTeam, 'r3_tool_blocked_for_all', 'when one team can read');

    const wildcard = check(golden, { connectors: ownPolicy((rows) => {
      rows.splice(0, rows.length, ...rows.filter((row) => row.connectorId !== 'ace-erp'), { connectorId: 'ace-erp', tool: '*', audience: 'staff', groups: ['finance'], state: 'allow' });
    }) });
    absent(wildcard, 'r3_tool_blocked_for_all', 'when a row for every tool of the connector lets a team in');

    const everyone = check(golden, { connectors: ownPolicy((rows) => {
      rows.splice(0, rows.length, ...rows.filter((row) => row.connectorId !== 'ace-erp'), { connectorId: 'ace-erp', tool: 'account_balance', audience: 'shopper', groups: [], state: 'allow' });
    }) });
    absent(everyone, 'r3_tool_blocked_for_all', 'when a row for everyone allows it');

    const strictest = check(golden, { connectors: ownPolicy((rows) => { rows.push({ connectorId: 'ace-erp', tool: 'account_balance', audience: 'staff', groups: [], state: 'blocked' }); }) });
    found(strictest, 'r3_tool_blocked_for_all', `bindings[${BALANCE}].tool`, undefined);

    assert.deepEqual(pathsOf(check(golden), 'r3_tool_blocked_for_all'), [], 'the table of the fixture lets the teams read');
  });

  await suite.test('R10: no binding may reach a connector that uses each person\'s own sign-in', () => {
    const personal = connectorsEdit((draft) => { draft.connectors.find((entry: any) => entry.connectorId === 'ace-erp').connectionScope = 'person'; });
    const issues = check(golden, { connectors: personal });
    assert.deepEqual(pathsOf(issues, 'r10_person_scoped_connector'), ERP_BINDINGS.map((index) => `bindings[${index}].system`));
    found(issues, 'r10_person_scoped_connector', `bindings[${BALANCE}].system`, /'ace-erp'.*own sign-in.*shop's sign-in only/);
    assert.deepEqual(pathsOf(check(golden), 'r10_person_scoped_connector'), []);
  });

  // ---- R4: every name exists ----

  await suite.test('R4: every name used anywhere must be defined, and each finding says where', () => {
    const account = iThing('Account');
    const credit = iSignal('sig-credit-use');
    const attention = iSignal('sig-account-attention');
    const listAt = (draft: any) => draft.signalRules[attention].formula.of[1].of;
    const cases: Array<[string, (draft: any) => void, string, RegExp]> = [
      ['a label fact', (draft) => { draft.things[account].labelFact = 'Account.nothing'; }, `things[${account}].labelFact`, /fact 'Account\.nothing'/],
      ['a search fact', (draft) => { draft.things[account].searchFacts = ['Account.nothing']; }, `things[${account}].searchFacts[0]`, /fact 'Account\.nothing'/],
      ['a default fact', (draft) => { draft.things[account].defaultFacts[1] = 'Account.nothing'; }, `things[${account}].defaultFacts[1]`, /fact 'Account\.nothing'/],
      ['a canonical key kind', (draft) => { draft.things[account].key.canonical = 'no_such_kind'; }, `things[${account}].key.canonical`, /key kind 'no_such_kind'/],
      ['the thing a fact belongs to', (draft) => { draft.facts[0].thing = 'Nothing'; }, 'facts[0].thing', /thing 'Nothing'/],
      ['the end of a link', (draft) => { draft.links[0].to = 'Nothing'; }, 'links[0].to', /thing 'Nothing'/],
      ['the start of a link', (draft) => { draft.links[0].from = 'Nothing'; }, 'links[0].from', /thing 'Nothing'/],
      ['a link in a path', (draft) => { draft.links[iLink('Account.orderTickets')].via[0] = 'Account.nothing'; }, `links[${iLink('Account.orderTickets')}].via[0]`, /link 'Account\.nothing'/],
      ['the inverse of a link', (draft) => { draft.links[0].inverse = 'Order.nothing'; }, 'links[0].inverse', /link 'Order\.nothing'/],
      ['the fact a binding fills', (draft) => { draft.bindings[0].target = { kind: 'fact', fact: 'Account.nothing' }; }, 'bindings[0].target.fact', /fact 'Account\.nothing'/],
      ['the link a binding fills', (draft) => { draft.bindings[iBinding('Account.orders@commercetools.order_history')].target = { kind: 'link', link: 'Account.nothing' }; }, `bindings[${iBinding('Account.orders@commercetools.order_history')}].target.link`, /link 'Account\.nothing'/],
      ['a key kind in an argument', (draft) => { draft.bindings[0].args.accountId = { from: 'key', kind: 'no_such_kind' }; }, 'bindings[0].args.accountId.kind', /key kind 'no_such_kind'/],
      ['a state map', (draft) => { draft.bindings[iBinding('Ticket.status@zendesk.get_ticket')].stateMap = 'no-such-map'; }, `bindings[${iBinding('Ticket.status@zendesk.get_ticket')}].stateMap`, /state map 'no-such-map'/],
      ['the thing of a rule', (draft) => { draft.permissionRules[iRule('pr-ticket-see')].target.thing = 'Nothing'; }, `permissionRules[${iRule('pr-ticket-see')}].target.thing`, /thing 'Nothing'/],
      ['a fact of a rule', (draft) => { draft.permissionRules[0].target.facts[0] = 'Account.nothing'; }, 'permissionRules[0].target.facts[0]', /fact 'Account\.nothing'/],
      ['the thing a signal applies to', (draft) => { draft.signalRules[credit].appliesTo = 'Nothing'; }, `signalRules[${credit}].appliesTo`, /thing 'Nothing'/],
      ['the severity of a signal', (draft) => { draft.signalRules[credit].severity = 'critical'; }, `signalRules[${credit}].severity`, /severity 'critical'/],
      ['an input fact of a signal', (draft) => { draft.signalRules[credit].inputs[0].fact = 'Account.nothing'; }, `signalRules[${credit}].inputs[0].fact`, /fact 'Account\.nothing'/],
      ['the age setting of a signal input', (draft) => { draft.signalRules[credit].inputs[0].maxAge = 'freshness.nothing'; }, `signalRules[${credit}].inputs[0].maxAge`, /setting 'freshness\.nothing'/],
      ['a setting a signal lists', (draft) => { draft.signalRules[credit].settings = ['credit.nothing']; }, `signalRules[${credit}].settings[0]`, /setting 'credit\.nothing'/],
      ['a setting a formula reads', (draft) => { draft.signalRules[credit].formula.right.setting = 'credit.nothing'; }, `signalRules[${credit}].formula`, /setting 'credit\.nothing'/],
      ['an input a formula reads', (draft) => { draft.signalRules[credit].formula.left.formula.num.input = 'nothing'; }, `signalRules[${credit}].formula`, /signal input 'nothing'/],
      ['a dotted name that is not one of the inputs', (draft) => { draft.signalRules[credit].formula.left.formula.num.input = 'Account.balance'; }, `signalRules[${credit}].formula`, /signal input 'Account\.balance'/],
      ['the link a list is read over', (draft) => { listAt(draft).over = 'Account.nothing'; }, `signalRules[${attention}].formula`, /link 'Account\.nothing'/],
      ['an item fact inside a list that does not exist', (draft) => { listAt(draft).where.of.input = 'Ticket.nothing'; }, `signalRules[${attention}].formula`, /fact 'Ticket\.nothing'/],
      ['an item fact inside a list written without its thing', (draft) => { listAt(draft).where.of.input = 'dueBy'; }, `signalRules[${attention}].formula`, /must be a fact of the thing the link leads to/],
      ['the fact or link of a contract change', (draft) => { draft.contractChanges[0].factOrLink = 'Account.nothing'; }, 'contractChanges[0].factOrLink', /fact or link 'Account\.nothing'/],
    ];
    assert.deepEqual(pathsOf(check(golden), 'r4_unknown_name'), []);
    for (const [label, change, at, message] of cases) {
      const hit = found(check(edit(golden, change)), 'r4_unknown_name', at, message);
      assert.equal(hit.severity, 'error', label);
    }
  });

  await suite.test('R4: a name that exists but belongs to another thing is a mismatch, not a missing name', () => {
    const attention = iSignal('sig-account-attention');
    const cases: Array<[string, (draft: any) => void, string, RegExp]> = [
      ['a fact that says it belongs to another thing', (draft) => { draft.facts[0].thing = 'Ticket'; }, 'facts[0].fact', /'Account\.name'.*belongs to 'Account' but its thing is 'Ticket'/],
      ['a link that starts at another thing', (draft) => { draft.links[iLink('Account.tickets')].from = 'Ticket'; }, `links[${iLink('Account.tickets')}].link`, /'Account\.tickets'.*starts at 'Account' but starts at 'Ticket'/],
      ['a rule that names a fact of another thing', (draft) => { draft.permissionRules[0].target.facts[0] = 'Ticket.status'; }, 'permissionRules[0].target.facts[0]', /about 'Account' but names the fact 'Ticket\.status'/],
      ['an item fact of the wrong thing inside a list', (draft) => { draft.signalRules[attention].formula.of[1].of.where.of.input = 'Account.name'; }, `signalRules[${attention}].formula`, /'Account\.name'.*fact of 'Ticket'/],
    ];
    for (const [label, change, at, message] of cases) {
      const issues = check(edit(golden, change));
      found(issues, 'r4_name_mismatch', at, message);
      assert.ok(issues.filter((issue) => issue.code === 'r4_name_mismatch').every((issue) => issue.severity === 'error'), label);
    }
    absent(check(golden), 'r4_name_mismatch');
  });

  await suite.test('a thing, fact, link, binding, rule, signal, setting or state map defined twice is a duplicate_id error at the second one', () => {
    const issues = check(edit(golden, (draft) => {
      draft.things.push(clone(draft.things[0]));
      draft.facts.push(clone(draft.facts[0]));
      draft.links.push(clone(draft.links[0]));
      draft.bindings.push(clone(draft.bindings[0]));
      draft.permissionRules.push(clone(draft.permissionRules[0]));
      draft.signalRules.push(clone(draft.signalRules[0]));
      draft.settings.push(clone(draft.settings[0]));
      draft.stateMaps.push(clone(draft.stateMaps[0]));
    }));
    const at = (field: string, list: unknown[]) => `${field}[${list.length}]`;
    assert.deepEqual(pathsOf(issues, 'duplicate_id'), [
      at('things', golden.things), at('facts', golden.facts), at('links', golden.links), at('bindings', golden.bindings),
      at('permissionRules', golden.permissionRules), at('signalRules', golden.signalRules), at('settings', golden.settings), at('stateMaps', golden.stateMaps),
    ]);
    found(issues, 'duplicate_id', at('things', golden.things), /thing 'Account' is defined more than once/);
    assert.deepEqual(pathsOf(check(golden), 'duplicate_id'), []);
  });

  // ---- R5, R6 ----

  await suite.test('R5: a source of truth needs a self test; a fact with no binding is listed; an active thing with no binding is an error', () => {
    const noTest = check(edit(golden, (draft) => { delete draft.bindings[BALANCE].selfTest; }));
    found(noTest, 'r5_no_self_test', `bindings[${BALANCE}].selfTest`, /source of truth.*self test.*fixture/);
    const cross = iBinding('Account.creditLimit@commercetools.get_account');
    assert.equal(golden.bindings[cross].authority, 'cross_check');
    assert.equal(golden.bindings[cross].selfTest, undefined);
    assert.deepEqual(pathsOf(check(golden), 'r5_no_self_test'), [], 'a cross-check needs none');

    const orderState = iFact('Order.state');
    found(check(golden), 'r5_no_source', `facts[${orderState}]`, /'Order\.state' has no binding.*"no source"/);

    const active = check(edit(golden, (draft) => { draft.things[iThing('Order')].status = 'active'; }));
    found(active, 'r5_active_thing_unbound', `things[${iThing('Order')}].status`, /'Order' is marked active but nothing is bound to it/);
    absent(check(golden), 'r5_active_thing_unbound', 'for a thing marked modelled only');

    const unbound = check(edit(golden, (draft) => { draft.bindings = draft.bindings.filter((entry: any) => !entry.bindingId.startsWith('Ticket.')); }));
    found(unbound, 'r5_active_thing_unbound', `things[${iThing('Ticket')}].status`, /'Ticket'/);
    const linkOnly = check(edit(golden, (draft) => { draft.bindings = draft.bindings.filter((entry: any) => !entry.bindingId.startsWith('Account.') || entry.target.kind === 'link'); }));
    absent(linkOnly, 'r5_active_thing_unbound', 'for a thing whose only bindings are links');
  });

  await suite.test('R6: a contract states all five lines, and what is still unknown is listed as a warning', () => {
    const blank = check(edit(golden, (draft) => { draft.bindings[BALANCE].contract.counts = ''; }));
    found(blank, 'r6_contract_incomplete', `bindings[${BALANCE}].contract`, /does not state all five lines.*Missing: counts.*'unknown' is allowed; a blank is not/);
    found(blank, 'schema');
    const missingTwo = check(edit(golden, (draft) => { delete draft.bindings[BALANCE].contract.unit; draft.bindings[BALANCE].contract.tax = '  '; }));
    found(missingTwo, 'r6_contract_incomplete', `bindings[${BALANCE}].contract`, /Missing: unit, tax\./);
    const noContract = check(edit(golden, (draft) => { delete draft.bindings[BALANCE].contract; }));
    found(noContract, 'r6_contract_incomplete', `bindings[${BALANCE}].contract`, /Missing: unit, currency, tax, asOf, counts/);

    const unknown = check(edit(golden, (draft) => { Object.assign(draft.bindings[BALANCE].contract, { unit: 'unknown', currency: 'unknown', tax: 'unknown', counts: 'unknown' }); }));
    found(unknown, 'r6_contract_unknown', `bindings[${BALANCE}].contract`, /unit, currency, tax, counts are unknown\. Someone has to decide/);
    const one = check(edit(golden, (draft) => { Object.assign(draft.bindings[BALANCE].contract, { unit: 'currency amount', currency: 'from_record', tax: 'excludes_tax', counts: 'all of it' }); }));
    assert.equal(pathsOf(one, 'r6_contract_unknown').includes(`bindings[${BALANCE}].contract`), false, 'a binding that states every line is not listed');
    assert.equal(pathsOf(check(golden), 'r6_contract_unknown').includes(`bindings[${BALANCE}].contract`), true, 'the same binding in the frozen block is listed');
    const notApplicable = check(edit(golden, (draft) => { Object.assign(draft.bindings[BALANCE].contract, { unit: 'not_applicable', currency: 'not_applicable', tax: 'not_applicable', counts: 'not_applicable' }); }));
    assert.equal(pathsOf(notApplicable, 'r6_contract_unknown').includes(`bindings[${BALANCE}].contract`), false, '"not applicable" is an answer');
    assert.deepEqual(pathsOf(check(golden), 'r6_contract_incomplete'), []);
  });

  // ---- R8, R9 ----

  await suite.test('R8: an active signal reads only settings that hold a value, and says who switched it on and when; a draft may leave them empty', () => {
    const old = iSignal('sig-old-urgent-ticket');
    const age = iSetting('ticket.highPriorityAge');
    assert.notEqual(golden.settings[age].value, null, 'the frozen block holds a value for the active signal');
    assert.deepEqual(pathsOf(check(golden), 'r8_signal_setting_unset'), []);

    const empty = check(edit(golden, (draft) => { draft.settings[age].value = null; }));
    found(empty, 'r8_signal_setting_unset', `signalRules[${old}].status`, /'sig-old-urgent-ticket'.*'ticket\.highPriorityAge'.*no value yet/);
    const onlyInFormula = check(edit(golden, (draft) => { draft.settings[age].value = null; draft.signalRules[old].settings = []; }));
    found(onlyInFormula, 'r8_signal_setting_unset', `signalRules[${old}].status`, /'ticket\.highPriorityAge'/);

    const credit = iSignal('sig-credit-use');
    const switchedOn = (value: number | null) => check(edit(golden, (draft) => {
      Object.assign(draft.signalRules[credit], { status: 'active', activatedBy: 'Test Approver', activatedAt: '2026-10-29T09:30:00Z' });
      draft.settings[iSetting('credit.useWatch')].value = value;
    }));
    found(switchedOn(null), 'r8_signal_setting_unset', `signalRules[${credit}].status`, /'credit\.useWatch'/);
    assert.deepEqual(pathsOf(switchedOn(TEST_VALUE), 'r8_signal_setting_unset'), [], 'the draft signal with the same empty setting is fine, and so is the same signal once it has a value');

    for (const missing of ['activatedBy', 'activatedAt']) {
      const unsigned = check(edit(golden, (draft) => { delete draft.signalRules[old][missing]; }));
      found(unsigned, 'r8_signal_unsigned', `signalRules[${old}].status`, /'sig-old-urgent-ticket'.*does not say who switched it on and when/);
      found(unsigned, 'schema');
    }
    const blankName = check(edit(golden, (draft) => { draft.signalRules[old].activatedBy = '   '; }));
    found(blankName, 'r8_signal_unsigned', `signalRules[${old}].status`, undefined);
    assert.deepEqual(pathsOf(check(golden), 'r8_signal_unsigned'), []);
  });

  await suite.test('R9: a timeout, retry or freshness setting with no value is a warning that says what happens meanwhile; other kinds are not listed', () => {
    const issues = check(golden);
    const settingAt = (key: string) => `settings[${iSetting(key)}].value`;
    found(issues, 'r9_setting_unset', settingAt('timeout.query'), /'timeout\.query'.*default time limit of the connector client applies/);
    found(issues, 'r9_setting_unset', settingAt('retry.attempts'), /'retry\.attempts'.*not repeated.*no cool-down/);
    found(issues, 'r9_setting_unset', settingAt('cooldown.rateLimited'), /not repeated/);
    found(issues, 'r9_setting_unset', settingAt('freshness.credit'), /'freshness\.credit'.*nothing is kept between questions.*asks the system again/);
    for (const key of ['limit.parallelPerSystem', 'evidence.retention', 'credit.useWatch', 'ticket.pileUp']) {
      assert.equal(pathsOf(issues, 'r9_setting_unset').includes(settingAt(key)), false, `${key} is not a timeout, retry or freshness setting`);
    }
    const set = check(edit(golden, (draft) => { draft.settings[iSetting('timeout.call')].value = TEST_VALUE; }));
    assert.equal(pathsOf(set, 'r9_setting_unset').includes(settingAt('timeout.call')), false, 'a setting with a value is not listed');
    assert.equal(pathsOf(set, 'r9_setting_unset').length, pathsOf(issues, 'r9_setting_unset').length - 1);
    assert.ok(issues.filter((issue) => issue.code === 'r9_setting_unset').every((issue) => issue.severity === 'warning'));
  });

  // ---- R11 ----

  await suite.test('R11: a rule limited to a branch, to the accounts a person owns or to a company is refused, and so is any clause for people who are not staff', () => {
    const scopes: Array<[string, RegExp]> = [['own_branch', /own branch.*cannot be enforced/], ['owned_by_me', /accounts the person owns.*cannot be enforced/], ['own_company', /own company.*staff only/]];
    for (const [scope, message] of scopes) {
      const issues = check(edit(golden, (draft) => { draft.permissionRules[0].scope = scope; }));
      found(issues, 'r11_scope_refused', 'permissionRules[0].scope', message);
      found(issues, 'schema');
    }
    const clauses: Array<[string, any]> = [
      ['a company member', { audience: 'company_member', roles: ['buyer'] }],
      ['everyone', { audience: 'everyone' }],
      ['a shopper', { audience: 'shopper', groups: [] }],
      ['staff with company roles', { audience: 'staff', groups: [], roles: ['buyer'] }],
    ];
    for (const [label, clause] of clauses) {
      const issues = check(edit(golden, (draft) => { draft.permissionRules[0].who[1] = clause; }));
      found(issues, 'r11_clause_refused', 'permissionRules[0].who[1]', /names people who are not staff.*staff only/);
      assert.equal(pathsOf(issues, 'r11_clause_refused').length, 1, label);
    }
    assert.deepEqual(pathsOf(check(golden), 'r11_clause_refused').concat(pathsOf(check(golden), 'r11_scope_refused')), []);
  });

  // ---- R12 ----

  await suite.test('R12: a file path, a web address, a network address or a secret anywhere in the block is refused, without repeating it', () => {
    const places: Array<[string, (draft: any, text: string) => void, string]> = [
      ['the notes', (draft, text) => { draft.notes = text; }, 'notes'],
      ['a thing', (draft, text) => { draft.things[0].meaning = text; }, 'things[0].meaning'],
      ['a fact', (draft, text) => { draft.facts[0].meaning = text; }, 'facts[0].meaning'],
      ['a precondition', (draft, text) => { draft.bindings[0].precondition = text; }, 'bindings[0].precondition'],
      ['a literal argument', (draft, text) => { draft.bindings[0].args.accountId = { from: 'literal', value: text }; }, 'bindings[0].args.accountId.value'],
      ['a rule note', (draft, text) => { draft.permissionRules[0].note = text; }, 'permissionRules[0].note'],
      ['a wording line', (draft, text) => { draft.signalRules[0].wording[0] = text; }, 'signalRules[0].wording[0]'],
    ];
    const paths = ['Keep a copy in /var/data/accounts.json', 'Saved under ~/exports', 'Look in ./exports/today', 'Saved to C:\\exports\\today', 'Shared at \\\\fileserver\\share', 'Read "/etc/hosts"'];
    const addresses = ['Read it from https://erp.example.test/api', 'Reach it at www.example.test', 'Runs on localhost', 'Sits at 10.20.30.40', 'Served by erp.internal:8080', 'Uses ftp://files.example.test'];
    const secrets = [
      'Authorization: Bearer abcdefgh12345678', 'password: hunter2', 'api_key=abc123', 'sk-abcdefghijklmnopqrstuvwx', 'AKIAABCDEFGHIJKLMNOP',
      'ghp_abcdefghijklmnopqrstuvwxyz0123', 'eyJabcdefgh.eyJabcdefgh.abcdefghij', '0123456789abcdef0123456789abcdef', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXc',
      'tenant-secret://shop/live/key', '-----BEGIN PRIVATE KEY-----',
    ];
    for (const [where, put, at] of places) {
      for (const text of paths) found(check(edit(golden, (draft) => put(draft, text))), 'r12_path', at, /file path/);
      for (const text of addresses) found(check(edit(golden, (draft) => put(draft, text))), 'r12_address', at, /web address/);
      for (const text of secrets) {
        const hit = found(check(edit(golden, (draft) => put(draft, text))), 'r12_secret', at, /secret or a key/);
        assert.ok(!hit.message.includes(text), `${where}: the finding does not repeat the secret`);
      }
    }
    const one = check(edit(golden, (draft) => { draft.notes = 'password: hunter2 at https://erp.example.test/api and /var/data'; }));
    assert.deepEqual(pathsOf(one, 'r12_secret'), ['notes']);
    assert.deepEqual([...pathsOf(one, 'r12_address'), ...pathsOf(one, 'r12_path')], [], 'one text gives one finding, the most serious');
  });

  await suite.test('R12: ordinary words, ids and numbers are not mistaken for paths, addresses or secrets, and a key pattern may hold slashes', () => {
    const fine = [
      'Orders and/or tickets, due on the 20th of the month, three-quarters (3/4) of the limit',
      'Version 1.2.3 of the ruleset; ratio 0.9; at 09:30',
      'e.g. order ORD-100042 on account ACC-0001, ticket TCK-9',
      'Internationalisationandlocalisationofthedictionaryentries',
      'Use the account number, not the name',
      'Open / closed',
    ];
    for (const text of fine) {
      const issues = check(edit(golden, (draft) => { draft.notes = text; draft.things[0].meaning = text.slice(0, 300); draft.signalRules[0].wording[0] = text.slice(0, 300); }));
      assert.deepEqual([...pathsOf(issues, 'r12_path'), ...pathsOf(issues, 'r12_address'), ...pathsOf(issues, 'r12_secret')], [], text);
    }
    const patterns = check(edit(golden, (draft) => { draft.things[0].key.pattern = '/acc-\\d+'; draft.things[0].keyKinds[1].pattern = '/acc-\\d+/x'; }));
    assert.deepEqual([...pathsOf(patterns, 'r12_path'), ...pathsOf(patterns, 'r12_address'), ...pathsOf(patterns, 'r12_secret')], [], 'a regular expression written as text is not a path');
    const inText = check(edit(golden, (draft) => { draft.things[0].meaning = '/acc-\\d+ is the pattern'; }));
    found(inText, 'r12_path', 'things[0].meaning');
    const names = check(edit(golden, (draft) => { draft.facts[0].label = 'Name'; }));
    assert.deepEqual(pathsOf(names, 'r12_path'), [], 'only what is written is scanned');
  });

  await suite.test('R12: a file path written into a key pattern is refused like any other text, while a pattern that is only a pattern is not', () => {
    const fields: Array<[string, (draft: any, text: string) => void]> = [
      ['things[0].key.pattern', (draft, text) => { draft.things[0].key.pattern = text; }],
      ['things[0].keyKinds[1].pattern', (draft, text) => { draft.things[0].keyKinds[1].pattern = text; }],
      ['things[0].keyKinds[2].pattern', (draft, text) => { draft.things[0].keyKinds[2].pattern = text; }],
      ['things[1].key.pattern', (draft, text) => { draft.things[1].key.pattern = text; }],
      ['things[2].key.pattern', (draft, text) => { draft.things[2].key.pattern = text; }],
    ];
    const paths = [
      '/Users/someone/private/file.txt', 'see /etc/passwd now', '^/Users/someone/secret$', '(/etc/passwd)', '~/.ssh/id_rsa', '../../etc/passwd', '^/etc$',
      '^\\/Users\\/someone\\/secret$', 'C:\\Users\\someone\\file.txt', 'C:\\\\Users\\\\someone', '\\\\\\\\fileserver\\\\share',
    ];
    const patterns = [
      '^ACC-\\d{4}$', '^[a-zA-Z0-9]{15,18}$', '^(?:ACC|CUS)-\\d{4}$', '/acc-\\d+', '/acc-\\d+/x', '^acc\\/\\d+$', '^ACC/2026/X\\d+$', '^[A-Z]/2026/X$',
      '^ACC:\\d+$', '^X:\\d{4}$', '^.{3}/\\d+$', '^ACC\\\\d$',
    ];
    // The second half of each list is the same address or secret written with regex escapes, which match the same characters.
    const addresses = [
      'https://erp.example.test/api', 'www.example.test', '10.20.30.40', 'erp.internal:8080',
      '^https:\\/\\/erp\\.example\\.test\\/api$', 'www\\.example\\.test', '^10\\.20\\.30\\.40$', '^erp\\.internal:8080$', 'ftp:\\/\\/files\\.example\\.test',
    ];
    const secrets = [
      'sk-abcdefghijklmnopqrstuvwx', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXc',
      '^sk\\-abcdefghijklmnopqrstuvwx$', 'Bearer\\ abcdefgh12345678', 'api_key\\=abc123', '^eyJabcdefgh\\.eyJabcdefgh\\.abcdefghij$', 'tenant\\-secret:',
    ];
    const refused = (issues: DictionaryIssue[]) => [...pathsOf(issues, 'r12_path'), ...pathsOf(issues, 'r12_address'), ...pathsOf(issues, 'r12_secret')];
    for (const [at, put] of fields) {
      for (const text of paths) {
        const issues = check(edit(golden, (draft) => put(draft, text)));
        absent(issues, 'schema', `for the pattern ${text}`);
        found(issues, 'r12_path', at, /file path/);
        assert.deepEqual(refused(issues), [at], `${text}: one finding, at the pattern`);
      }
      for (const text of patterns) {
        const issues = check(edit(golden, (draft) => put(draft, text)));
        absent(issues, 'schema', `for the pattern ${text}`);
        assert.deepEqual(refused(issues), [], `${at}: ${text} is only a pattern`);
      }
      for (const text of addresses) {
        const issues = check(edit(golden, (draft) => put(draft, text)));
        found(issues, 'r12_address', at, /web address/);
        assert.deepEqual(refused(issues), [at], `${text}: one finding, at the pattern`);
      }
      for (const text of secrets) {
        const issues = check(edit(golden, (draft) => put(draft, text)));
        const hit = found(issues, 'r12_secret', at, /secret or a key/);
        assert.ok(!hit.message.includes(text.replace(/\\([^A-Za-z0-9])/g, '$1')), `${text}: the finding does not repeat the secret`);
        assert.deepEqual(refused(issues), [at], `${text}: one finding, at the pattern`);
      }
    }
    assert.deepEqual(refused(check(golden)), [], 'the frozen golden block and its patterns are untouched');
    const partial = check(edit(golden, (draft) => { draft.things[0].key.pattern = '/Users/someone/private/file.txt'; }), { partial: { external: [] } });
    found(partial, 'r12_path', 'things[0].key.pattern');
  });

  await suite.test('R12: a time with a fraction of a second and a signed zone is a time, not a network address, wherever it is written; a host with a port still is an address', () => {
    const times = [
      '2026-10-29T09:30:00Z', '2026-10-29T09:30:00.123Z', '2026-10-29T09:30:00+13:00', '2026-10-29T09:30:00.123+13:00', '2026-10-29T09:30:00-05:00',
      '2026-10-29T09:30:00.123-05:00', '2026-10-29T09:30:00.5-08:00', '2026-10-29T09:30:00.123456-03:30',
    ];
    const urgent = iSignal('sig-old-urgent-ticket');
    assert.equal(golden.signalRules[urgent].status, 'active');
    const refused = (issues: DictionaryIssue[]) => [...pathsOf(issues, 'r12_path'), ...pathsOf(issues, 'r12_address'), ...pathsOf(issues, 'r12_secret')];
    for (const time of times) {
      const change = check(edit(golden, (draft) => { draft.contractChanges[0].approvedAt = time; }));
      absent(change, 'schema', `for ${time}`);
      assert.deepEqual(errorsOf(change), [], `${time} as the time a contract change was approved`);
      const signal = check(edit(golden, (draft) => { draft.signalRules[urgent].activatedAt = time; }));
      absent(signal, 'schema', `for ${time}`);
      assert.deepEqual(errorsOf(signal), [], `${time} as the time a signal was switched on`);
      const inText = check(edit(golden, (draft) => { draft.notes = `Approved at ${time} by the board.`; }));
      assert.deepEqual(refused(inText), [], `${time} inside a sentence`);
    }
    assert.deepEqual(refused(check(edit(golden, (draft) => { draft.notes = 'Ratio 0.9:10 of the limit'; }))), [], 'a ratio has no host name in it');
    for (const text of ['Served by erp.internal:8080', 'Reach host-1.example.test:8443', 'a.b.c:443', 'Runs at r2.d2:8080', 'Sits at 10.20.30.40:8080', 'Seen on ERP.Internal:80.']) {
      found(check(edit(golden, (draft) => { draft.notes = text; })), 'r12_address', 'notes', /web address/);
    }
    const mixed = check(edit(golden, (draft) => { draft.notes = 'Approved at 2026-10-29T09:30:00.123-05:00 on erp.internal:8080'; }));
    assert.deepEqual(pathsOf(mixed, 'r12_address'), ['notes'], 'a time beside a real host still gives the host away');
  });

  // ---- R13, R14 ----

  await suite.test('R13: a claim class must be one the reply checker knows', () => {
    const balance = iFact('Account.balance');
    assert.deepEqual(golden.facts[balance].claimClasses, ['catalog_fact']);
    assert.deepEqual(pathsOf(check(golden), 'r13_claim_class_unknown'), []);
    const unknown = check(edit(golden, (draft) => { draft.facts[balance].claimClasses = ['catalog_fact', 'made_up_class']; }));
    found(unknown, 'r13_claim_class_unknown', `facts[${balance}].claimClasses[1]`, /'made_up_class'.*'Account\.balance'.*not one the reply checker knows/);
    assert.deepEqual(pathsOf(unknown, 'r13_claim_class_unknown'), [`facts[${balance}].claimClasses[1]`]);
    for (const name of KNOWN_CLASSES) {
      assert.deepEqual(pathsOf(check(edit(golden, (draft) => { draft.facts[balance].claimClasses = [name]; })), 'r13_claim_class_unknown'), [], name);
    }
    found(check(golden, { knownClaimClasses: [] }), 'r13_claim_class_unknown', `facts[${balance}].claimClasses[0]`);
  });

  await suite.test('R14: a state map that loses information is listed, with what it merges', () => {
    const lossy = found(check(golden), 'r14_state_map_lossy', 'stateMaps[0]', /'ticket-status-open' loses information/);
    assert.match(lossy.message, /'new', 'open', 'pending', 'hold' all become 'open'/);
    assert.match(lossy.message, /'solved', 'closed' all become 'closed'/);
    const hidden = check(edit(golden, (draft) => { draft.stateMaps[0].table = [{ from: 'new', to: 'fresh' }, { from: 'solved', to: 'done' }]; }));
    found(hidden, 'r14_state_map_lossy', 'stateMaps[0]', /the table does not show/);
    const clean = check(edit(golden, (draft) => { draft.stateMaps[0].lossy = false; }));
    absent(clean, 'r14_state_map_lossy', 'for a map that says it loses nothing');
  });

  // ---- the checks this build adds ----

  await suite.test('a freshness kind a fact or a binding names must have its freshness.<kind> setting', () => {
    const credit = iSetting('freshness.credit');
    const firstUser = golden.facts.findIndex((entry) => entry.freshnessKind === 'credit');
    const issues = check(edit(golden, (draft) => { draft.settings.splice(credit, 1); }));
    found(issues, 'freshness_setting_missing', `facts[${firstUser}].freshnessKind`, /freshness kind 'credit'.*no setting 'freshness\.credit'/);
    assert.equal(pathsOf(issues, 'freshness_setting_missing').length, 1, 'once per kind');

    const bindingOnly = check(edit(golden, (draft) => { draft.bindings[0].freshnessKind = 'brandnew'; }));
    found(bindingOnly, 'freshness_setting_missing', 'bindings[0].freshnessKind', /'brandnew'.*'freshness\.brandnew'/);
    absent(check(edit(golden, (draft) => { draft.bindings[0].freshnessKind = 'brandnew'; draft.settings.push({ ...clone(draft.settings[credit]), key: 'freshness.brandnew' }); })), 'freshness_setting_missing', 'once the setting is declared');
    assert.deepEqual(pathsOf(check(golden), 'freshness_setting_missing'), []);
  });

  await suite.test('every setting the engine reads must be declared by the dictionary', () => {
    for (const name of ['timeout.call', 'timeout.query', 'retry.attempts', 'retry.delay', 'cooldown.rateLimited', 'limit.parallelPerSystem', 'evidence.retention']) {
      const issues = check(edit(golden, (draft) => { draft.settings = draft.settings.filter((entry: any) => entry.key !== name); }));
      found(issues, 'engine_setting_missing', 'settings', new RegExp(`'${name.replace('.', '\\.')}'.*read by the engine`));
      assert.equal(pathsOf(issues, 'engine_setting_missing').length, 1, name);
    }
    assert.deepEqual(pathsOf(check(golden), 'engine_setting_missing'), []);
    assert.equal(pathsOf(check(edit(golden, (draft) => { draft.settings = draft.settings.filter((entry: any) => !entry.key.includes('.')); })), 'engine_setting_missing').length, 7);
  });

  await suite.test('claim classes on the tools of the block\'s own connector need claimGuard.figures: withhold', () => {
    const withClasses = connectorsEdit((draft) => {
      const own = draft.connectors.find((entry: any) => entry.connectorId === 'jax-iq');
      own.tools.find((tool: any) => tool.name === 'jaxiq_get').claimClasses = ['catalog_fact'];
      own.tools.find((tool: any) => tool.name === 'jaxiq_find').claimClasses = ['stock'];
    });
    assert.deepEqual(golden.claimGuard, { figures: 'off' });
    const off = check(golden, { connectors: withClasses });
    found(off, 'claim_class_needs_guard', 'claimGuard.figures', /'jaxiq_find', 'jaxiq_get' of 'jax-iq' list claim classes.*figures is 'withhold'/);
    const unset = check(edit(golden, (draft) => { delete draft.claimGuard; }), { connectors: withClasses });
    found(unset, 'claim_class_needs_guard', 'claimGuard.figures');
    absent(check(edit(golden, (draft) => { draft.claimGuard = { figures: 'withhold' }; }), { connectors: withClasses }), 'claim_class_needs_guard', 'with figures withheld');
    absent(check(edit(golden, (draft) => { delete draft.claimGuard; })), 'claim_class_needs_guard', 'when no tool of the own connector lists a class (the other connectors do)');
    absent(check(edit(golden, (draft) => { draft.selfConnector = 'not-in-the-pack'; }), { connectors: withClasses }), 'claim_class_needs_guard', 'when the own connector is not in the pack');
    absent(check(golden, { connectors: undefined }), 'claim_class_needs_guard', 'with no connector table');
    assert.ok(errorsOf(off).some((issue) => issue.code === 'claim_class_needs_guard'));
  });

  await suite.test('a contract change must name the person who approved it', () => {
    for (const name of ['', '   ']) {
      const issues = check(edit(golden, (draft) => { draft.contractChanges[0].approvedBy = name; }));
      found(issues, 'contract_change_unnamed', 'contractChanges[0].approvedBy', /'Account\.creditLimit'.*does not say who approved it/);
      found(issues, 'schema');
    }
    const missing = check(edit(golden, (draft) => { delete draft.contractChanges[0].approvedBy; }));
    found(missing, 'contract_change_unnamed', 'contractChanges[0].approvedBy');
    assert.deepEqual(pathsOf(check(golden), 'contract_change_unnamed'), []);
  });

  await suite.test('only the modes see and change exist; hold, claim, ask_first and any other word are refused', () => {
    for (const mode of ['hold', 'claim', 'ask_first', 'allow', '', 7]) {
      const issues = check(edit(golden, (draft) => { draft.permissionRules[0].mode = mode; }));
      found(issues, 'rule_mode_unsupported', 'permissionRules[0].mode', /Only 'see' and 'change' are enforced/);
      found(issues, 'schema');
    }
    for (const mode of ['see', 'change']) {
      const issues = check(edit(golden, (draft) => {
        draft.permissionRules[0].mode = mode;
        if (mode === 'change') draft.permissionRules[0].writeTools = [{ connectorId: 'zendesk', tool: 'add_ticket_note' }];
      }));
      assert.deepEqual(pathsOf(issues, 'rule_mode_unsupported'), [], mode);
    }
  });

  // ---- partial: one part checked on its own ----

  await suite.test('partial: a name another part defines is an error unless it is listed as external, and the error says what to do', () => {
    const outside = ['Order', 'Ticket', 'Deal', 'Contact', 'Consignment', 'Branch'];
    const without = check(accountFixtureDictionary, { partial: { external: [] } });
    assert.equal(errorsOf(without).length, 7);
    for (const issue of errorsOf(without)) assert.match(issue.message, /This part is checked on its own: if another part defines it, list it as external\./);
    const whole = check(accountFixtureDictionary);
    assert.equal(errorsOf(whole).length, 7);
    for (const issue of errorsOf(whole)) assert.doesNotMatch(issue.message, /checked on its own/, 'the whole dictionary gives no hint about external');

    assert.deepEqual(errorsOf(check(accountFixtureDictionary, { partial: { external: outside } })), []);
    const nearly = errorsOf(check(accountFixtureDictionary, { partial: { external: outside.filter((name) => name !== 'Branch') } }));
    assert.deepEqual(nearly.map((issue) => issue.path), ['links[5].to'], 'only what is listed is let through');
    assert.deepEqual(errorsOf(check(accountFixtureDictionary, { partial: { external: ['Nothing', 'Order.state'] } })).length, 7, 'a name nothing uses changes nothing');
  });

  await suite.test('partial: external may name a thing (all its facts and links count), a fact, a link, a setting, a key kind or a severity', () => {
    const lastPaid = iFact('Account.lastPaid');
    const tickets = iLink('Account.tickets');
    const zd = golden.things[0].keyKinds.findIndex((entry) => entry.kind === 'zd_tag');
    const cases: Array<[string, (draft: any) => void, string, string[]]> = [
      ['a fact', (draft) => { draft.facts.splice(lastPaid, 1); }, 'r4_unknown_name', ['Account.lastPaid']],
      ['a link', (draft) => { draft.links.splice(tickets, 1); }, 'r4_unknown_name', ['Account.tickets']],
      ['a setting', (draft) => { draft.settings.splice(iSetting('credit.useWatch'), 1); }, 'r4_unknown_name', ['credit.useWatch']],
      ['a key kind', (draft) => { draft.things[0].keyKinds.splice(zd, 1); }, 'r4_unknown_name', ['zd_tag']],
      ['a severity', (draft) => { draft.severities = []; }, 'r4_unknown_name', ['watch']],
      ['a freshness setting', (draft) => { draft.settings.splice(iSetting('freshness.ticket'), 1); }, 'freshness_setting_missing', ['freshness.ticket']],
    ];
    for (const [label, change, code, external] of cases) {
      const block = edit(golden, change);
      found(check(block, { partial: { external: [] } }), code as DictionaryIssueCode, undefined);
      assert.deepEqual(errorsOf(check(block, { partial: { external } })), [], label);
      assert.ok(errorsOf(check(block)).some((issue) => issue.code === code), `${label}: the whole dictionary still reports it`);
    }

    const noTicket = edit(golden, (draft) => {
      draft.things.splice(iThing('Ticket'), 1);
      draft.facts = draft.facts.filter((entry: any) => entry.thing !== 'Ticket');
      draft.bindings = draft.bindings.filter((entry: any) => !entry.bindingId.startsWith('Ticket.'));
      draft.permissionRules = draft.permissionRules.filter((entry: any) => entry.target.thing !== 'Ticket');
      draft.stateMaps = [];
    });
    assert.ok(errorsOf(check(noTicket, { partial: { external: [] } })).length > 0);
    assert.deepEqual(errorsOf(check(noTicket, { partial: { external: ['Ticket'] } })), [], 'one thing name covers its facts, as the link end, and as the item of a list');
  });

  await suite.test('partial skips the checks that need the whole dictionary, and nothing else: a bad binding is still an error', () => {
    const noRetention = edit(golden, (draft) => { draft.settings = draft.settings.filter((entry: any) => entry.key !== 'evidence.retention'); });
    found(check(noRetention), 'engine_setting_missing');
    absent(check(noRetention, { partial: { external: [] } }), 'engine_setting_missing', 'for one part on its own');

    const bad = edit(golden, (draft) => { draft.bindings[6].system = 'nowhere'; draft.bindings[1].tool = 'no_such_tool'; draft.notes = 'See /var/data/notes'; });
    const issues = check(bad, { partial: { external: ['Order', 'Ticket', 'Account.lastPaid'] } });
    found(issues, 'r1_system_unavailable', 'bindings[6].system');
    found(issues, 'r2_tool_not_read', 'bindings[1].tool');
    found(issues, 'r12_path', 'notes');
    found(check(edit(golden, (draft) => { draft.facts[iFact('Account.balance')].claimClasses = ['made_up']; }), { partial: { external: [] } }), 'r13_claim_class_unknown');
    found(check(edit(golden, (draft) => { draft.permissionRules[0].mode = 'hold'; }), { partial: { external: [] } }), 'rule_mode_unsupported');
  });

  // ---- completeness ----

  await suite.test('every finding code the checks can give has a case above, and each code has one fixed severity', () => {
    const checked = DICTIONARY_ISSUE_CODES.filter((code) => !code.startsWith('merge_'));
    assert.deepEqual(checked.filter((code) => !seen.has(code)), [], 'a code with no failing fixture');
    assert.deepEqual([...seen].filter((code) => !DICTIONARY_ISSUE_CODES.includes(code)), []);
    assert.deepEqual(DICTIONARY_ISSUE_CODES.filter((code) => code.startsWith('merge_')), ['merge_duplicate_part', 'merge_replace_invalid', 'merge_unredirectable'], 'the merge codes are tested in the merge spec');
    const errors = DICTIONARY_ISSUE_CODES.filter((code) => severityOf(code) === 'error');
    const warnings = DICTIONARY_ISSUE_CODES.filter((code) => severityOf(code) === 'warning');
    assert.deepEqual(warnings.sort(), ['r14_state_map_lossy', 'r3_tool_blocked_for_all', 'r5_no_source', 'r6_contract_unknown', 'r9_setting_unset']);
    assert.equal(errors.length + warnings.length, DICTIONARY_ISSUE_CODES.length);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
