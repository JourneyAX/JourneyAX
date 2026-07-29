/**
 * Server-only Mongo access for the back office's Next.js API routes.
 *
 * The scraped knowledge base lives in DB `journeyx`, collection `documents`
 * (separate from the `journeyax` tenant-config DB). We connect directly with the
 * `mongodb` driver (a direct dep of this app) and cache the client across route
 * invocations. NEVER import this from a client component.
 */
import { MongoClient, Db, Collection } from 'mongodb';
import { resolve } from 'path';
import { config } from 'dotenv';

// The MONGODB_URI lives in the monorepo root .env (same as every service).
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const KNOWLEDGE_DB = 'journeyx';
const DOCUMENTS = 'documents';

let cached: MongoClient | null = null;

async function client(): Promise<MongoClient> {
  if (cached) return cached;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set (checked monorepo root .env)');
  cached = await new MongoClient(uri).connect();
  return cached;
}

export async function knowledgeDb(): Promise<Db> {
  return (await client()).db(KNOWLEDGE_DB);
}

export async function documentsCollection(): Promise<Collection> {
  return (await knowledgeDb()).collection(DOCUMENTS);
}

/** Ingest job status docs written by scripts/ingest-project.ts (B4). */
export async function ingestJobsCollection(): Promise<Collection> {
  return (await knowledgeDb()).collection('ingest_jobs');
}
