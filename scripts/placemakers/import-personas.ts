/**
 * Reads the PlaceMakers persona sheets and writes the persona library the pack, the demo logins and the tests lean on.
 * Safe to run any number of times: the output depends only on the sheets and `mapping.json`, so a second run changes nothing.
 *
 *   npx tsx scripts/placemakers/import-personas.ts [--source <dir>] [--mapping <file>] [--out <file>] [--coverage-csv <file>] [--check]
 *
 * Defaults (all inside docs/agent-instructions/personas/):
 *   --source  source/       PlaceMakers_Personas_Import.csv, PlaceMakers_UseCases_Import.csv, PlaceMakers_AccessModel.csv, PlaceMakers_TicketingTools.csv
 *   --mapping mapping.json  the decisions that connect the sheets to the pack (teams, roles, which systems are ready)
 *   --out     placemakers-personas.json
 * Also written, from test-cases.json (the small test set) and the pack draft: TEST-CASES.md next to the library (--cases-md to put it elsewhere).
 * Optional: --coverage-csv writes the one-row-per-use-case table the owner reads ("can we do it today?").
 * --check writes nothing: it exits 1 and says so when the committed library is not what the sheets and mapping would give now.
 *
 * The access model sheet is the owner's workbook sheet "ACCESS MODEL" saved as CSV (the workbook is not read directly, so no spreadsheet
 * library is needed): in Excel, open the sheet and Save As CSV, or run the one-liner in README.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO_STAFF } from './demo-staff';
import { buildLibrary, casesMarkdown, checkLibrary, coverageCsv, stableJson, type Mapping, type SheetNames, type Sheets, type TestCase } from './personas';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(__dirname, '../..');
const base = path.join(root, 'docs/agent-instructions/personas');
const sourceDir = path.resolve(option('source') ?? path.join(base, 'source'));
const mappingFile = path.resolve(option('mapping') ?? path.join(base, 'mapping.json'));
const outFile = path.resolve(option('out') ?? path.join(base, 'placemakers-personas.json'));
const coverageFile = option('coverage-csv') ? path.resolve(option('coverage-csv')!) : undefined;
const casesFile = path.join(base, 'test-cases.json');
const casesMdFile = path.resolve(option('cases-md') ?? path.join(base, 'TEST-CASES.md'));
const draftFile = path.join(root, 'docs/agent-instructions/placemakers-draft.json');
const CHECK = flag('check');

const NAMES: SheetNames = {
  personas: 'PlaceMakers_Personas_Import.csv',
  useCases: 'PlaceMakers_UseCases_Import.csv',
  accessModel: 'PlaceMakers_AccessModel.csv',
  ticketing: 'PlaceMakers_TicketingTools.csv',
};

function main() {
  const sheets = Object.fromEntries((Object.keys(NAMES) as Array<keyof Sheets>).map((key) => {
    const file = path.join(sourceDir, NAMES[key]);
    if (!existsSync(file)) throw new Error(`missing ${NAMES[key]} in ${sourceDir}`);
    return [key, readFileSync(file, 'utf8')];
  })) as unknown as Sheets;
  const mapping = JSON.parse(readFileSync(mappingFile, 'utf8')) as Mapping;
  const library = buildLibrary(sheets, NAMES, mapping);
  const problems = checkLibrary(library, mapping);
  if (problems.length > 0) { console.error(`The sheets and the mapping disagree:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`); process.exit(1); }

  const text = stableJson(library);
  const cases = existsSync(casesFile) ? (JSON.parse(readFileSync(casesFile, 'utf8')).cases as TestCase[]) : [];
  const agentNames = existsSync(draftFile) ? Object.fromEntries((JSON.parse(readFileSync(draftFile, 'utf8')).agents as Array<{ agentId: string; name: string }>).map((agent) => [agent.agentId, agent.name])) : {};
  const casesMd = cases.length ? casesMarkdown(library, cases, DEMO_STAFF.map((person) => ({ key: person.email.split('@')[0], email: person.email, fullName: person.fullName })), agentNames) : '';
  const { counts } = library;
  console.log(`${counts.personas} personas (${counts.customers} customers, ${counts.staff} staff), ${counts.useCases} use cases, ${counts.accessRoles} access roles, ${counts.teams} teams.`);
  console.log(`Today: ${Object.entries(counts.readiness).map(([state, n]) => `${n} ${state}`).join(', ')}.`);

  if (CHECK) {
    const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    if (current !== text) { console.error(`${path.relative(root, outFile)} is out of date: run import-personas.ts again.`); process.exit(1); }
    if (casesMd && (existsSync(casesMdFile) ? readFileSync(casesMdFile, 'utf8') : '') !== casesMd) { console.error(`${path.relative(root, casesMdFile)} is out of date: run import-personas.ts again.`); process.exit(1); }
    console.log(`${path.relative(root, outFile)} is up to date.`);
    return;
  }
  mkdirSync(path.dirname(outFile), { recursive: true });
  const before = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  writeFileSync(outFile, text);
  console.log(`${before === text ? 'Unchanged' : 'Wrote'} ${path.relative(root, outFile)}.`);
  if (casesMd) { writeFileSync(casesMdFile, casesMd); console.log(`Wrote ${path.relative(root, casesMdFile)} (${cases.length} cases).`); }
  if (coverageFile) { writeFileSync(coverageFile, coverageCsv(library)); console.log(`Wrote ${coverageFile}.`); }
}

main();
