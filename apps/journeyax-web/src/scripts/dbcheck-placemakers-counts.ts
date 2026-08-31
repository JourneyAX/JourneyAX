import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });
import { MongoClient } from 'mongodb';

async function main() {
  const uri = process.env.MONGODB_URI!;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('journeyx');
  const products = await db.collection('products').countDocuments({ projectId: 'placemakers' });
  const docsGeneral = await db.collection('documents').countDocuments({ projectId: 'placemakers', 'metadata.type': { $in: ['general', 'faq'] } });
  const docsAll = await db.collection('documents').countDocuments({ projectId: 'placemakers' });
  console.log(JSON.stringify({ products, docsGeneral, docsAll }, null, 2));
  await client.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
