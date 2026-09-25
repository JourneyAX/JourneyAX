import { MongoClient, Db } from 'mongodb';

export * from './types';
export * from './indices';
export * from './outbox';
export * from './notifications';
export * from './assertion';
export * from './replay.store';
export * from './cutover.repository';

let client: MongoClient | null = null;
const dbs = new Map<string, Db>();
let testDbInstance: any = null;

/**
 * Injects a test database mock for unit/isolated route testing.
 */
export function setTestDatabase(mock: any): void {
  testDbInstance = mock;
}

/**
 * Connects to MongoDB, manages the connection pool, and returns the requested database.
 */
export async function connectToDatabase(
  uri: string,
  dbName: string = process.env.MONGODB_DB_NAME || 'journeyx'
): Promise<{ client: MongoClient; db: Db }> {
  if (testDbInstance) {
    return { client: client || ({} as any), db: testDbInstance };
  }

  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }

  let dbInstance = dbs.get(dbName);
  if (!dbInstance) {
    dbInstance = client.db(dbName);
    dbs.set(dbName, dbInstance);
  }

  return { client, db: dbInstance };
}

/**
 * Returns the active MongoDB database instance for the specified database name.
 */
export function getDb(dbName: string = process.env.MONGODB_DB_NAME || 'journeyx'): Db {
  if (!client) {
    throw new Error('Database client not initialized. Call connectToDatabase first.');
  }

  let dbInstance = dbs.get(dbName);
  if (!dbInstance) {
    dbInstance = client.db(dbName);
    dbs.set(dbName, dbInstance);
  }

  return dbInstance;
}

/**
 * Closes the active MongoDB connection and clears the database cache.
 */
export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
  dbs.clear();
}
