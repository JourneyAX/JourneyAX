import { validateBusinessPack } from '../packages/business-pack/src';
import { BusinessPackLoader } from '../packages/business-pack/src/loader';
import * as path from 'path';

async function main() {
  console.log('--- Testing Royal Cyber Business Pack Loader ---');
  const loader = new BusinessPackLoader({
    localPacksRoot: path.resolve(__dirname, '../packs'),
  });

  const pack = await loader.loadPublished('royalcyber', 'production', '1.0.0');
  console.log(`✅ Loaded pack: ${pack.manifest.packId}@${pack.manifest.version} for tenant ${pack.manifest.tenantId}`);
  console.log(`   Business Name: ${pack.profile.companyName}`);
  console.log(`   Industry: ${pack.profile.industry}`);
  console.log(`   Currency: ${pack.profile.primaryCurrency}`);
  console.log(`   Journeys defined: ${pack.journeys.map((j) => j.journeyId).join(', ')}`);
  console.log(`   Capabilities defined: ${pack.capabilities.toolDefinitions.length} tools, ${pack.capabilities.toolBindings.length} bindings`);
  console.log(`   Rules defined: ${pack.rules.length} rules`);
  console.log(`   Agents defined: ${pack.agents.map((a) => a.agentId).join(', ')}`);

  const validation = validateBusinessPack(pack);
  console.log(`   Validation valid: ${validation.valid}`);
  console.log(`   Validation issues count: ${validation.issues.length}`);
  if (validation.issues.length > 0) {
    console.log('   Issues:', JSON.stringify(validation.issues, null, 2));
  }

  if (!validation.valid) {
    process.exit(1);
  }

  console.log('🎉 Royal Cyber Business Pack is 100% valid!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
