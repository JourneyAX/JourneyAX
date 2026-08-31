/**
 * Deliberate scope decision (documented in the ingest report): PlaceMakers has
 * 41,221 real products from the csv-feed stage. The `narratives` stage calls an
 * LLM + embeddings per product with no CLI-level limit — a prior ingest run
 * showed ~16 minutes for 1,722 A&F products, so a full 41,221-product narrative
 * pass would run for many hours. Rather than let that run unverified for a full
 * session, this calls the SAME real `stageNarratives` function (from
 * pipeline.ts, unmodified) directly with `{ limit: 300 }`, to prove the stage
 * genuinely works end-to-end against the real PlaceMakers products and produce
 * verifiable narrative documents within a reasonable session.
 *
 * The other 40,921 products remain narrative-less (`narrativeAt` unset) after
 * this run and can be finished later by simply running:
 *   npx tsx src/scripts/run-ingest.ts --project placemakers --job <id> --only narratives
 * (no --limit needed there — it will pick up all remaining un-narrated products).
 *
 * Usage: npx tsx src/scripts/ingest-placemakers-narratives-sample.ts
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { MongoClient, ObjectId } from 'mongodb';
import { stageNarratives } from '../services/knowledge/pipeline';

const JOB_ID = '6a8ae5c7b5fd2e723e590b6f';
const PROJECT_ID = 'placemakers';
const SAMPLE_LIMIT = 300;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('journeyx');
  const jobs = db.collection('ingest_jobs');
  const jobFilter = { _id: new ObjectId(JOB_ID) };

  const log = async (msg: string) => {
    console.log(`[narratives-sample] ${msg}`);
    await jobs.updateOne(jobFilter, { $push: { log: { $each: [msg], $slice: -300 } }, $set: { updatedAt: new Date() } } as any).catch(() => {});
  };
  const progress = async (patch: Record<string, unknown>) => {
    await jobs.updateOne(jobFilter, { $set: { ...patch, updatedAt: new Date() } }).catch(() => {});
  };

  await log(`narratives (SAMPLE, limit=${SAMPLE_LIMIT}): starting — deliberate scope decision, see script header comment`);
  const n = await stageNarratives(
    { projectId: PROJECT_ID, db, sources: [], ingestModel: 'gpt-4o-mini', storageDir: '', log, progress },
    { limit: SAMPLE_LIMIT },
  );
  await log(`narratives (SAMPLE): ${n} narrative(s) written`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
