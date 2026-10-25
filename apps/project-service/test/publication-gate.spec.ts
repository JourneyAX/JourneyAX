import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { ProjectService } from '../src/project.service';
import { PublicationGateValidator, retargetSecretRefs } from '../src/publication-gate-validator';

/**
 * The publication gate is the pre-flight every Studio publish goes through: it publishes the candidate into a throwaway store,
 * activates it through the real activation repository, proves rollback and the compare-and-swap, and only then lets the real
 * publication happen. These tests run the real gate (over an in-memory throwaway store) so a change to the publisher or the
 * activation repository that the gate does not expect fails here, not in front of a person publishing.
 */
const suite = createSuite('project-service: the publication gate');
const TENANT = 'placemakers';

async function createService(gate: PublicationGateValidator) {
  const db = new MemoryDb();
  await db.collection('business_pack_releases').createIndex({ tenantId: 1, environmentId: 1, version: 1 } as any, { unique: true });
  await db.collection('config_versions').createIndex({ projectId: 1, version: 1 } as any, { unique: true });
  await db.collection('tenant_configs').insertOne({
    projectId: TENANT, name: 'T', companyName: 'T Ltd', pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 }, ai: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    persona: {
      systemName: 'Agent', systemPromptOverrides: 'Guide.',
      journeyGraph: {
        nodes: [
          { id: 'n1', data: { kind: 'trigger.intent', stageId: 'intake', label: 'Intake' } },
          { id: 'n2', data: { kind: 'stage.scoping', stageId: 'recommend', label: 'Recommend', allowedCapabilities: ['catalog_search'] } },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      },
    },
  });
  const service = new ProjectService(gate);
  Object.assign(service as any, {
    db, projectsCol: db.collection('tenant_configs'), membersCol: db.collection('project_members'), rulesCol: db.collection('business_rules'),
    versionsCol: db.collection('config_versions'), isConnected: true,
  });
  return { service, db };
}

const throwawayStore = () => {
  const stores: MemoryDb[] = [];
  const factory = async () => {
    const store = new MemoryDb();
    await store.collection('business_pack_releases').createIndex({ tenantId: 1, environmentId: 1, version: 1 } as any, { unique: true });
    stores.push(store);
    return { db: store as any, client: (store as any).client, cleanup: () => undefined };
  };
  return { factory, stores };
};

async function main() {
  await suite.test('the staged test copy names test secrets, and nothing else about a reference changes', () => {
    const production = { connectors: [{ secretRef: 'tenant-secret://placemakers/production/sample-connectors-key' }, { secretRef: 'tenant-secret://other-tenant/production/key' }], list: ['tenant-secret://placemakers/production/a'], note: 'tenant-secret is only text here', n: 3, flag: true, nothing: null };
    const staged: any = retargetSecretRefs(production, 'test');
    assert.equal(staged.connectors[0].secretRef, 'tenant-secret://placemakers/test/sample-connectors-key');
    assert.equal(staged.connectors[1].secretRef, 'tenant-secret://other-tenant/test/key', 'the tenant stays the pack\'s own named tenant, so a cross-tenant reference still fails the rule');
    assert.equal(staged.list[0], 'tenant-secret://placemakers/test/a');
    assert.deepEqual({ note: staged.note, n: staged.n, flag: staged.flag, nothing: staged.nothing }, { note: 'tenant-secret is only text here', n: 3, flag: true, nothing: null });
    assert.equal(production.connectors[0].secretRef, 'tenant-secret://placemakers/production/sample-connectors-key', 'the original is not changed');
    assert.equal(retargetSecretRefs('vault://tenants/x/webhook-secret', 'test'), 'vault://tenants/x/webhook-secret', 'a reference of another kind is left alone');
  });

  await suite.test('a pack that names its production secrets passes the real gate, and is published with its production names', async () => {
    const { factory } = throwawayStore();
    const { service, db } = await createService(new PublicationGateValidator(factory));
    await db.collection('tenant_configs').updateOne({ projectId: TENANT }, { $set: { extensions: { connectors: {
      askVia: 'card',
      connectors: [{ connectorId: 'crm', displayName: 'CRM', description: 'Accounts and cases.', owner: 'Sales', secretRef: 'tenant-secret://placemakers/production/sample-connectors-key', sample: true, tools: [{ name: 'find_account', sideEffect: 'read' }] }],
      policy: [{ connectorId: 'crm', tool: '*', audience: 'staff', groups: [], state: 'allow' }],
    } } } });
    const published: any = await service.publishConfig(TENANT, { environmentId: 'production', publishedBy: 'human:publisher' });
    assert.equal(published.success, true, published.message);
    const release: any = db.dump('business_pack_releases').at(-1);
    assert.equal(release.environmentId, 'production');
    assert.equal(release.extensions?.connectors?.connectors?.[0]?.secretRef ?? release.pack?.extensions?.connectors?.connectors?.[0]?.secretRef, 'tenant-secret://placemakers/production/sample-connectors-key', 'the real release keeps the production name');
  });

  await suite.test('a connector whose secret belongs to another tenant still stops the publication', async () => {
    const { factory } = throwawayStore();
    const { service, db } = await createService(new PublicationGateValidator(factory));
    await db.collection('tenant_configs').updateOne({ projectId: TENANT }, { $set: { extensions: { connectors: {
      askVia: 'card',
      connectors: [{ connectorId: 'crm', displayName: 'CRM', description: 'Accounts and cases.', owner: 'Sales', secretRef: 'tenant-secret://someone-else/production/key', tools: [{ name: 'find_account', sideEffect: 'read' }] }],
      policy: [{ connectorId: 'crm', tool: '*', audience: 'staff', groups: [], state: 'allow' }],
    } } } });
    const published: any = await service.publishConfig(TENANT, { environmentId: 'production', publishedBy: 'human:publisher' });
    assert.equal(published.success, false);
    assert.match(String(published.message), /Cross-tenant/i);
  });

  await suite.test('a publication passes the real gate: candidate, activation, rollback proof and compare-and-swap all hold', async () => {
    const { factory, stores } = throwawayStore();
    const { service, db } = await createService(new PublicationGateValidator(factory));
    const published: any = await service.publishConfig(TENANT, { environmentId: 'production', publishedBy: 'human:publisher' });
    assert.equal(published.success, true, published.message);
    assert.equal(stores.length, 1, 'the gate used one throwaway store');
    const record: any = stores[0].dump('tenant_cutovers')[0];
    assert.equal(record.status, 'rollback', 'the gate ended its own drill with the line stopped, in its own store');
    assert.equal(db.dump('tenant_cutovers').length, 0, 'the real store was not given an activation record by the gate');
    assert.equal(db.dump('business_pack_releases').length, 1, 'and the real publication happened');
  });

  await suite.test('the gate sees the activation follow its rollback as a numbered revision', async () => {
    const { factory, stores } = throwawayStore();
    const { service } = await createService(new PublicationGateValidator(factory));
    assert.equal(((await service.publishConfig(TENANT, { environmentId: 'production' })) as any).success, true);
    const audit: any[] = stores[0].dump('cutover_audit_logs');
    const actions = audit.map((row) => `${row.previousRevision}->${row.newRevision}:${row.newStatus}`);
    assert.deepEqual(actions, ['0->1:migrated', '1->2:migrated', '2->3:rollback'], 'approve, follow the rollback, then the explicit stop');
  });

  await suite.test('a failing gate stops the publication and publishes nothing', async () => {
    const broken = new PublicationGateValidator(async () => { throw new Error('throwaway store unavailable'); });
    const { service, db } = await createService(broken);
    const blocked: any = await service.publishConfig(TENANT, { environmentId: 'production' });
    assert.equal(blocked.success, false);
    assert.match(blocked.message, /publication gate/i);
    assert.equal(db.dump('business_pack_releases').length, 0);
    assert.equal(db.dump('config_versions').length, 0);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
