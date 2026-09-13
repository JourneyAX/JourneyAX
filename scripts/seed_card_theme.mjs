#!/usr/bin/env node
/**
 * Seed / update a tenant's Card CMS theme (docs/v3-card-cms-architecture.md).
 *
 * PATCHes `uiTheme.tokens` on the project's DRAFT via project-service. Does
 * NOT publish — run the backoffice "Cards & Theme" studio's Publish button
 * (or POST /:projectId/publish) once you've checked the draft preview.
 *
 * Usage:
 *   node scripts/seed_card_theme.mjs --project dragonshield --dragonshield
 *   node scripts/seed_card_theme.mjs --project caroma --tokens ./my-tokens.json
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const PROJECT_SERVICE_URL = process.env.PROJECT_SERVICE_URL || 'http://localhost:8082';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!INTERNAL_API_KEY) {
  console.error('Missing INTERNAL_API_KEY in .env — required to PATCH a project config.');
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

// Dragon Shield brand tokens — extracted from dragonshield.com (2026-09-12 probe).
// Their live theme uses #EB2127 as the primary red and hypatia-sans-pro as the
// display font; --jx-color-brand drives every primary button and quote total.
const DRAGONSHIELD_TOKENS = {
  colors: {
    brand: '#EB2127',
    brandText: '#FFFFFF',
    accent: '#A31E22',
    text: '#1A1A1A',
    textMuted: '#5F5B5B',
    bg: '#F6F5F3',
    surface: '#FFFFFF',
    surfaceAlt: '#FAF8F8',
    muted: '#F0EEEE',
    border: '#E6E2E2',
    inverse: '#1A1A1A',
    inverseText: '#FFFFFF',
    success: '#2F7D4F',
    warning: '#B8860B',
    danger: '#A31E22',
  },
  font: {
    display: "'Space Grotesk', 'Hypatia Sans Pro', system-ui, sans-serif",
    body: "'Hypatia Sans Pro', -apple-system, 'Segoe UI', Roboto, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
};

const args = parseArgs(process.argv.slice(2));
const projectId = args.project;
if (!projectId) {
  console.error('Usage: node scripts/seed_card_theme.mjs --project <id> [--dragonshield | --tokens <file.json>]');
  process.exit(1);
}

let tokens;
if (args.dragonshield) {
  tokens = DRAGONSHIELD_TOKENS;
} else if (args.tokens) {
  const p = path.resolve(process.cwd(), args.tokens);
  tokens = JSON.parse(fs.readFileSync(p, 'utf8'));
} else {
  console.error('Pass --dragonshield for the built-in preset, or --tokens <file.json> with a Partial<ThemeTokens>.');
  process.exit(1);
}

const url = `${PROJECT_SERVICE_URL}/api/v1/projects/${encodeURIComponent(projectId)}`;

const res = await fetch(url, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'x-internal-key': INTERNAL_API_KEY,
  },
  body: JSON.stringify({ uiTheme: { tokens } }),
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`PATCH failed (${res.status}):`, body);
  process.exit(1);
}
console.log(`uiTheme.tokens updated on the DRAFT for '${projectId}'.`);
console.log('This is NOT published yet — publish from the backoffice "Cards & Theme" studio, or:');
console.log(`  curl -X POST ${PROJECT_SERVICE_URL}/api/v1/projects/${projectId}/publish -H "x-internal-key: $INTERNAL_API_KEY"`);
