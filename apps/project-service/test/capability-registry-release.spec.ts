import assert from 'node:assert/strict';
import { BusinessPackContentSchema, computePackChecksum } from '@journeyax/business-pack';
import { setTestDatabase } from '@journeyax/database';
import { CapabilityRegistryService } from '../src/capability-registry.service';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';

/**
 * Capability registry reads persisted releases ONLY through the authoritative verifier.
 * It must reject malformed / mismatched releases before returning any tool configuration.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const content = (manifestPatch: Record<string, unknown> = {}) => {
  const c: any = BusinessPackContentSchema.parse(clone(rawLegacyFixture));
  c.manifest = { ...c.manifest, ...manifestPatch };
  return c;
};

function storedRelease(c: any, envelope: Record<string, unknown> = {}, shape: 'flat' | 'nested' = 'flat') {
  const env = {
    tenantId: c.manifest.tenantId,
    environmentId: c.manifest.environmentId,
    version: c.manifest.version,
    versionId: c.manifest.version,
    status: 'published',
    checksum: computePackChecksum(c),
    ...envelope,
  };
  return shape === 'nested' ? { ...env, packData: c } : { ...env, ...c };
}

function mockDb(releases: any[], pointers: any[]) {
  const match = (doc: any, q: any) => Object.entries(q).every(([k, v]) => doc[k] === v);
  return {
    collection: (name: string) => {
      if (name === 'business_pack_releases') return { findOne: async (q: any) => releases.find((r) => match(r, q)) || null };
      if (name === 'business_pack_pointers') return { findOne: async (q: any) => pointers.find((p) => match(p, q)) || null };
      return { find: () => ({ toArray: async () => [] }), findOne: async () => null };
    },
  };
}

const pointerFor = (checksum: string, extra: Record<string, unknown> = {}) => ({
  tenantId: 'placemakers',
  environmentId: 'production',
  activeVersion: '1.0.0',
  checksum,
  ...extra,
});

async function main() {
  console.log('🔐 Running Capability Registry release-verification tests...\n');
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://offline-test-double';
  let passed = 0;
  let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}: ${err.message}`);
      failed++;
    }
  }

  const registry = new CapabilityRegistryService();
  const discover = async (releases: any[], pointers: any[], version?: string) => {
    setTestDatabase(mockDb(releases, pointers));
    try {
      return await registry.discoverCapabilitiesForTenant('placemakers', 'production', version);
    } finally {
      setTestDatabase(null);
    }
  };
  const rejects = async (releases: any[], pointers: any[], pattern: RegExp, version?: string) => {
    await assert.rejects(() => discover(releases, pointers, version), pattern);
  };

  await test('verified flat release (via pointer) returns tool definitions from verified content', async () => {
    const rel = storedRelease(content());
    const tools = await discover([rel], [pointerFor(rel.checksum)]);
    assert.ok(tools.some((t) => t.toolId === 'catalog.search'));
  });

  await test('verified nested packData release returns the same tool definitions', async () => {
    const rel = storedRelease(content(), {}, 'nested');
    const tools = await discover([rel], [pointerFor(rel.checksum)]);
    assert.ok(tools.some((t) => t.toolId === 'catalog.search'));
  });

  await test('legacy release missing persisted `extensions` is accepted (read-only normalization)', async () => {
    const rel = storedRelease(content());
    delete (rel as any).extensions;
    const tools = await discover([rel], [pointerFor(rel.checksum)]);
    assert.ok(tools.some((t) => t.toolId === 'catalog.search'));
  });

  await test('Tenant-A envelope containing Tenant-B content is rejected before returning tools', async () => {
    const rel = storedRelease(content({ tenantId: 'tenant-b' }), { tenantId: 'placemakers' });
    await rejects([rel], [pointerFor(rel.checksum)], /identity_mismatch/);
  });

  await test('production envelope containing staging content is rejected', async () => {
    const rel = storedRelease(content({ environmentId: 'staging' }), { environmentId: 'production' });
    await rejects([rel], [pointerFor(rel.checksum)], /identity_mismatch/);
  });

  await test('envelope version differing from manifest version is rejected', async () => {
    const rel = storedRelease(content({ version: '1.0.1' }), { version: '1.0.0', versionId: '1.0.0' });
    await rejects([rel], [pointerFor(rel.checksum)], /identity_mismatch/);
  });

  await test('pointer checksum differing from the verified release checksum is rejected', async () => {
    const rel = storedRelease(content());
    await rejects([rel], [pointerFor('0'.repeat(64))], /pointer_checksum_mismatch/);
  });

  await test('active pointers with missing or blank checksums are rejected before returning tools', async () => {
    const rel = storedRelease(content());
    await rejects([rel], [pointerFor(rel.checksum, { checksum: undefined })], /missing its mandatory checksum/);
    await rejects([rel], [pointerFor(rel.checksum, { checksum: '   ' })], /missing its mandatory checksum/);
  });

  await test('tampered content / checksum mismatch is rejected', async () => {
    const rel: any = storedRelease(content());
    rel.profile = { ...rel.profile, companyName: 'Tampered' };
    await rejects([rel], [pointerFor(rel.checksum)], /checksum_mismatch/);
  });

  await test('incomplete / withdrawn releases are rejected', async () => {
    const incomplete: any = storedRelease(content());
    delete incomplete.vocabulary;
    await rejects([incomplete], [pointerFor(incomplete.checksum)], /incomplete_content/);
    const withdrawn = storedRelease(content(), { status: 'withdrawn' });
    await rejects([withdrawn], [pointerFor(withdrawn.checksum)], /withdrawn/);
  });

  await test('explicitly requested version is enforced against envelope and content', async () => {
    const rel = storedRelease(content(), { version: '2.0.0', versionId: '2.0.0' });
    await rejects([rel], [], /identity_mismatch/, '2.0.0');
  });

  console.log(`\nCapability Registry Release Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
