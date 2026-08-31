#!/usr/bin/env node
/**
 * Tiny standalone image generator (Gemini 2.5 Flash Image / "nano-banana").
 * Used to produce SEPARATE design components (pattern-only, logo-only) so the
 * layered artwork document has genuinely independent, editable layers.
 *   node scripts/cdl/gen-image.mjs "<prompt>" /tmp/out.png
 * Reads GEMINI_API_KEY from the repo .env (or the environment).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const prompt = process.argv[2];
const out = process.argv[3] || '/tmp/gen.png';
if (!prompt) { console.error('usage: gen-image.mjs "<prompt>" <out.png>'); process.exit(1); }

// pull GEMINI_API_KEY from env or repo .env
let key = process.env.GEMINI_API_KEY || '';
if (!key) {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('GEMINI_API_KEY='));
    if (m) key = m.slice('GEMINI_API_KEY='.length).trim();
  }
}
if (!key || key.length < 10) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`;
const r = await fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
});
if (!r.ok) { console.error('gemini', r.status, (await r.text()).slice(0, 300)); process.exit(1); }
const j = await r.json();
const part = (j?.candidates?.[0]?.content?.parts || []).find((p) => p.inline_data || p.inlineData);
const inl = part?.inline_data || part?.inlineData;
if (!inl?.data) { console.error('no image in response'); process.exit(1); }
writeFileSync(out, Buffer.from(inl.data, 'base64'));
console.log(`wrote ${out}`);
