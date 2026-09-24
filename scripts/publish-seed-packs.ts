import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { connectToDatabase } from '@journeyax/database';
import { BusinessPackLoader, publishBusinessPack } from '@journeyax/business-pack';

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }

  const { db, client } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
  const loader = new BusinessPackLoader();

  const tenants = ['workweargroup', 'royalcyber'];

  for (const tenantId of tenants) {
    console.log(`\nCompiling and publishing Business Pack for '${tenantId}'...`);
    // Load from disk
    const diskPack = await loader.loadFromDisk(tenantId, 'production');
    if (!diskPack) {
      console.warn(`Could not load pack for '${tenantId}' from disk.`);
      continue;
    }

    const { release, checksum, revision } = await publishBusinessPack(db, diskPack, {
      publishedBy: 'seed-migration',
      notes: 'Initial canonical publish from disk seed',
    });

    console.log(`✅ Successfully published '${tenantId}' v${release.manifest.version}:`);
    console.log(`   - Checksum: ${checksum}`);
    console.log(`   - Pointer revision: ${revision}`);
    console.log(`   - Environment: ${release.manifest.environmentId}`);
  }

  await client.close();
  console.log('\n🎉 All seed Business Packs published to MongoDB!');
}

run().catch((err) => {
  console.error('Failed to publish seed packs:', err);
  process.exit(1);
});
