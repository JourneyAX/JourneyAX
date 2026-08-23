import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';

type CsvRow = Record<string, string>;
type Size = 'YS' | 'YM' | 'YL' | 'XS' | 'S' | 'M' | 'L' | 'XL' | '2XL';

type RosterEntry = {
  id: string;
  number: string;
  name: string;
  size: Size;
  quantity: number;
};

const SCHOOL_TEMPLATES = [
  ['Lakeshore Central High School', 'Girls’ Volleyball', 'LAKESHORE', 'LC', 'Navy', 'Silver'],
  ['Northstar Preparatory Academy', 'Boys’ Basketball', 'NORTHSTAR', 'NP', 'Black', 'Gold'],
  ['Prairie Ridge High School', 'Girls’ Soccer', 'PRAIRIE RIDGE', 'PR', 'Maroon', 'White'],
  ['Cedar Valley Academy', 'Baseball', 'CEDAR VALLEY', 'CV', 'Green', 'Gold'],
  ['Summit Grove High School', 'Track & Field', 'SUMMIT GROVE', 'SG', 'Royal', 'White'],
  ['Westbridge Preparatory School', 'Girls’ Lacrosse', 'WESTBRIDGE', 'WP', 'Purple', 'Silver'],
  ['Riverbend Central School', 'Boys’ Volleyball', 'RIVERBEND', 'RC', 'Red', 'White'],
  ['Harbor Point Academy', 'Softball', 'HARBOR POINT', 'HP', 'Navy', 'Gold'],
  ['Oakmont Community School', 'Wrestling', 'OAKMONT', 'OC', 'Black', 'Red'],
  ['Pinecrest Technical High School', 'Cross Country', 'PINECREST', 'PT', 'Green', 'White'],
] as const;

const FIRST_NAMES = [
  'Maya', 'Jordan', 'Priya', 'Elena', 'Amara', 'Sofia',
  'Taylor', 'Morgan', 'Avery', 'Riley', 'Cameron', 'Drew',
];

const LAST_NAMES = [
  'Chen', 'Lee', 'Shah', 'Torres', 'Okafor', 'Martinez',
  'Brooks', 'Reed', 'Morgan', 'Foster', 'Bennett', 'Hayes',
];

const SIZES: Size[] = ['S', 'M', 'M', 'L', 'S', 'M', 'L', 'M', 'XL', 'S', 'M', 'L'];

const COLOR_HEX: Record<string, string> = {
  Black: '#151515',
  Gold: '#d4a72c',
  Green: '#245c3a',
  Maroon: '#6f1d2c',
  Navy: '#142b50',
  Purple: '#5a347d',
  Red: '#b6242b',
  Royal: '#184fa3',
  Silver: '#c5c8ce',
  White: '#f5f3ec',
};

function parseCsv(input: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];

    if (quoted && character === '"' && next === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, '').trim()) ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])));
}

function deterministicReference(value: string, prefix: string) {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 10).toUpperCase();
  return `${prefix}-${digest}`;
}

function buildRoster(orderIndex: number): RosterEntry[] {
  return FIRST_NAMES.map((firstName, playerIndex) => ({
    id: `player-${orderIndex + 1}-${playerIndex + 1}`,
    number: String([2, 4, 5, 7, 8, 10, 11, 12, 14, 15, 18, 21][playerIndex]),
    name: `${firstName} ${LAST_NAMES[(playerIndex + orderIndex) % LAST_NAMES.length]}`,
    size: SIZES[(playerIndex + orderIndex) % SIZES.length],
    quantity: 1,
  }));
}

function asNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildDemoOrder(row: CsvRow, index: number) {
  const schoolIndex = Math.floor(index / 2) % SCHOOL_TEMPLATES.length;
  const [school, baseTeam, teamName, logoText, primary, secondary] = SCHOOL_TEMPLATES[schoolIndex];
  const isWarmup = index % 2 === 1;
  const roster = buildRoster(index);
  const proofCount = Math.max(1, asNumber(row['Proofs Ready'], 1));
  const sourceKey = [row['COMS ID'], row['Online Number'], row['Order Number']].join('|');
  const unitPrice = 48 + (index % 6) * 7.5;

  return {
    schemaVersion: 1,
    dataset: 'journeyax-coms-reorder-poc',
    demo: true,
    sanitized: true,
    id: `S${710001 + index}`,
    po: `DEMO-${String(schoolIndex + 1).padStart(2, '0')}-${isWarmup ? 'WARMUP' : 'TEAM'}-26`,
    account: `DEMO-${String(820100 + schoolIndex)}`,
    school,
    team: isWarmup ? `${baseTeam} warm-ups` : baseTeam,
    sport: baseTeam.replace(/^(Girls’|Boys’)\s+/, '').replace(/ warm-ups$/, ''),
    season: index < 10 ? 'Spring 2026' : 'Fall 2026',
    approvedAt: row['Updated Date'] || row['COMS Received Date'] || '08/13/2026',
    requestedShipDate: row['Requested Ship Date'] || null,
    unitPrice,
    orderTotal: Number((unitPrice * roster.length).toFixed(2)),
    status: 'Completed · approved for repeat',
    comsWorkflow: {
      orderType: row['Order Type'],
      orderSubType: row['Order SubType'],
      sourceStatus: row['Status'],
      artType: row['Art Type'] || 'Raster Art',
      proofsRequested: asNumber(row['Proofs Requested'], proofCount),
      proofsReady: proofCount,
      revisionCount: asNumber(row['Revision Count'], 0),
      rush: row['Rush'] === 'Yes',
      hold: false,
      paymentTerms: row['Payment Terms'] || '001',
      sourceReference: deterministicReference(sourceKey, 'SANITIZED'),
    },
    artOwner: `Artwork Team ${String.fromCharCode(65 + (index % 3))}`,
    proofCount: `${proofCount} proof${proofCount === 1 ? '' : 's'} · approved`,
    productionHistory: [
      { status: 'Artwork approved', date: row['Updated Date'] || row['COMS Received Date'] || '08/13/2026' },
      { status: 'Production completed', date: 'Prototype history' },
    ],
    design: {
      teamName,
      primaryColor: COLOR_HEX[primary],
      secondaryColor: COLOR_HEX[secondary],
      colorway: `${primary} / ${secondary}`,
      logoText,
      logoPlacement: 'Center chest',
      treatment: index % 3 === 0 ? 'Athletic outline' : 'Classic block',
      garmentStyle: isWarmup
        ? 'R20CSM · Performance warm-up top'
        : '228325 · Lightweight reversible jersey',
    },
    roster,
    createdAt: new Date('2026-08-18T12:00:00.000Z'),
    importedAt: new Date(),
  };
}

async function main() {
  config({ path: '.env.local' });
  const sourcePath = resolve(process.argv[2] ?? '');
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'journeyax_poc';
  const collectionName = process.env.MONGODB_REORDER_COLLECTION || 'coms_orders';

  if (!process.argv[2]) throw new Error('Provide the COMS CSV path as the first argument.');
  if (!uri) throw new Error('MONGODB_URI is missing from .env.local.');

  const csv = await readFile(sourcePath, 'utf8');
  const rows = parseCsv(csv);
  const eligible = rows.filter((row) => (
    row['Order SubType'] === 'FULL_ORDER' &&
    row['Cancelled'] !== 'Yes' &&
    row['Hold'] === 'No' &&
    Boolean(row['Order Number'])
  ));
  const orders = eligible.slice(0, 20).map(buildDemoOrder);

  if (orders.length < 20) throw new Error(`Only ${orders.length} eligible records were found; expected 20.`);

  console.log(`SOURCE=${basename(sourcePath)}`);
  console.log(`SOURCE_ROWS=${rows.length}`);
  console.log(`ELIGIBLE_ROWS=${eligible.length}`);
  console.log(`SANITIZED_ORDERS=${orders.length}`);
  console.log(`MODE=${apply ? 'APPLY' : 'DRY_RUN'}`);

  const snapshotPath = resolve('data/coms-reorder-poc.json');
  await writeFile(snapshotPath, `${JSON.stringify(orders, null, 2)}\n`, 'utf8');
  console.log(`SNAPSHOT=${snapshotPath}`);

  if (!apply) return;

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const collection = client.db(dbName).collection(collectionName);
    const result = await collection.bulkWrite(
      orders.map((order) => ({
        replaceOne: {
          filter: { dataset: order.dataset, id: order.id },
          replacement: order,
          upsert: true,
        },
      })),
      { ordered: true },
    );
    const storedCount = await collection.countDocuments({ dataset: 'journeyax-coms-reorder-poc' });
    console.log(`MATCHED=${result.matchedCount}`);
    console.log(`MODIFIED=${result.modifiedCount}`);
    console.log(`UPSERTED=${result.upsertedCount}`);
    console.log(`STORED_DEMO_ORDERS=${storedCount}`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown import error';
  console.error(`IMPORT_FAILED=${message}`);
  process.exitCode = 1;
});
