import { MongoClient, Db } from 'mongodb';

export * from './types';
export * from './indices';
export * from './outbox';
export * from './notifications';
export * from './assertion';
export * from './replay.store';
export * from './cutover.repository';
export * from './commerce.repository';

type Connection = { client: MongoClient; ready: boolean; connection: Promise<MongoClient>; databases: Map<string, Db> };

/** Pools are keyed by the complete URI. Two source connections never silently share the first cluster opened. */
export class MongoConnectionPool {
  private readonly entries = new Map<string, Connection>();
  constructor(private readonly factory: (uri: string) => MongoClient = uri => new MongoClient(uri)) {}
  async connect(uri: string, database: string): Promise<{ client: MongoClient; db: Db }> {
    if (!uri || !database) throw new Error('An explicit MongoDB connection and database are required.');
    let entry = this.entries.get(uri);
    if (!entry) {
      const client = this.factory(uri);
      entry = { client, ready: false, databases: new Map(), connection: Promise.resolve(client) };
      const current = entry;
      this.entries.set(uri, entry);
      entry.connection = client.connect().then(() => { current.ready = true; return client; }).catch(async error => {
        if (this.entries.get(uri) === current) this.entries.delete(uri);
        await client.close().catch(() => {});
        throw error;
      });
    }
    await entry.connection;
    return { client: entry.client, db: this.database(entry, database) };
  }
  get(database: string, uri?: string): Db {
    const entry = uri ? this.entries.get(uri) : this.entries.size === 1 ? [...this.entries.values()][0] : undefined;
    if (!entry?.ready) throw new Error('No unambiguous connected MongoDB source. Name its URI or call connectToDatabase first.');
    return this.database(entry, database);
  }
  private database(entry: Connection, name: string): Db {
    let db = entry.databases.get(name);
    if (!db) { db = entry.client.db(name); entry.databases.set(name, db); }
    return db;
  }
  async close(): Promise<void> {
    const entries = [...this.entries.values()]; this.entries.clear();
    await Promise.allSettled(entries.map(async entry => { await entry.connection.catch(() => {}); await entry.client.close(); }));
  }
}
const pool = new MongoConnectionPool();
let testDbInstance: any = null;
/** Explicit storage injection for isolated tests; it does not open a network connection. */
export function setTestDatabase(mock: any): void { testDbInstance = mock; }
export async function connectToDatabase(uri: string, dbName = process.env.MONGODB_DB_NAME || 'journeyx'): Promise<{ client: MongoClient; db: Db }> {
  if (testDbInstance) return { client: testDbInstance.client || ({} as any), db: testDbInstance.db || testDbInstance };
  return pool.connect(uri, dbName);
}
export function getDb(dbName = process.env.MONGODB_DB_NAME || 'journeyx', uri = process.env.MONGODB_URI): Db { return pool.get(dbName, uri); }
export async function closeDatabase(): Promise<void> { await pool.close(); }
export * from './service-identity';
