import * as path from 'path'; import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') }); dotenv.config({ path: path.resolve(process.cwd(), '.env') });
import { getCollection } from './apps/journeyax-web/src/services/knowledge/mongo';
(async () => {
  const col = await getCollection();
  const q = (f:any)=>col.countDocuments(f);
  console.log('products total:', await q({'metadata.type':'product'}));
  console.log('  with specs:', await q({'metadata.type':'product','metadata.specs':{$exists:true}}));
  console.log('  with price:', await q({'metadata.type':'product','metadata.price':{$exists:true}}));
  console.log('  with image:', await q({'metadata.type':'product','metadata.images.0':{$exists:true}}));
  console.log('designs:', await q({'metadata.type':'design'}));
  console.log('technical(PDF):', await q({'metadata.type':'technical'}));
  console.log('troubleshooting(PDF):', await q({'metadata.type':'troubleshooting'}));
  process.exit(0);
})();
