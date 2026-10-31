import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONNECTORS_DIR, loadConnectors, readManifest } from '../src/loader';
import { SampleConnectorServer } from '../src/server';
import type { Rec, SeedFile } from '../src/types';
import { planExtension, run } from '../scripts/extend-seeds';
import { applySeedStages, stageConnectorIds } from '../scripts/seed-stages';
import { erpAccountKeys } from '../scripts/seed-stages/erp-account-keys';
import { readme, seedText } from '../scripts/seed-writing';

/**
 * The sample ERP's account key fields and the seed-extension hook. The stage hook is tested through extend-seeds alone: the full build
 * (build-seeds.ts) reads a data folder outside the repository.
 */
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const TENANT = 'placemakers';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The fields every row of each ERP collection had before this stage, in their order. */
const OLD_FIELDS: Record<string, string[]> = {
  branches: ['code', 'branchId', 'name', 'phone', 'lat', 'lng', 'source', 'sample'],
  stock: ['sku', 'title', 'branchCode', 'branchName', 'onHand', 'reserved', 'available', 'reorderLevel', 'lastCountedAt', 'sample'],
  price_list: ['sku', 'title', 'unitOfMeasure', 'currency', 'retailPrice', 'bronzePrice', 'silverPrice', 'goldPrice', 'effectiveFrom', 'sample'],
  deliveries: ['deliveryId', 'orderId', 'accountId', 'branchCode', 'status', 'scheduledDate', 'window', 'vehicle', 'driver', 'stops', 'note', 'sample'],
  account_balances: ['accountId', 'name', 'tier', 'creditLimit', 'balance', 'overdue', 'lastPaymentAt', 'terms', 'currency', 'sample'],
};
const NEW_FIELDS: Record<string, string[]> = {
  deliveries: ['commercetoolsOrderNumber'],
  account_balances: ['commercetoolsUnitKey', 'salesforceAccountId', 'zendeskOrganizationId'],
};

/** SHA-256 of each collection's rows as committed before this stage: the old fields only, one JSON line per row, joined by a newline. */
const ROWS_BEFORE: Record<string, string> = {
  branches: '35b9b302814f8ee9dbc4087fef400ad7ab198dcc475b52a1c8c446eb0287d0cf',
  stock: '8463183738e94897d5b26df3828207248cafda90faf4d64f528e0b9c158a651e',
  price_list: 'f2600b0d6376fb1ed80ded4fea961a081a1525946bc4dbd6f701578504ff3fc7',
  deliveries: '55d5cbc29eebdf0527ee479ddc3b206d571c89deae82ff17aed6d9cb32ad59f5',
  account_balances: '9c3e6b36e148d8b5ed70ee8d8a4f7b9b355c583fc34cd7d46f59c2659a300fa4',
};
/** SHA-256 of `JSON.stringify` of the provenance of the collections this stage does not touch, as committed before it. */
const PROVENANCE_BEFORE: Record<string, string> = {
  branches: '64010306a325655a2986cd7664715e6ab22c54ea2218226e88f4a1862f04cf14',
  stock: 'fc02b2d823f9f71e0f6574c586ba0b449916ca58fed9d5d849b373f38ca69ecd',
  price_list: '3cb9ab2bda737738b81f3b5cb5e43f616ca812e2cab0a9f13b055c3c295b7030',
};

const project = (row: Rec, fields: string[]): Rec => Object.fromEntries(fields.map((field) => [field, row[field]]));

/** The seed as it was before this stage: the new fields and the notes about them taken out. */
function withoutNewFields(seed: SeedFile): SeedFile {
  const copy = structuredClone(seed);
  for (const [collection, fields] of Object.entries(NEW_FIELDS)) {
    for (const row of copy.collections[collection]) for (const field of fields) delete row[field];
    copy.provenance[collection].madeUpFields = copy.provenance[collection].madeUpFields.filter((entry) => !fields.some((field) => entry.startsWith(field)));
  }
  return copy;
}

async function main() {
  console.log('Sample ERP: account key fields and the seed-extension hook');
  const connectors = loadConnectors();
  const erp = connectors.get('ace-erp')!;
  const rows = (collection: string): Rec[] => erp.seed.collections[collection];
  const server = new SampleConnectorServer({ tenants: [TENANT], now: () => new Date('2026-09-01T10:00:00Z') });
  const call = async (tool: string, args: Rec): Promise<Rec> => {
    const answer = await server.handle('ace-erp', TENANT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
    return (answer!.result as Rec).structuredContent;
  };

  await check('every old field of every row in the ERP seed is byte-identical to what was committed before this stage', () => {
    assert.deepEqual(Object.keys(ROWS_BEFORE), Object.keys(erp.seed.collections).filter((name) => OLD_FIELDS[name]));
    for (const [collection, fields] of Object.entries(OLD_FIELDS)) {
      const text = rows(collection).map((row) => JSON.stringify(project(row, fields))).join('\n');
      assert.equal(sha256(text), ROWS_BEFORE[collection], `${collection}: an old field changed`);
    }
  });

  await check('the new fields stand straight after the old ones, so the old text of each row is the start of its new text', () => {
    for (const [collection, fields] of Object.entries(NEW_FIELDS)) {
      for (const row of rows(collection)) {
        const keys = Object.keys(row);
        assert.deepEqual(keys.slice(0, OLD_FIELDS[collection].length), OLD_FIELDS[collection], `${collection}: old fields keep their place`);
        assert.deepEqual(keys.slice(OLD_FIELDS[collection].length, OLD_FIELDS[collection].length + fields.length), fields, `${collection}: new fields come next`);
        assert.ok(JSON.stringify(row).startsWith(JSON.stringify(project(row, OLD_FIELDS[collection])).slice(0, -1) + ','), `${collection}: the old text is a prefix`);
      }
    }
  });

  await check('the provenance keeps what it said, names the new fields as made up, and the other collections\' provenance is untouched', () => {
    for (const [collection, expected] of Object.entries(PROVENANCE_BEFORE)) assert.equal(sha256(JSON.stringify(erp.seed.provenance[collection])), expected, collection);
    const accounts = erp.seed.provenance.account_balances;
    assert.deepEqual([accounts.origin, accounts.source, accounts.realFields, accounts.madeUpFields[0]], ['sample', 'invented over the sample accounts', [], 'every field']);
    const deliveries = erp.seed.provenance.deliveries;
    assert.deepEqual([deliveries.origin, deliveries.source, deliveries.realFields, deliveries.madeUpFields[0]], ['sample', 'invented over the sample orders', ['branchCode (a real code)'], 'every other field']);
    for (const [collection, fields] of Object.entries(NEW_FIELDS)) {
      for (const field of fields) assert.equal(erp.seed.provenance[collection].madeUpFields.filter((entry) => entry.startsWith(field)).length, 1, `${collection}.${field} is named once`);
    }
  });

  await check('all 30 account rows hold the three new fields: the lower-case account number, and the Salesforce and Zendesk ids still empty', () => {
    const accounts = rows('account_balances');
    assert.equal(accounts.length, 30);
    for (const row of accounts) {
      assert.match(row.accountId, /^ACC-\d{4}$/);
      assert.equal(row.commercetoolsUnitKey, row.accountId.toLowerCase());
      assert.equal(row.salesforceAccountId, null);
      assert.equal(row.zendeskOrganizationId, null);
      assert.equal(row.sample, true);
    }
    assert.equal(new Set(accounts.map((row) => row.commercetoolsUnitKey)).size, 30, 'the unit keys are unique');
  });

  await check('every delivery row holds commercetoolsOrderNumber, equal to its orderId', () => {
    const deliveries = rows('deliveries');
    assert.equal(deliveries.length, 27);
    for (const row of deliveries) {
      assert.match(row.orderId, /^ORD-\d{6}$/);
      assert.equal(row.commercetoolsOrderNumber, row.orderId);
      assert.equal(row.sample, true);
    }
  });

  await check('account_balance for ACC-0012 returns the new fields; list_account_balances and delivery_status carry them; find_account keeps its four fields', async () => {
    const one = await call('account_balance', { accountId: 'ACC-0012' });
    assert.equal(one.ok, true);
    assert.equal(one.record.commercetoolsUnitKey, 'acc-0012');
    assert.equal(one.record.salesforceAccountId, null);
    assert.equal(one.record.zendeskOrganizationId, null);
    assert.equal(one.record.balance, 7238.75, 'the old fields are still there');
    const listed = await call('list_account_balances', { limit: 30 });
    assert.equal(listed.returned, 30);
    for (const record of listed.records) assert.equal(record.commercetoolsUnitKey, String(record.accountId).toLowerCase());
    const delivery = await call('delivery_status', { deliveryId: 'DEL-30027' });
    assert.equal(delivery.record.commercetoolsOrderNumber, 'ORD-100025');
    const found = await call('find_account', { query: 'Hartley' });
    assert.ok(found.returned > 0);
    for (const record of found.records) assert.deepEqual(Object.keys(record), ['accountId', 'name', 'tier', 'terms']);
  });

  await check('the stage only adds: on a finished seed it changes nothing, on the old seed it adds the fields, and a value that is there is kept', () => {
    const finished = structuredClone(erp.seed);
    erpAccountKeys.apply(finished);
    assert.deepEqual(finished, erp.seed);

    const before = withoutNewFields(erp.seed);
    // TEST FIXTURE ONLY: not a Salesforce id; it stands for a value the backfill would have written.
    before.collections.account_balances[0].salesforceAccountId = 'TEST FIXTURE ONLY';
    erpAccountKeys.apply(before);
    assert.equal(before.collections.account_balances[0].salesforceAccountId, 'TEST FIXTURE ONLY');
    assert.deepEqual(before.collections.account_balances.slice(1), erp.seed.collections.account_balances.slice(1));
    assert.deepEqual(before.collections.deliveries, erp.seed.collections.deliveries);
    assert.deepEqual(before.provenance, erp.seed.provenance);
  });

  await check('a row without an account number or an order number stops the stage', () => {
    const broken = withoutNewFields(erp.seed);
    delete broken.collections.account_balances[3].accountId;
    assert.throws(() => erpAccountKeys.apply(broken), /no accountId/);
    const noOrder = withoutNewFields(erp.seed);
    noOrder.collections.deliveries[5].orderId = '';
    assert.throws(() => erpAccountKeys.apply(noOrder), /no orderId/);
  });

  await check('a stage whose connector has no seed is an error, not a skip', () => {
    assert.throws(() => applySeedStages(new Map()), /ace-erp/);
  });

  await check('extend-seeds: --check prints the difference and writes nothing, --write writes, --check after --write is empty; only the connectors a stage names are read', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'extend-seeds-'));
    try {
      // Only the connectors a stage names are copied: reading any other connector would fail.
      for (const id of stageConnectorIds()) cpSync(path.join(DEFAULT_CONNECTORS_DIR, id), path.join(tmp, id), { recursive: true });
      assert.deepEqual(planExtension(tmp), [], 'the committed seeds already hold what every stage adds');
      assert.equal(run(['--check'], tmp, () => {}), 0);

      const files = { seed: path.join(tmp, 'ace-erp', 'seed.json'), readme: path.join(tmp, 'ace-erp', 'README.md'), definition: path.join(tmp, 'ace-erp', 'connector.json') };
      const old = withoutNewFields(erp.seed);
      writeFileSync(files.seed, seedText(old));
      writeFileSync(files.readme, readme(erp.definition, old));
      const stripped = { seed: readFileSync(files.seed, 'utf8'), readme: readFileSync(files.readme, 'utf8'), definition: readFileSync(files.definition, 'utf8') };

      const changes = planExtension(tmp);
      assert.deepEqual(changes.map((change) => path.relative(tmp, change.file)).sort(), [path.join('ace-erp', 'README.md'), path.join('ace-erp', 'seed.json')]);
      const lines: string[] = [];
      const log = (line: string) => lines.push(line);
      assert.equal(run(['--check'], tmp, log), 1);
      assert.ok(lines.some((line) => /ace-erp[\\/]seed\.json: \d+ lines added, \d+ removed/.test(line)), 'it prints the difference');
      assert.equal(run([], tmp, log), 1, 'no flag means --check');
      assert.equal(run(['--check', '--write'], tmp, log), 2, 'both flags is a wrong call');
      assert.equal(readFileSync(files.seed, 'utf8'), stripped.seed, 'nothing written yet');
      assert.equal(readFileSync(files.readme, 'utf8'), stripped.readme);

      assert.equal(run(['--write'], tmp, log), 0);
      assert.notEqual(readFileSync(files.seed, 'utf8'), stripped.seed);
      assert.deepEqual(JSON.parse(readFileSync(files.seed, 'utf8')), erp.seed, 'it wrote what is committed');
      assert.equal(readFileSync(files.readme, 'utf8'), readme(erp.definition, erp.seed));
      assert.equal(readFileSync(files.definition, 'utf8'), stripped.definition, 'connector.json is not touched');
      assert.deepEqual(planExtension(tmp), [], '--check after --write is empty');
      assert.equal(run(['--check'], tmp, log), 0);
      assert.equal(run(['--write'], tmp, log), 0);
      assert.equal(readFileSync(files.seed, 'utf8'), seedText(erp.seed), 'a second --write changes nothing');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('the committed seed.json and README.md of all eleven connectors equal what seed-writing.ts produces', () => {
    assert.equal(readManifest().connectors.length, 11);
    for (const [id, { definition, seed }] of connectors) {
      assert.equal(readFileSync(path.join(DEFAULT_CONNECTORS_DIR, id, 'seed.json'), 'utf8'), seedText(seed), `${id}/seed.json`);
      assert.equal(readFileSync(path.join(DEFAULT_CONNECTORS_DIR, id, 'README.md'), 'utf8'), readme(definition, seed), `${id}/README.md`);
    }
  });

  await check('build-seeds takes the writers from seed-writing and calls the stage list once, after the last seed is added and before the first file is written', () => {
    const build = readFileSync(path.resolve(__dirname, '..', 'scripts', 'build-seeds.ts'), 'utf8');
    assert.match(build, /import \{ readme, seedText \} from '\.\/seed-writing';/);
    assert.doesNotMatch(build, /function (seedText|readme)\(/);
    assert.equal(build.match(/applySeedStages\(/g)?.length, 1);
    const call = build.indexOf('applySeedStages(seeds)');
    assert.ok(call > build.lastIndexOf("addSeed('") && call < build.indexOf('writeFileSync('), 'the call sits between the last addSeed and the first writeFileSync');
  });

  console.log(`sample ERP account keys: ${passed} passed, 0 failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
