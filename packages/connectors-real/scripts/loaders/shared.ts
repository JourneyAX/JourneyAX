/**
 * Shared by the loaders: the loaders put PlaceMakers-style demo data into a vendor trial, so the real connectors have something real to
 * read. They are separate from the connectors on purpose: they need powers to create things, and the chat's connection never gets those.
 * Every loader is a dry run unless --apply is given, uses its own credentials (named LOADER in the settings), and prints no secret.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ToolError, type Deps, type Rec } from '../../src/types';
import { errorFor, redact, send, vendorMessage, type Answer } from '../../src/http';

/** The sample connectors' records (built from the PlaceMakers product and content masters, with invented orders, accounts and cases marked sample). */
export function sampleCollection(connector: string, collection: string): Rec[] {
  const file = path.resolve(__dirname, '../../../connectors-sample/connectors', connector, 'seed.json');
  const seed = JSON.parse(readFileSync(file, 'utf8'));
  const rows = seed.collections?.[collection];
  if (!Array.isArray(rows)) throw new Error(`The sample data for ${connector} has no "${collection}".`);
  return rows;
}

export interface LoaderFlags { apply: boolean; limit: Record<string, number>; rest: string[] }

/** `--apply`, and `--name 12` options; anything else is returned as it is. */
export function readFlags(argv: string[], numeric: string[]): LoaderFlags {
  const limit: Record<string, number> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (argv[i].startsWith('--') && numeric.includes(name)) { limit[name] = Math.max(0, Math.trunc(Number(argv[++i]))); continue; }
    if (argv[i] !== '--apply') rest.push(argv[i]);
  }
  return { apply: argv.includes('--apply'), limit, rest };
}

/** One call to a vendor that either works or throws a message fit to print. `secrets` are removed from anything said. */
export async function must(deps: Deps, system: string, secrets: string[], method: string, url: string, options: Parameters<typeof send>[4], accept: number[] = []): Promise<Answer> {
  const answer = await send(deps, system, method, url, options);
  if (answer.ok || accept.includes(answer.status)) return answer;
  throw errorFor(system, answer.status, redact(vendorMessage(answer.json, answer.text), secrets));
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function required(env: Record<string, string | undefined>, names: string[]): void {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) throw new ToolError('not_connected', `Still needed before this can run: ${missing.join(', ')}.`);
}

export const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
export const cents = (amount: number): number => Math.round(Number(amount) * 100);
