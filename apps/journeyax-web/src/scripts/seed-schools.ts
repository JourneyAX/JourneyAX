/**
 * Seed the cross-tenant school-FACTS reference collection (journeyx.school_directory).
 *
 * Stores publicly-known collegiate athletic FACTS — team colours (hex), nickname,
 * mascot, conference, division, state — embedded for retrieval. NO logos or
 * uniform designs (trademarked; the customer supplies + confirms those).
 *
 * The agent uses this so "I'm from University of Chicago" pre-fills Maroon +
 * Phoenix + UAA, which it then CONFIRMS with the customer (never assumes).
 *
 *   npx tsx src/scripts/seed-schools.ts
 */
import path from 'path';
import { config as dotenv } from 'dotenv';
dotenv({ path: path.resolve(__dirname, '../../../../.env') });

import { readFileSync } from 'fs';
import { MongoClient } from 'mongodb';
import { embedTexts } from '../services/knowledge/embedder';

interface School {
  name: string; aliases?: string[]; nickname?: string; mascot?: string;
  colors: { name: string; hex: string }[]; conference?: string; division?: string; state?: string;
}

function factSheet(s: School): string {
  const colours = s.colors.map((c) => `${c.name} (${c.hex})`).join(', ');
  return [
    `${s.name}${s.aliases?.length ? ` (also: ${s.aliases.join(', ')})` : ''}`,
    s.nickname ? `Nickname: ${s.nickname}` : '',
    s.mascot ? `Mascot: ${s.mascot}` : '',
    `Team colours: ${colours}`,
    s.conference ? `Conference: ${s.conference}` : '',
    s.division ? `Division: ${s.division}` : '',
    s.state ? `State: ${s.state}` : '',
  ].filter(Boolean).join('. ');
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const seed = JSON.parse(readFileSync(path.resolve(__dirname, '../data/school-colors.seed.json'), 'utf8'));
  const schools: School[] = seed.schools || [];
  console.log(`seeding ${schools.length} schools…`);

  const client = new MongoClient(uri);
  await client.connect();
  const col = client.db('journeyx').collection('school_directory');
  await col.createIndex({ slug: 1 }, { unique: true }).catch(() => {});
  await col.createIndex({ aliases: 1 }).catch(() => {});

  const sheets = schools.map(factSheet);
  const embeddings = await embedTexts(sheets);
  const now = new Date();
  let n = 0;
  for (let i = 0; i < schools.length; i++) {
    const s = schools[i];
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    await col.updateOne(
      { slug },
      {
        $set: {
          slug, name: s.name, aliases: (s.aliases || []).map((a) => a.toLowerCase()),
          nickname: s.nickname, mascot: s.mascot, colors: s.colors,
          conference: s.conference, division: s.division, state: s.state,
          factSheet: sheets[i], embedding: embeddings[i], source: 'seed:curated-facts', updatedAt: now,
        },
      },
      { upsert: true },
    );
    n++;
    console.log(`  ✓ ${s.name} — ${s.colors.map((c) => c.hex).join(', ')}`);
  }
  console.log(`\ndone — ${n} schools in journeyx.school_directory (facts only; no logos/designs).`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
