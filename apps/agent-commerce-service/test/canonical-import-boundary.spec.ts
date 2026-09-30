import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalRuntimeAdapter } from '../src/runtime/canonical-runtime.adapter';
import { TenantRuntimeActivationRouter } from '../src/runtime/tenant-runtime-activation.router';
import { JourneyCoordinator } from '../src/orchestration/journey-coordinator';
import { ConfigLoader } from '../src/pipeline/config-loader';

async function runImportBoundarySuite() {
  console.log('🧪 Running Canonical Path Import Boundary & Legacy Isolation Suite...');

  const FORBIDDEN_LEGACY_PATTERNS = [
    /from\s+['"][^'"]*\/legacy\//,
    /from\s+['"][^'"]*tool-dispatcher/,
    /from\s+['"][^'"]*trade-orchestrator/,
    /from\s+['"][^'"]*project-calculator/,
    /from\s+['"][^'"]*policy-enforcer/,
    /from\s+['"][^'"]*intent-resolver/,
    /from\s+['"][^'"]*retrieval-router/,
    /from\s+['"][^'"]*journey-memory/,
    /\bToolDispatcher\b/,
    /\bTradeOrchestrator\b/,
    /\bProjectCalculatorService\b/,
    /\bPolicyEnforcer\b/,
    /\bIntentResolver\b/,
  ];

  // 1. Scan apps/agent-commerce-service/src/runtime
  console.log('1. Scanning Agent Commerce canonical runtime adapter directory...');
  const runtimeDir = path.resolve(__dirname, '../src/runtime');
  const runtimeFiles = fs.readdirSync(runtimeDir).filter((f) => f.endsWith('.ts'));

  assert.ok(runtimeFiles.length >= 2, 'Runtime directory must contain adapter and router');

  for (const file of runtimeFiles) {
    const fullPath = path.join(runtimeDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');

    for (const pattern of FORBIDDEN_LEGACY_PATTERNS) {
      assert.ok(
        !pattern.test(content),
        `Canonical runtime file '${file}' violates import boundary: matched forbidden legacy pattern ${pattern}`
      );
    }
  }
  console.log('   ✅ PASS: apps/agent-commerce-service/src/runtime has ZERO legacy imports');

  // 2. Scan apps/journey-runtime-service/src
  console.log('2. Scanning canonical apps/journey-runtime-service/src...');
  const journeyRuntimeSrcDir = path.resolve(__dirname, '../../journey-runtime-service/src');

  function scanDirRecursively(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanDirRecursively(full));
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        results.push(full);
      }
    }
    return results;
  }

  const journeyRuntimeFiles = scanDirRecursively(journeyRuntimeSrcDir);
  assert.ok(journeyRuntimeFiles.length > 10, 'Journey Runtime source files must be found');

  for (const filePath of journeyRuntimeFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relName = path.relative(journeyRuntimeSrcDir, filePath);

    assert.ok(
      !content.includes('agent-commerce-service'),
      `Journey Runtime file '${relName}' must not reference agent-commerce-service`
    );
    assert.ok(
      !/from\s+['"][^'"]*project-calculator/.test(content),
      `Journey Runtime file '${relName}' must not import project-calculator`
    );
    assert.ok(
      !/from\s+['"][^'"]*tool-dispatcher/.test(content),
      `Journey Runtime file '${relName}' must not import legacy tool-dispatcher`
    );
    assert.ok(
      !/from\s+['"][^'"]*trade-orchestrator/.test(content),
      `Journey Runtime file '${relName}' must not import legacy trade-orchestrator`
    );
  }
  console.log('   ✅ PASS: apps/journey-runtime-service/src has ZERO legacy or agent-commerce imports');

  // 3. Runtime isolation proof: Canonical execution NEVER invokes legacy adapter
  console.log('3. Proving runtime invocation boundary in JourneyCoordinator...');
  let legacyInvoked = false;
  let canonicalInvoked = false;

  const mockActivationRouter = new TenantRuntimeActivationRouter();
  mockActivationRouter.resolveActivation = async () => ({
    action: 'CANONICAL',
    record: {
      tenantId: 'tenant-boundary-test',
      environmentId: 'production',
      status: 'migrated',
      approvedReleaseVersion: '1.0.0',
      approvedReleaseChecksum: 'chk_ok',
      revision: 1,
      approvedBy: 'security-governor',
      promotedAt: new Date().toISOString(),
      updatedAt: new Date(),
    },
    routingKey: 'ws_boundary',
    reason: 'Approved release',
  });

  const mockCanonicalRuntime = new CanonicalRuntimeAdapter();
  mockCanonicalRuntime.runTurn = async () => {
    canonicalInvoked = true;
    return {
      decision: { decisionId: 'd1', type: 'continue', payload: {}, reason: 'ok', createdAt: new Date().toISOString() },
      workspaceState: { tenantId: 'tenant-boundary-test', environmentId: 'production', workspaceId: 'ws_boundary' } as any,
      uiInstructions: [],
      assistantMessage: 'Canonical response',
    };
  };

  const mockLegacyAdapter = {
    executeLegacyChat: async () => {
      legacyInvoked = true;
      throw new Error('SECURITY VIOLATION: Legacy adapter must NOT be called for canonical tenant');
    },
    executeLegacyChatStream: async () => {
      legacyInvoked = true;
      throw new Error('SECURITY VIOLATION: Legacy adapter must NOT be called for canonical tenant');
    },
  } as any;

  const coordinator = new JourneyCoordinator(
    mockActivationRouter,
    mockCanonicalRuntime,
    mockLegacyAdapter,
    new ConfigLoader()
  );

  const res = await coordinator.executeChat({
    tenantId: 'tenant-boundary-test',
    message: 'Hello boundary',
  });

  assert.equal(canonicalInvoked, true, 'Canonical runtime must be invoked');
  assert.equal(legacyInvoked, false, 'Legacy adapter must NEVER be invoked');
  assert.equal(res.message.content, 'Canonical response');
  console.log('   ✅ PASS: Canonical tenant routes exclusively to canonical runtime without touching legacy path\n');

  console.log('🎉 CANONICAL IMPORT BOUNDARY & ISOLATION FULLY VERIFIED!\n');
}

runImportBoundarySuite().catch((err) => {
  console.error('❌ Import boundary suite failed:', err);
  process.exit(1);
});
