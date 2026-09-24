import assert from 'node:assert/strict';
import { JourneyConfigurationService } from '../src/journey-configuration.service';
import { CapabilityRegistryService } from '../src/capability-registry.service';
import { ProjectService } from '../src/project.service';

async function runJourneyConfigTests() {
  console.log('🧪 Running Studio Control-Plane Integrity & Capability Tests (Workstream C)...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}: ${err.message}`);
      console.error(err.stack);
      failed++;
    }
  }

  const journeyService = new JourneyConfigurationService();
  const capabilityService = new CapabilityRegistryService();

  // Test 1: Capability Registry provides universal platform schemas ONLY (no commerce in core)
  await test('1. CapabilityRegistryService lists universal platform contracts only (no commerce tools in core)', () => {
    const schemas = capabilityService.listStandardToolSchemas();

    // Universal platform contracts must exist
    assert.ok(schemas['workflow.invoke']);
    assert.equal(schemas['workflow.invoke'].sideEffect, 'transactional');
    assert.equal(schemas['workflow.invoke'].risk, 'medium');

    assert.ok(schemas['notification.send']);
    assert.equal(schemas['notification.send'].sideEffect, 'write');
    assert.equal(schemas['notification.send'].idempotencyRequired, true);

    // Commerce tools must NOT be hardcoded into core platform contracts
    assert.equal((schemas as any)['catalog.search'], undefined);
    assert.equal((schemas as any)['pricing.validate'], undefined);
    assert.equal((schemas as any)['order.commit'], undefined);
    assert.equal((schemas as any)['catalog_search'], undefined);
    assert.equal((schemas as any)['pricing_validate'], undefined);
    assert.equal((schemas as any)['order_commit'], undefined);
  });

  // Test 2: Journey Graph Validation rejects missing trigger
  await test('2. validateAndCompileGraph rejects journey graph without trigger node', () => {
    const graph = {
      nodes: [
        { id: 'action_1', data: { kind: 'action.recommendation', label: 'Recommend Products' } },
      ],
      edges: [],
    };
    const res = journeyService.validateAndCompileGraph('test-proj', 'Test Project', graph);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('Trigger node')));
  });

  // Test 3: Journey Graph Validation compiles valid graph
  await test('3. validateAndCompileGraph compiles valid graph with trigger and action nodes', () => {
    const graph = {
      nodes: [
        { id: 'node_trigger', data: { kind: 'trigger.intent', label: 'User Intent' } },
        { id: 'node_action', data: { kind: 'action.recommendation', label: 'Recommendation' } },
      ],
      edges: [
        { id: 'e1', source: 'node_trigger', target: 'node_action' },
      ],
    };
    const res = journeyService.validateAndCompileGraph('test-proj', 'Test Project', graph);
    assert.equal(res.valid, true);
    assert.ok(res.compiledJourney);
    assert.equal(res.compiledJourney.journeyId, 'test-proj');
  });

  // Test 4: Dynamic capability discovery without automatic commerce capability injection
  await test('4. discoverCapabilitiesForTenant discovers platform contracts without automatic commerce injection', async () => {
    const discovered = await capabilityService.discoverCapabilitiesForTenant('tenant_abc', 'production');

    // Universal platform contracts are discovered
    assert.ok(discovered.some((d) => d.toolId === 'workflow.invoke'));
    assert.ok(discovered.some((d) => d.toolId === 'notification.send'));

    // Commerce tools are NOT automatically injected
    assert.equal(discovered.some((d) => d.toolId === 'catalog.search'), false);
    assert.equal(discovered.some((d) => d.toolId === 'pricing.validate'), false);
    assert.equal(discovered.some((d) => d.toolId === 'order.commit'), false);

    // No hardcoded industry tools
    assert.equal(discovered.some((d) => d.toolId === 'roster'), false);
    assert.equal(discovered.some((d) => d.toolId === 'teamColours'), false);
    assert.equal(discovered.some((d) => d.toolId === 'warranty'), false);
    assert.equal(discovered.some((d) => d.toolId === 'installGuide'), false);
  });

  // Test 5: Studio validation of tool bindings rejects raw secrets
  await test('5. validateToolBinding rejects raw secrets and requires secretRef', () => {
    const validBinding: any = {
      toolId: 'workflow.invoke',
      tenantId: 'tenant_abc',
      environmentId: 'production',
      executor: {
        type: 'activepieces_flow',
        flowId: 'flow_123',
        connectionRef: 'valid_secret_conn',
      },
    };
    const res1 = capabilityService.validateToolBinding(validBinding, ['valid_secret_conn']);
    assert.equal(res1.valid, true);

    const invalidBinding: any = {
      toolId: 'crm.sync',
      tenantId: 'tenant_abc',
      environmentId: 'production',
      executor: {
        type: 'activepieces_flow',
        flowId: 'flow_123',
        connectionRef: 'missing_crm_secret',
      },
      policyOverrides: {
        rawApiKey: 'sk_live_1234567890abcdef',
      },
    };
    const res2 = capabilityService.validateToolBinding(invalidBinding, ['valid_secret_conn']);
    assert.equal(res2.valid, false);
    assert.ok(res2.errors.some((e) => e.includes('Raw secret detected')));
    assert.ok(res2.errors.some((e) => e.includes('missing_crm_secret')));
  });

  // Test 6: Comprehensive Reference Integrity Validation
  await test('6. validateBusinessPackReferenceIntegrity validates journeys, agents, policies, tools, cards, themes, and secret references', () => {
    // A pack with multiple deliberate reference errors
    const invalidPack: any = {
      agents: [
        {
          agentId: 'agent_recommender',
          policyRef: 'undeclared_policy_id', // Error: undeclared policy
        },
      ],
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'undeclared_default', // Error: default policy not in policies
        policies: [
          { policyId: 'fast_llm_policy' },
        ],
        routes: [
          { taskType: 'reasoning', policyRef: 'missing_route_policy' }, // Error: route points to missing policy
        ],
      },
      journeys: [
        {
          journeyId: 'j1',
          entryStage: 'ghost_entry_stage', // Error: entryStage not in stages
          stages: [
            {
              stageId: 'stage_1',
              agentRef: 'phantom_agent', // Error: undeclared agent
              transitions: [
                { targetStage: 'nowhere_stage' }, // Error: targetStage does not exist
              ],
            },
          ],
        },
      ],
      capabilities: {
        toolDefinitions: [
          { toolId: 'custom.fetch_status' },
        ],
        stageBindings: [
          {
            journeyId: 'j1',
            stageId: 'stage_1',
            // Error: catalog.search is NOT in core; must be declared in Business Pack!
            tools: [{ toolId: 'catalog.search' }, { toolId: 'phantom_tool' }],
          },
        ],
        toolBindings: [
          {
            toolId: 'undeclared_binding_tool', // Error: undeclared tool definition
            executor: {
              type: 'activepieces_flow',
              flowId: 'f1',
              connectionRef: 'unconfigured_conn', // Error: connectionRef not in availableSecrets
            },
            policyOverrides: {
              secret: 'super_secret_token', // Error: raw secret in policyOverrides
            },
          },
        ],
      },
      experience: {
        theme: {
          primaryColor: '', // Error: missing primaryColor
        },
        cards: [
          { id: 'c1', type: 'invalid_card_envelope_type' }, // Error: unknown cardType
        ],
      },
    };

    const integrity = capabilityService.validateBusinessPackReferenceIntegrity(invalidPack, {
      availableSecrets: ['configured_secret_ref_1'],
    });

    assert.equal(integrity.valid, false);
    assert.ok(integrity.errors.some((e) => e.includes('undeclared_policy_id')));
    assert.ok(integrity.errors.some((e) => e.includes('undeclared_default')));
    assert.ok(integrity.errors.some((e) => e.includes('missing_route_policy')));
    assert.ok(integrity.errors.some((e) => e.includes('ghost_entry_stage')));
    assert.ok(integrity.errors.some((e) => e.includes('phantom_agent')));
    assert.ok(integrity.errors.some((e) => e.includes('nowhere_stage')));
    assert.ok(integrity.errors.some((e) => e.includes('catalog.search')));
    assert.ok(integrity.errors.some((e) => e.includes('phantom_tool')));
    assert.ok(integrity.errors.some((e) => e.includes('undeclared_binding_tool')));
    assert.ok(integrity.errors.some((e) => e.includes('unconfigured_conn')));
    assert.ok(integrity.errors.some((e) => e.includes('prohibited raw secret')));
    assert.ok(integrity.errors.some((e) => e.includes('primaryColor')));
    assert.ok(integrity.errors.some((e) => e.includes('invalid_card_envelope_type')));
  });

  // Test 7: Fail-Closed card/theme publication and rollback without active MongoDB
  await test('7. publishCardTheme and rollbackCardTheme fail closed when MongoDB is missing', async () => {
    const origUri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;

    try {
      const validCard: any = {
        cardId: 'card_rec_001',
        type: 'products',
        version: '1.0.0',
        data: { title: 'Test Product' },
      };

      // publish must fail closed without MongoDB
      await assert.rejects(
        async () => {
          await capabilityService.publishCardTheme(
            'tenant_abc',
            'production',
            { primaryColor: '#0055ff' },
            [validCard]
          );
        },
        /requires active MongoDB connection; failing closed/i
      );

      // rollback must fail closed without MongoDB
      await assert.rejects(
        async () => {
          await capabilityService.rollbackCardTheme('tenant_abc', 'production', 'theme_v_old');
        },
        /requires active MongoDB connection; failing closed/i
      );
    } finally {
      if (origUri !== undefined) {
        process.env.MONGODB_URI = origUri;
      }
    }
  });

  // Test 8: Card and theme envelope validation fails closed on invalid card type
  await test('8. publishCardTheme rejects invalid card envelopes before database access', async () => {
    const invalidCard: any = {
      cardId: 'card_bad',
      type: 'invalid_type_unknown',
      version: '1.0.0',
      data: {},
    };

    await assert.rejects(
      async () => {
        await capabilityService.publishCardTheme(
          'tenant_abc',
          'production',
          { primaryColor: '#0055ff' },
          [invalidCard]
        );
      },
      /Invalid card envelope/i
    );
  });

  // Test 9: Validate connectionRef is rejected when available-secret list is empty
  await test('9. validateToolBinding and validateBusinessPackReferenceIntegrity reject connectionRef when availableSecrets is empty', () => {
    const bindingWithSecret: any = {
      toolId: 'workflow.invoke',
      tenantId: 'tenant_abc',
      environmentId: 'production',
      executor: {
        type: 'activepieces_flow',
        flowId: 'flow_999',
        connectionRef: 'any_secret_conn',
      },
    };

    // availableSecrets is explicitly empty array []
    const toolBindingResult = capabilityService.validateToolBinding(bindingWithSecret, []);
    assert.equal(toolBindingResult.valid, false);
    assert.ok(toolBindingResult.errors.some((e) => e.includes('not configured for tenant')));

    const packWithConnectionRef: any = {
      journeys: [
        {
          journeyId: 'j_empty',
          entryStage: 's1',
          stages: [{ stageId: 's1', exitConditions: [] }],
        },
      ],
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'p1',
        policies: [{ policyId: 'p1' }],
      },
      capabilities: {
        toolDefinitions: [{ toolId: 'workflow.invoke' }],
        toolBindings: [bindingWithSecret],
      },
    };

    const integrityResult = capabilityService.validateBusinessPackReferenceIntegrity(packWithConnectionRef, {
      availableSecrets: [],
    });
    assert.equal(integrityResult.valid, false);
    assert.ok(integrityResult.errors.some((e) => e.includes('unconfigured connectionRef')));
  });

  // Test 10: validateBusinessPackReferenceIntegrity recursively rejects raw secrets
  await test('10. validateBusinessPackReferenceIntegrity recursively rejects raw secrets across nested definitions', () => {
    const packWithDeepSecrets: any = {
      journeys: [
        {
          journeyId: 'j_secret',
          entryStage: 's1',
          stages: [
            {
              stageId: 's1',
              exitConditions: [],
              customData: {
                nested: {
                  clientSecret: 'shhh_raw_secret_here',
                },
              },
            },
          ],
        },
      ],
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'p1',
        policies: [
          {
            policyId: 'p1',
            config: {
              apiKey: 'sk-1234567890abcdef',
            },
          },
        ],
      },
      capabilities: {
        toolDefinitions: [{ toolId: 'workflow.invoke' }],
      },
    };

    const result = capabilityService.validateBusinessPackReferenceIntegrity(packWithDeepSecrets);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Raw secret detected at 'journeys[0].stages[0].customData.nested.clientSecret'")));
    assert.ok(result.errors.some((e) => e.includes("Raw secret detected at 'modelPolicy.policies[0].config.apiKey'")));
  });

  // Test 11: ProjectService update paths reject and never persist raw credentials (Workstream C)
  await test('11. ProjectService updateProject strictly rejects raw secrets (notification, AI, connector) and accepts tenant-scoped refs only', async () => {
    const memoryProjects = new Map<string, any>([
      [
        'tenant_secret_guard',
        {
          projectId: 'tenant_secret_guard',
          name: 'Secret Guard Test',
          integrations: {},
          notifications: {},
        },
      ],
    ]);

    const mockDb: any = {
      collection: (_name: string) => ({
        findOne: async (q: any) => memoryProjects.get(q.projectId) || null,
        updateOne: async (q: any, u: any) => {
          const cur = memoryProjects.get(q.projectId) || {};
          const updated: any = { ...cur };
          for (const [key, val] of Object.entries(u.$set || {})) {
            if (key.includes('.')) {
              const parts = key.split('.');
              let target: any = updated;
              for (let i = 0; i < parts.length - 1; i++) {
                target[parts[i]] = target[parts[i]] || {};
                target = target[parts[i]];
              }
              target[parts[parts.length - 1]] = val;
            } else {
              updated[key] = val;
            }
          }
          memoryProjects.set(q.projectId, updated);
          return { matchedCount: 1, modifiedCount: 1 };
        },
        find: () => ({ toArray: async () => [] }),
      }),
    };

    const projectService = new ProjectService();
    projectService.setDbForTesting(mockDb);

    // 11a: Reject raw notification email apiKey
    const resRawEmail = await projectService.updateProject('tenant_secret_guard', {
      notifications: {
        channels: {
          email: { apiKey: 'SG.raw_secret_key_12345' },
        },
      } as any,
    });
    assert.equal(resRawEmail.success, false);
    assert.match(resRawEmail.message || '', /Raw notification apiKey is forbidden/i);

    // 11b: Reject raw notification webhook secret
    const resRawWebhook = await projectService.updateProject('tenant_secret_guard', {
      notifications: {
        channels: {
          webhook: { secret: 'raw_webhook_secret_value' },
        },
      } as any,
    });
    assert.equal(resRawWebhook.success, false);
    assert.match(resRawWebhook.message || '', /Raw notification webhook secret is forbidden/i);

    // 11c: Reject raw AI apiKey
    const resRawAi = await projectService.updateProject('tenant_secret_guard', {
      ai: { apiKey: 'sk-proj-raw_secret_key_abcdef' } as any,
    });
    assert.equal(resRawAi.success, false);
    assert.match(resRawAi.message || '', /Raw AI apiKey is forbidden/i);

    // 11d: Reject raw connector clientSecret
    const resRawConnector = await projectService.updateProject('tenant_secret_guard', {
      integrations: {
        commercetools: { clientSecret: 'super_secret_commercetools_secret' },
      } as any,
    });
    assert.equal(resRawConnector.success, false);
    assert.match(resRawConnector.message || '', /Raw connector credential 'clientSecret'/i);

    // 11e: Accept valid tenant-scoped references only
    const resValidRefs = await projectService.updateProject('tenant_secret_guard', {
      notifications: {
        channels: {
          email: { apiKeyRef: 'vault://tenants/tenant_secret_guard/sendgrid-api-key' },
          webhook: { secretRef: 'vault://tenants/tenant_secret_guard/webhook-secret' },
        },
      } as any,
      integrations: {
        commercetools: { connectionRef: 'conn_ct_tenant_secret_guard' },
      } as any,
    });
    assert.equal(resValidRefs.success, true);

    const savedDoc = memoryProjects.get('tenant_secret_guard');
    assert.ok(savedDoc);
    // Ensure raw fields are not present
    assert.equal(savedDoc.notifications?.channels?.email?.apiKey, undefined);
    assert.equal(savedDoc.notifications?.channels?.webhook?.secret, undefined);
    assert.equal(savedDoc.integrations?.commercetools?.clientSecret, undefined);
    // Ensure refs are persisted
    assert.equal(
      savedDoc.notifications?.channels?.email?.apiKeyRef,
      'vault://tenants/tenant_secret_guard/sendgrid-api-key'
    );
    assert.equal(
      savedDoc.notifications?.channels?.webhook?.secretRef,
      'vault://tenants/tenant_secret_guard/webhook-secret'
    );
    assert.equal(
      savedDoc.integrations?.commercetools?.connectionRef,
      'conn_ct_tenant_secret_guard'
    );
  });

  console.log(`\nStudio Control-Plane Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runJourneyConfigTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
