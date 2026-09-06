import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

async function check() {
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  await client.connect();
  const jyx = client.db('journeyx');
  const prods = await jyx.collection('products').find({ projectId: 'placemakers' }).toArray();
  const docs = await jyx.collection('documents').find({ projectId: 'placemakers' }).toArray();

  console.log('=== PLACEMAKERS MONGODB VERIFICATION ===');
  console.log('Total Products in journeyx.products:', prods.length);
  console.log('Total Vector Documents in journeyx.documents:', docs.length);

  const byPillar = {};
  for (const p of prods) {
    const pil = p.pillar || 'Shop (Direct)';
    byPillar[pil] = (byPillar[pil] || 0) + 1;
  }
  console.log('\nBreakdown by Pillar:', byPillar);

  const sample = docs[0];
  console.log('\nSample Vector Document:');
  console.log(' - Title:', sample?.title);
  console.log(' - Pillar:', sample?.metadata?.pillar || 'Shop');
  console.log(' - Embedding Dimensions:', sample?.embedding?.length, '(OpenAI text-embedding-3-small)');
  console.log(' - Price:', `$${sample?.metadata?.price} ${sample?.metadata?.currency}`);
  console.log(' - SKU:', sample?.metadata?.sku);

  await client.close();
}

check().catch(console.error);
