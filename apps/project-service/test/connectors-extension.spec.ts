import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { ProjectService } from '../src/project.service';

const suite = createSuite('project-service: pack extension connectors');
const TENANT = 'placemakers';

async function createService() {
  const db = new MemoryDb();
  await db.collection('tenant_configs').insertOne({
    projectId: TENANT, name: 'T', companyName: 'T Ltd', pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 }, ai: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    persona: { systemName: 'Agent', systemPromptOverrides: 'Guide.' },
  });
  const service = new ProjectService();
  (service as any).db = db;
  (service as any).projectsCol = db.collection('tenant_configs');
  (service as any).membersCol = db.collection('project_members');
  (service as any).rulesCol = db.collection('business_rules');
  (service as any).versionsCol = db.collection('config_versions');
  (service as any).isConnected = true;
  return { service, db };
}

const registry = {
  connectors: [{ connectorId: 'ace-erp', displayName: 'ACE ERP', description: 'Stock by branch.', owner: 'Supply chain', secretRef: 'tenant-secret://placemakers/dev/sample-key', sample: true, tools: [{ name: 'stock_by_branch', sideEffect: 'read' }] }],
  policy: [{ connectorId: 'ace-erp', tool: '*', audience: 'staff', groups: [], state: 'allow' }],
};

async function main() {
  await suite.test('the connector registry is stored under extensions.connectors, checked against its schema', async () => {
    const { service, db } = await createService();
    const ok = await service.updateProject(TENANT, { extensions: { connectors: registry } } as any);
    assert.equal(ok.success, true, ok.message);
    const stored = db.dump('tenant_configs')[0].extensions.connectors;
    assert.equal(stored.connectors[0].connectorId, 'ace-erp');
    assert.equal(stored.connectors[0].connectionScope, 'shop', 'documented defaults are filled in');
  });

  await suite.test('a registry with a raw key, an unknown field or a bad state is refused and leaves the stored one as it was', async () => {
    const { service, db } = await createService();
    await service.updateProject(TENANT, { extensions: { connectors: registry } } as any);
    const raw = await service.updateProject(TENANT, { extensions: { connectors: { ...registry, connectors: [{ ...registry.connectors[0], secretRef: 'sk-abcdefghijklmnopqrstuvwxyz012345' }] } } } as any);
    assert.equal(raw.success, false);
    assert.match(raw.message || '', /Invalid connectors/);
    const state = await service.updateProject(TENANT, { extensions: { connectors: { ...registry, policy: [{ ...registry.policy[0], state: 'sometimes' }] } } } as any);
    assert.equal(state.success, false);
    const extra = await service.updateProject(TENANT, { extensions: { connectors: { ...registry, surprise: 1 } } } as any);
    assert.equal(extra.success, false);
    assert.equal(db.dump('tenant_configs')[0].extensions.connectors.policy[0].state, 'allow');
  });

  await suite.test('an extension key that is not on the list is still refused', async () => {
    const { service } = await createService();
    const refused = await service.updateProject(TENANT, { extensions: { connectorz: registry } } as any);
    assert.equal(refused.success, false);
    assert.match(refused.message || '', /Unknown pack extension 'connectorz'.*connectors/);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
