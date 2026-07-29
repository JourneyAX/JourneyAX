/**
 * Config-driven ingestion runner (the productised path).
 *
 * Contains NO brand URLs, project ids, file paths or model names — everything is
 * read from the project's own config, so the same runner onboards every tenant.
 * Spawned by the service API (gateway-routed); the CLI form is a dev convenience.
 *
 *   npx tsx src/scripts/run-ingest.ts --project <id> [--job <id>] [--only csv-feed,narratives]
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { MongoClient, ObjectId } from 'mongodb';
import { runPipeline, SourceItem } from '../services/knowledge/pipeline';

function arg(n: string) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }
const PROJECT_ID = arg('project');
const JOB_ID = arg('job');
const ONLY = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);

const PROJECT_API = process.env.PROJECT_SERVICE_URL_HTTP || process.env.PROJECT_SERVICE_URL || 'http://localhost:8082';
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';

if (!PROJECT_ID) { console.error('Usage: run-ingest.ts --project <projectId>'); process.exit(1); }

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('journeyx');
  const jobs = db.collection('ingest_jobs');

  const jobFilter = JOB_ID ? { _id: new ObjectId(JOB_ID) } : null;
  const t0 = Date.now();
  const stamp = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  // Verbose by default: every line is timestamped and tagged with the project so
  // an operator watching the service terminal can follow each stage live. The
  // same lines are persisted to the job record for the back office.
  const log = async (msg: string) => {
    console.log(`[ingest ${PROJECT_ID} +${stamp()}] ${msg}`);
    if (jobFilter) await jobs.updateOne(jobFilter, { $set: { updatedAt: new Date() }, $push: { log: { $each: [msg], $slice: -300 } } } as any).catch(() => {});
  };
  const progress = async (patch: Record<string, unknown>) => {
    if (jobFilter) await jobs.updateOne(jobFilter, { $set: { ...patch, updatedAt: new Date() } }).catch(() => {});
  };

  try {
    if (jobFilter) await jobs.updateOne(jobFilter, { $set: { status: 'running', startedAt: new Date() } });

    // Config is the ONLY source of truth for what/how to ingest.
    const res = await fetch(`${PROJECT_API}/api/v1/projects/${encodeURIComponent(PROJECT_ID!)}`, {
      headers: { 'X-Tenant-ID': PROJECT_ID!, 'X-Internal-Key': INTERNAL_KEY },
    });
    if (!res.ok) throw new Error(`project "${PROJECT_ID}" not found (HTTP ${res.status})`);
    const project: any = await res.json();
    const ks = project.knowledgeSource || {};
    const sources: SourceItem[] = Array.isArray(ks.sources) ? ks.sources : [];
    if (!sources.length) {
      throw new Error('No knowledgeSource.sources[] configured — add sources in the back-office Knowledge tab.');
    }
    const ingestModel = project.ai?.ingestModel || project.ai?.model || process.env.INGEST_MODEL || 'gpt-5-mini';
    // Relationship extraction is harder reasoning than narrative writing, so a
    // project may point it at a stronger model. Falls back to the ingest model.
    const extractModel = project.ai?.extractModel || undefined;
    const storageDir = process.env.ARTIFACT_DIR
      ? path.join(process.env.ARTIFACT_DIR, PROJECT_ID!)
      : path.resolve(__dirname, '../../../../data', PROJECT_ID!);

    const out = await runPipeline({ projectId: PROJECT_ID!, db, sources, ingestModel, extractModel, storageDir, log, progress, only: ONLY });

    if (jobFilter) await jobs.updateOne(jobFilter, { $set: { status: 'completed', finishedAt: new Date(), result: out } });
  } catch (e) {
    const msg = (e as Error).message;
    console.error('ingest failed:', msg);
    if (jobFilter) await jobs.updateOne(jobFilter, { $set: { status: 'failed', finishedAt: new Date(), error: msg } });
    await client.close();
    process.exit(1);
  }
  await client.close();
}

main();
