const { MongoClient } = require('mongodb');
require('dotenv').config();

const SOURCE_URI = process.env.MONGODB_URI;
const TARGET_URI = process.env.MONGODB_QA_URI;

if (!SOURCE_URI || !TARGET_URI) {
  console.error("Missing MONGODB_URI or MONGODB_QA_URI in .env");
  process.exit(1);
}

const sourceClient = new MongoClient(SOURCE_URI);
const targetClient = new MongoClient(TARGET_URI);

const DATABASES_TO_MIGRATE = ['journeyax', 'journeyx'];
const PROJECT_ID = 'augusta';

async function copySearchIndexes(sourceDb, targetDb, collectionName) {
  try {
    const searchIndexes = await sourceDb.collection(collectionName).listSearchIndexes().toArray();
    if (searchIndexes.length > 0) {
      console.log(`Replicating ${searchIndexes.length} search index(es) for ${collectionName}...`);
      for (const idx of searchIndexes) {
        // Prepare definition (remove read-only fields returned by listSearchIndexes)
        const def = {
          name: idx.name,
          definition: idx.latestDefinition,
          type: idx.type
        };
        
        try {
          await targetDb.collection(collectionName).createSearchIndexes([def]);
          console.log(` - Created search index '${idx.name}' on ${collectionName}`);
        } catch (e) {
          if (e.codeName === 'IndexAlreadyExists') {
            console.log(` - Search index '${idx.name}' already exists on ${collectionName}`);
          } else {
            console.error(` - Error creating search index '${idx.name}':`, e.message);
          }
        }
      }
    }
  } catch (e) {
    // If search indexes are not supported or collection is empty
  }
}

async function copyStandardIndexes(sourceDb, targetDb, collectionName) {
  try {
    const indexes = await sourceDb.collection(collectionName).listIndexes().toArray();
    for (const idx of indexes) {
      if (idx.name === '_id_') continue; // Default index
      
      const opts = { name: idx.name };
      if (idx.unique !== undefined && idx.unique !== null) opts.unique = idx.unique;
      if (idx.sparse !== undefined && idx.sparse !== null) opts.sparse = idx.sparse;
      if (typeof idx.expireAfterSeconds === 'number') opts.expireAfterSeconds = idx.expireAfterSeconds;
      
      try {
        await targetDb.collection(collectionName).createIndex(idx.key, opts);
        console.log(` - Created index '${idx.name}' on ${collectionName}`);
      } catch (e) {
        console.error(` - Error creating index '${idx.name}':`, e.message);
      }
    }
  } catch (e) {
    // Collection might not exist yet in source
  }
}

async function ensureCollectionExists(db, collectionName) {
  const collections = await db.listCollections({ name: collectionName }).toArray();
  if (collections.length === 0) {
    await db.createCollection(collectionName);
    console.log(` - Created collection '${collectionName}'`);
  }
}

async function migrateCollection(sourceDb, targetDb, collectionName) {
  console.log(`\n--- Processing collection: ${collectionName} ---`);
  
  // Ensure collection exists so index creation doesn't fail
  await ensureCollectionExists(targetDb, collectionName);
  
  // 1. Replicate Indexes
  await copyStandardIndexes(sourceDb, targetDb, collectionName);
  await copySearchIndexes(sourceDb, targetDb, collectionName);
  
  // 2. Fetch Data Subset
  const query = {
    $or: [
      { projectId: PROJECT_ID },
      { tenantId: PROJECT_ID },
      { brand: PROJECT_ID }
    ]
  };
  
  const documents = await sourceDb.collection(collectionName).find(query).toArray();
  if (documents.length === 0) {
    console.log(`No '${PROJECT_ID}' documents found in ${collectionName}. Skipping data migration.`);
    return;
  }
  
  console.log(`Found ${documents.length} documents for '${PROJECT_ID}'.`);
  
  // 3. Wipe ALL existing data in QA to ensure an exclusive Augusta environment
  await targetDb.collection(collectionName).deleteMany({});
  console.log(`Wiped all existing data in QA collection '${collectionName}'.`);
  
  // 4. Insert into QA
  const result = await targetDb.collection(collectionName).insertMany(documents);
  console.log(`Successfully inserted ${result.insertedCount} documents into QA.`);
}

async function run() {
  console.log("=========================================");
  console.log("   AUGUSTA MIGRATION (PROD -> QA)        ");
  console.log("=========================================");
  
  // Extract cluster hostname for clear logging
  const sourceHost = new URL(SOURCE_URI).hostname;
  const targetHost = new URL(TARGET_URI).hostname;
  
  console.log(`Source Cluster: ${sourceHost}`);
  console.log(`Target Cluster: ${targetHost}\n`);
  
  try {
    await sourceClient.connect();
    await targetClient.connect();
    
    // Note: The production cluster uses TWO distinct databases:
    // 1. journeyax (contains tenant_configs, etc.)
    // 2. journeyx  (contains documents, products, users, etc.)
    // We will migrate both to the QA cluster, keeping the exact same database names.
    for (const dbName of DATABASES_TO_MIGRATE) {
      console.log(`\n========================================`);
      console.log(` Migrating Database: '${dbName}'`);
      console.log(` From: ${sourceHost} -> To: ${targetHost}`);
      console.log(`========================================`);
      
      const sourceDb = sourceClient.db(dbName);
      const targetDb = targetClient.db(dbName);
      
      const collections = await sourceDb.listCollections().toArray();
      for (const col of collections) {
        // Skip system collections
        if (col.name.startsWith('system.')) continue;
        await migrateCollection(sourceDb, targetDb, col.name);
      }
    }
    
    console.log("\nMigration completed successfully.");
    
  } catch (e) {
    console.error("Migration failed:", e);
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

run();
