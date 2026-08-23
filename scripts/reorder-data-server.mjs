import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';

config({ path: '.env.local' });

const PORT = Number(process.env.REORDER_DATA_API_PORT || 3101);
const DATASET = 'journeyax-coms-reorder-poc';
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'journeyax_poc';
const collectionName = process.env.MONGODB_REORDER_COLLECTION || 'coms_orders';
const ignoredTerms = new Set([
  'i', 'want', 'to', 'reorder', 'repeat', 'our', 'the', 'uniform', 'uniforms',
  'order', 'orders', 'show', 'find', 'please',
]);

if (!uri) throw new Error('MONGODB_URI is missing from .env.local.');

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1_500 });
let mongoConnected = false;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFilter(search) {
  const terms = search
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/\s+/)
    .filter((term) => term.length > 1 && !ignoredTerms.has(term));

  if (!terms.length) return { dataset: DATASET };
  return {
    dataset: DATASET,
    $and: terms.map((term) => ({
      $or: ['id', 'po', 'account', 'school', 'team', 'sport', 'season'].map((field) => ({
        [field]: { $regex: escapeRegex(term), $options: 'i' },
      })),
    })),
  };
}

const projection = {
  _id: 0,
  id: 1,
  po: 1,
  account: 1,
  school: 1,
  team: 1,
  sport: 1,
  season: 1,
  approvedAt: 1,
  unitPrice: 1,
  status: 1,
  artOwner: 1,
  proofCount: 1,
  design: 1,
  roster: 1,
};

async function loadSnapshot(search) {
  const text = await readFile('data/coms-reorder-poc.json', 'utf8');
  const records = JSON.parse(text);
  const terms = search
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/\s+/)
    .filter((term) => term.length > 1 && !ignoredTerms.has(term));
  if (!terms.length) return records.slice(0, 20);
  return records.filter((record) => {
    const searchable = `${record.id} ${record.po} ${record.account} ${record.school} ${record.team} ${record.sport} ${record.season}`.toLowerCase().replace(/[’']/g, '');
    return terms.every((term) => searchable.includes(term));
  }).slice(0, 20);
}

async function loadOrders(search) {
  try {
    if (!mongoConnected) {
      await client.connect();
      mongoConnected = true;
    }
    const records = await client
      .db(dbName)
      .collection(collectionName)
      .find(buildFilter(search), { projection })
      .sort({ id: 1 })
      .limit(20)
      .toArray();
    return { records, source: 'mongodb' };
  } catch {
    mongoConnected = false;
    console.warn('MongoDB unavailable; serving the sanitized local snapshot.');
    return { records: await loadSnapshot(search), source: 'snapshot' };
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  if (request.method !== 'GET' || requestUrl.pathname !== '/orders') {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  try {
    const search = requestUrl.searchParams.get('q')?.trim().slice(0, 120) || '';
    const payload = await loadOrders(search);
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(JSON.stringify(payload));
  } catch (error) {
    console.error('Order lookup failed:', error instanceof Error ? error.message : 'Unknown error');
    response.writeHead(503, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(JSON.stringify({ error: 'Reorder history is temporarily unavailable.' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`JourneyAX reorder data service ready on http://127.0.0.1:${PORT}`);
});

async function shutdown() {
  server.close();
  await client.close();
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
