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
 * To put the library where the Customize page reads it (the project database, collection persona_libraries), add --load-into <database>:
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/import-personas.ts --load-into journeyax [--tenant placemakers] [--apply]
 * Without --apply it only says what it would load (no connection is made). A newer library replaces the old one; the tools people have set for
 * each scenario on the Customize page are kept for every use case the new library still has. Run it twice and nothing changes but the revision.
 *
 * The access model sheet is the owner's workbook sheet "ACCESS MODEL" saved as CSV (the workbook is not read directly, so no spreadsheet
 * library is needed): in Excel, open the sheet and Save As CSV, or run the one-liner in README.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO_STAFF } from './demo-staff';
import { attachScenarioHelp, buildLibrary, casesMarkdown, checkLibrary, coverageCsv, stableJson, type Mapping, type SheetNames, type Sheets, type TestCase } from './personas';

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

async function main() {
  const sheets = Object.fromEntries((Object.keys(NAMES) as Array<keyof Sheets>).map((key) => {
    const file = path.join(sourceDir, NAMES[key]);
    if (!existsSync(file)) throw new Error(`missing ${NAMES[key]} in ${sourceDir}`);
    return [key, readFileSync(file, 'utf8')];
  })) as unknown as Sheets;
  const mapping = JSON.parse(readFileSync(mappingFile, 'utf8')) as Mapping;
  const built = buildLibrary(sheets, NAMES, mapping);
  const problems = checkLibrary(built, mapping);
  if (problems.length > 0) { console.error(`The sheets and the mapping disagree:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`); process.exit(1); }

  const cases = existsSync(casesFile) ? (JSON.parse(readFileSync(casesFile, 'utf8')).cases as TestCase[]) : [];
  // The library the project database holds also carries who to sign in as for each persona and the test set, for the Customize page.
  const library = attachScenarioHelp(built, DEMO_STAFF.map((person) => ({ email: person.email, persona: person.persona, teams: person.teams })), cases);
  const text = stableJson(library);
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
  const loadInto = option('load-into');
  const tenant = (option('tenant') || library.tenantId).toLowerCase();
  if (flag('apply') && !loadInto) throw new Error('--apply needs --load-into <database>: name the project database to change (a scratch one to rehearse, the live one to load for real).');
  if (loadInto && tenant !== library.tenantId) throw new Error(`The library is for "${library.tenantId}", not for "${tenant}".`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  const before = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  writeFileSync(outFile, text);
  console.log(`${before === text ? 'Unchanged' : 'Wrote'} ${path.relative(root, outFile)}.`);
  if (casesMd) { writeFileSync(casesMdFile, casesMd); console.log(`Wrote ${path.relative(root, casesMdFile)} (${cases.length} cases).`); }
  if (loadInto) {
    if (!flag('apply')) console.log(`Dry run: would load the library (${counts.personas} personas, ${counts.useCases} use cases) into "${loadInto}".persona_libraries for project "${tenant}". Nothing was written. Add --apply to load.`);
    else {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('MONGODB_URI is not set.');
      const { connectToDatabase } = await import('@journeyax/database');
      const { PersonaLibraryStore, PERSONA_LIBRARY_COLLECTION } = await import('../../apps/project-service/src/persona-library');
      const { db } = await connectToDatabase(uri, loadInto);
      const record = await new PersonaLibraryStore(db.collection(PERSONA_LIBRARY_COLLECTION) as any).put(tenant, library, 'process:import-personas');
      console.log(`Loaded the library into "${loadInto}".${PERSONA_LIBRARY_COLLECTION} for project "${tenant}" as revision ${record.revision} (${Object.keys(record.scenarioTools).length} scenario tool mapping(s) kept).`);
    }
  }
  if (coverageFile) { writeFileSync(coverageFile, coverageCsv(library)); console.log(`Wrote ${coverageFile}.`); }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
