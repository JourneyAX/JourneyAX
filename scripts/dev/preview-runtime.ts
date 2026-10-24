/**
 * The journey runtime with a DRAFT pack laid over the live one, for trying a change before it is published.
 *
 *   PREVIEW_TENANT=placemakers PREVIEW_DRAFT=docs/agent-instructions/placemakers-draft.json JOURNEY_RUNTIME_PORT=3112 \
 *     npx tsx --env-file=.env scripts/dev/preview-runtime.ts
 *
 * Every pack this process loads for PREVIEW_TENANT is the live pack with the draft laid over it in memory (scripts/dev/pack-overlay.ts).
 * Nothing is written to the database and the live runtime is not touched; run it on its own port and point a preview storefront at it
 * (scripts/dev/preview-stack.sh does all of that).
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PackRepository } from '@journeyax/business-pack';
import { overlayDraft } from './pack-overlay';

const tenant = String(process.env.PREVIEW_TENANT || '').toLowerCase();
const draftPath = process.env.PREVIEW_DRAFT;
if (!tenant || !draftPath) throw new Error('Set PREVIEW_TENANT and PREVIEW_DRAFT (path to the draft pack JSON).');
const draft = JSON.parse(readFileSync(path.resolve(draftPath), 'utf8'));

const VERIFIED_RELEASE_METADATA = Symbol.for('@journeyax/business-pack/verified-release-metadata');
let overlayLogged = 0;
const original = PackRepository.prototype.loadActivePack;
PackRepository.prototype.loadActivePack = async function patched(this: PackRepository, ...args: Parameters<typeof original>) {
  const live: any = await original.apply(this, args);
  if (!live || String(args[0]).toLowerCase() !== tenant) return live;
  const overlaid: any = overlayDraft(live, draft);
  if (overlayLogged++ < 3) console.log(`[preview-runtime] draft laid over '${tenant}' (${String(args[1])}): advisor tools ${(overlaid.agents || []).find((a: any) => a.isDefault)?.allowedTools?.length ?? '?'}, skills ${(overlaid.extensions?.skills || []).length}`);
  // The release-activation gate compares the pack with the checksum approved for the live release. This preview deliberately runs a
  // different pack, so it carries the live release's verification stamp. That holds only inside this preview process; the live
  // runtime still refuses any pack that does not match its approved checksum.
  const stamp = live[VERIFIED_RELEASE_METADATA];
  if (stamp) Object.defineProperty(overlaid, VERIFIED_RELEASE_METADATA, { value: stamp, enumerable: false, configurable: false, writable: false });
  return overlaid;
};
console.log(`[preview-runtime] tenant '${tenant}' runs the draft ${draftPath} over its live pack (in memory only).`);

// Started after the patch so every pack load goes through it.
import('../../apps/journey-runtime-service/src/main');
