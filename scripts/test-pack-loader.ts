import { BusinessPackLoader, validateBusinessPack } from '../packages/business-pack/src';
import * as path from 'path';

async function main() {
  console.log('--- Testing Business Pack Loader ---');
  const loader = new BusinessPackLoader({
    localPacksRoot: path.resolve(__dirname, '../packs/workweargroup'),
  });

  const pack = await loader.loadPublished('workweargroup', 'production', '1.0.0');
  console.log('✅ Successfully loaded Business Pack:', pack.manifest.name, 'v' + pack.manifest.version);
  console.log('Profile:', pack.profile.companyName, '| Industry:', pack.profile.industry);
  console.log('Journeys count:', pack.journeys.length);
  console.log('Agents count:', pack.agents.length);
  console.log('Tools count:', pack.capabilities.toolDefinitions.length);
  console.log('Rules count:', pack.rules.length);
  console.log('Evaluations count:', pack.evaluations.length);

  const validation = validateBusinessPack(pack);
  console.log('Semantic Validation Result:', validation.valid ? 'PASSED ✅' : 'FAILED ❌');
  if (validation.issues.length > 0) {
    console.log('Issues/Warnings:', validation.issues);
  }

  if (!validation.valid) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
