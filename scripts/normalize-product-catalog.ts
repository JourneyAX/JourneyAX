import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { MongoClient } from 'mongodb';

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || 'journeyx');

  console.log('Normalizing products for workweargroup...');
  const products = await db.collection('products').find({ projectId: 'workweargroup' }).toArray();
  console.log(`Found ${products.length} products to normalize.`);

  let updatedCount = 0;
  for (const p of products) {
    const text = `${p.name || ''} ${p.description || ''} ${p.category || ''}`.toLowerCase();
    
    // 1. Safety features
    const isComposite = text.includes('composite');
    const isSteel = text.includes('steel toe') || text.includes('steel-toe') || (text.includes('steel') && text.includes('toe'));
    const toeProtection: 'composite' | 'steel' | 'none' = isComposite ? 'composite' : isSteel ? 'steel' : 'none';
    
    const certifications: string[] = [];
    if (text.includes('2210.3') || text.includes('as/nzs')) certifications.push('AS/NZS 2210.3');
    if (text.includes('4399') || text.includes('upf')) certifications.push('AS/NZS 4399');

    const safety = {
      toeProtection,
      certifications,
      electricalHazardRated: text.includes('electrical') || text.includes('eh rated') || text.includes('eh-rated'),
      slipResistant: text.includes('slip resistant') || text.includes('slip resistance') || text.includes('src'),
    };

    // 2. Garment features
    const isLightweight = text.includes('lightweight') || text.includes('light weight') || text.includes('ripstop');
    const isHeavyweight = text.includes('heavyweight') || text.includes('fleece') || text.includes('winter');
    const weightClass: 'lightweight' | 'midweight' | 'heavyweight' = isLightweight ? 'lightweight' : isHeavyweight ? 'heavyweight' : 'midweight';

    const season: string[] = [];
    if (isLightweight || text.includes('summer') || text.includes('cool')) season.push('summer');
    if (isHeavyweight || text.includes('winter')) season.push('winter');
    if (season.length === 0) season.push('all-season');

    const garment = {
      weightClass,
      season,
      fabric: text.includes('cotton drill') ? 'cotton drill' : text.includes('ripstop') ? 'ripstop' : undefined,
    };

    // 3. Price normalization (AUD for workweargroup)
    const minVal = p.priceUSD?.min ?? p.price?.amount ?? (p.priceCents ? p.priceCents / 100 : 0);
    const maxVal = p.priceUSD?.max ?? minVal;
    const amount = Number(minVal) || 0;

    const price = {
      amount,
      currency: 'AUD',
      min: Number(minVal) || 0,
      max: Number(maxVal) || 0,
      formatted: `$${amount.toFixed(2)} AUD`,
    };

    const priceCents = Math.round(amount * 100);

    await db.collection('products').updateOne(
      { _id: p._id },
      {
        $set: {
          price,
          priceCents,
          safety,
          garment,
          normalizedAt: new Date(),
        },
      }
    );
    updatedCount++;
  }

  console.log(`✅ Successfully normalized ${updatedCount} products with explicit currency (AUD), safety (composite/steel), and garment specifications!`);
  await client.close();
}

run().catch((err) => {
  console.error('Normalization error:', err);
  process.exit(1);
});
