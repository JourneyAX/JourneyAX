/**
 * Applies the seed stages (scripts/seed-stages) to the committed seed files, so a sample connector can grow new fields without a full
 * rebuild (the full build needs the PlaceMakers data folder, which is outside the repository). Reads and rewrites only the seed.json and
 * README.md of the connectors a stage names; the README is written through seed-writing.ts, as the full build writes it.
 *
 *   npx tsx packages/connectors-sample/scripts/extend-seeds.ts --check    prints the difference and writes nothing (the default)
 *   npx tsx packages/connectors-sample/scripts/extend-seeds.ts --write    writes it
 *
 * A stage only adds, so running it again gives no difference. --check exits with 1 when there is one.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ConnectorFile, SeedFile } from '../src/types';
import { readme, seedText } from './seed-writing';
import { applySeedStages, stageConnectorIds } from './seed-stages';

const CONNECTORS = path.resolve(__dirname, '..', 'connectors');
const SHOWN_LINES = 4;

export interface FileChange { file: string; before: string; after: string }

const readText = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** What the stages would change in the connectors they name. Reads only. */
export function planExtension(dir: string = CONNECTORS): FileChange[] {
  const seeds = new Map<string, SeedFile>(stageConnectorIds().map((id) => [id, JSON.parse(readFileSync(path.join(dir, id, 'seed.json'), 'utf8'))]));
  applySeedStages(seeds);
  const changes: FileChange[] = [];
  for (const [id, seed] of seeds) {
    const definition: ConnectorFile = JSON.parse(readFileSync(path.join(dir, id, 'connector.json'), 'utf8'));
    for (const [name, after] of [['seed.json', seedText(seed)], ['README.md', readme(definition, seed)]]) {
      const file = path.join(dir, id, name);
      const before = readText(file);
      if (before !== after) changes.push({ file, before, after });
    }
  }
  return changes;
}

export function writeExtension(changes: FileChange[]): void {
  for (const change of changes) writeFileSync(change.file, change.after);
}

/** The lines that are in one text and not the other, counted as a set of lines (the stages add fields to rows and lines to the README). */
export function describeChange(change: FileChange): string {
  const count = (lines: string[]) => lines.reduce((counts, line) => counts.set(line, (counts.get(line) ?? 0) + 1), new Map<string, number>());
  const before = change.before.split('\n');
  const after = change.after.split('\n');
  const left = count(before);
  const right = count(after);
  const removed = before.filter((line) => {
    const wanted = right.get(line) ?? 0;
    if (wanted === 0) return true;
    right.set(line, wanted - 1);
    return false;
  });
  const added = after.filter((line) => {
    const wanted = left.get(line) ?? 0;
    if (wanted === 0) return true;
    left.set(line, wanted - 1);
    return false;
  });
  const show = (sign: string, lines: string[]) => lines.slice(0, SHOWN_LINES).map((line) => `    ${sign} ${line.trim().slice(0, 140)}`);
  return [`${path.relative(process.cwd(), change.file)}: ${added.length} lines added, ${removed.length} removed`, ...show('-', removed), ...show('+', added)].join('\n');
}

/** The command line. Returns the exit code: 0 for nothing to do or written, 1 for a difference found by --check, 2 for a wrong call. */
export function run(argv: string[], dir: string = CONNECTORS, log: (line: string) => void = console.log): number {
  const write = argv.includes('--write');
  if (write && argv.includes('--check')) { log('Give --check or --write, not both.'); return 2; }
  const changes = planExtension(dir);
  if (changes.length === 0) { log('No difference: the seeds already hold what every stage adds.'); return 0; }
  for (const change of changes) log(describeChange(change));
  if (!write) { log(`${changes.length} file(s) would change. Run with --write to write them.`); return 1; }
  writeExtension(changes);
  log(`Wrote ${changes.length} file(s).`);
  return 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));
