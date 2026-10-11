import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import {
  BusinessPackReleaseSchema,
  validateBusinessPack,
  publishBusinessPack,
  computePackChecksum,
} from '@journeyax/business-pack';

async function run() {
  const baseDir = path.resolve(__dirname, '../packs/placemakers');
  console.log(`Reading PlaceMakers draft pack from: ${baseDir}`);

  const readJson = (file: string, fallback: any = {}) => {
    const p = path.join(baseDir, file);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
  };

  const readJsonArray = (dirName: string) => {
    const dir = path.join(baseDir, dirName);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };

  const rawManifest = readJson('manifest.json');
  const manifest = {
    ...rawManifest,
    packId: 'pack_placemakers',
    tenantId: 'placemakers',
    environmentId: 'production',
    version: rawManifest.version || '1.2.1',
    status: 'active',
    publishedAt: new Date().toISOString(),
    publishedBy: 'platform-closure',
  };

  const packCandidate = {
    manifest,
    profile: readJson('business-profile.json', { companyName: 'PlaceMakers', industry: 'retail-trade' }),
    vocabulary: readJson('vocabulary.json', { terms: [], acronyms: {}, slotSynonyms: {} }),
    entities: readJson('entities.json', { entities: [] }),
    conversationPolicy: {
      maxClarificationQuestionsPerTurn: 3,
      allowJourneySwitch: false,
    },
    modelPolicy: readJson('model-policy.json'),
    agents: readJsonArray('agents'),
    journeys: readJsonArray('journeys'),
    rules: readJsonArray('rules'),
    capabilities: readJson('capabilities/bindings.json', {
      toolDefinitions: [],
      toolBindings: [],
      stageBindings: [],
    }),
    experience: readJson('experience/cards-and-theme.json', {}),
    evaluations: readJsonArray('evaluations'),
    extensions: {
      spacePlanner: readJson('extensions/space-planner.json', undefined),
      ...readJson('extensions.json', {}),
    },
  };

  console.log(`Validating pack schema...`);
  const parsed = BusinessPackReleaseSchema.safeParse(packCandidate);
  if (!parsed.success) {
    console.error('Schema validation errors:', JSON.stringify(parsed.error.format(), null, 2));
    process.exit(1);
  }

  console.log(`Validating business pack integrity...`);
  const validation = validateBusinessPack(parsed.data);
  if (!validation.valid) {
    console.error('Business pack validation errors:', validation.issues);
    process.exit(1);
  }
  if (validation.issues.length > 0) {
    console.warn('Validation warnings:', validation.issues);
  }

  const checksum = computePackChecksum(parsed.data);
  console.log(`Computed release checksum: ${checksum}`);

  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const client = new MongoClient(uri);
  await client.connect();

  const jxDb = client.db('journeyx');
  console.log(`Publishing release v${manifest.version} into journeyx...`);
  const pubResult = await publishBusinessPack(jxDb, parsed.data, {
    publishedBy: 'platform-closure',
    notes: `PlaceMakers materials, fasteners, and hardware release ${manifest.version}`,
  });

  console.log(`✅ Successfully published release:`, {
    version: pubResult.release.manifest.version,
    checksum: pubResult.checksum,
    revision: pubResult.revision,
  });

  // Verify pointer
  const pointer = await jxDb.collection('business_pack_pointers').findOne({
    tenantId: 'placemakers',
    environmentId: 'production',
  });
  console.log(`Pointer updated: activeVersion=${pointer?.activeVersion}, checksum=${pointer?.checksum}`);

  // Also update draft in journeyax.tenant_configs
  const jaxDb = client.db('journeyax');
  const existingConfig = await jaxDb.collection('tenant_configs').findOne({ projectId: 'placemakers' });
  if (existingConfig) {
    await jaxDb.collection('tenant_configs').updateOne(
      { projectId: 'placemakers' },
      {
        $set: {
          activeVersion: 6,
          journeys: parsed.data.journeys,
          entities: parsed.data.entities,
          vocabulary: parsed.data.vocabulary,
          conversationPolicy: parsed.data.conversationPolicy,
          updatedAt: new Date().toISOString(),
        },
      }
    );
    console.log(`Updated journeyax.tenant_configs for placemakers draft`);
  }

  await client.close();
  console.log('Done!');
}

run().catch((err) => {
  console.error('Error publishing release:', err);
  process.exit(1);
});
