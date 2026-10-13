/**
 * READ-ONLY capture of the structure of a tenant's active Business Pack (journeys, stages, capability plans, experience,
 * fact registry, capability definitions). It never writes to the database and records no credentials or model keys.
 * Run it yourself against the environment you want captured; the output is a plain JSON file that tests can use as a fixture.
 *
 *   node --env-file=.env --import tsx scripts/inventory/capture-pack-structure.ts [tenantId] [environmentId]
 *
 * Output: docs/inventory/<tenant>-pack-structure-<date>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectToDatabase } from '@journeyax/database';

const TENANT = (process.argv[2] || 'placemakers').toLowerCase();
const ENVIRONMENT = process.argv[3] || 'production';
const stamp = new Date().toISOString().slice(0, 10);

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required (read-only use)');
  const runtimeName = process.env.RUNTIME_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx';
  const projectName = process.env.PROJECT_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyax';
  const { db } = await connectToDatabase(uri, runtimeName);
  const { db: projects } = await connectToDatabase(uri, projectName);
  const pointer: any = await db.collection('business_pack_pointers').findOne({ tenantId: TENANT, environmentId: ENVIRONMENT });
  if (!pointer) throw new Error(`No ${ENVIRONMENT} pointer for ${TENANT}`);
  const release: any = await db.collection('business_pack_releases').findOne({ tenantId: TENANT, environmentId: ENVIRONMENT, version: pointer.activeVersion });
  if (!release) throw new Error(`Release ${pointer.activeVersion} not found`);
  const pack = release.packData || release;
  const project: any = await projects.collection('tenant_configs').findOne({ projectId: TENANT });
  const structure = {
    tenant: TENANT, environmentId: ENVIRONMENT, capturedAt: new Date().toISOString(), source: 'business_pack_releases + tenant_configs (read-only)',
    version: release.version, checksum: release.checksum,
    packKeys: Object.keys(pack),
    profile: pack.profile, routingPolicy: pack.routingPolicy, journeys: pack.journeys, experience: pack.experience,
    capabilities: pack.capabilities, factRegistry: pack.factRegistry ?? null, knowledgeModel: pack.knowledgeModel ?? null,
    catalogMapping: pack.catalogMapping ?? null, extensions: pack.extensions ?? null,
    projectSettings: project ? { pricing: project.pricing ?? null, profile: project.profile ?? null, routingPolicy: project.routingPolicy ?? null } : null,
  };
  const out = path.resolve(__dirname, `../../docs/inventory/${TENANT}-pack-structure-${stamp}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(structure, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), out)} (${Buffer.byteLength(JSON.stringify(structure))} bytes)`);
  process.exit(0);
})().catch((error) => { console.error(error.message || error); process.exit(1); });
