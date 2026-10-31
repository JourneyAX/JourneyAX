/**
 * Loads the demo people (eight members of staff in eight teams, a signed-in shopper and three trade customers) so "who sees what" can be tried with real sign-ins.
 * Nothing is written without --apply, and --apply needs BOTH databases named: the logins go in the sign-in service's database
 * (--users-db) and the teams and memberships in the project service's (--project-db). They are different databases on the PlaceMakers
 * setup (`journeyx` and `journeyax`), so neither is assumed. A rehearsal may name the same scratch database twice.
 *
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/seed-demo-staff.ts [--tenant placemakers] [--users-db <database> --project-db <database>] [--apply]
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/seed-demo-staff.ts --remove --users-db <database> --project-db <database> [--tenant placemakers] [--apply]
 *
 * Without --apply it prints what would be written (no connection is made; passwords are not printed).
 */
import { connectToDatabase } from '@journeyax/database';
import * as bcrypt from 'bcrypt';
import { applyDemoStaff, planDemoStaff, removeDemoStaff } from './demo-staff';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const TENANT = (option('tenant') || 'placemakers').toLowerCase();
const USERS_DB = option('users-db');
const PROJECT_DB = option('project-db');
const APPLY = flag('apply');
const REMOVE = flag('remove');
if (argv.includes('--db')) throw new Error('--db is gone: name --users-db (the sign-in service\'s database) and --project-db (the project service\'s), because they are not the same database.');
if ((APPLY || REMOVE) && (!USERS_DB || !PROJECT_DB)) throw new Error('--apply and --remove need --users-db <database> and --project-db <database>: name both databases to change (scratch ones to rehearse, the live ones to load for real).');

async function main() {
  const plan = planDemoStaff(TENANT);
  console.log(`Demo staff for "${plan.tenantId}": ${plan.teams.length} team(s), ${plan.members.length} member(s), ${plan.users.length} login(s)`);
  for (const user of plan.users) console.log(`  login ${user.email}  role ${user.role}  teams ${plan.members.find((m) => m.email === user.email)?.teams.join(', ')}`);
  if (!APPLY) { console.log(REMOVE ? 'Dry run: nothing removed. Add --apply with --users-db and --project-db to remove.' : 'Dry run: nothing written. Add --apply with --users-db and --project-db to load.'); return; }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set.');
  const { db: users } = await connectToDatabase(uri, USERS_DB!);
  const { db: project } = await connectToDatabase(uri, PROJECT_DB!);
  const dbs = { users: users as any, project: project as any };
  if (REMOVE) { await removeDemoStaff(dbs, plan); console.log(`Removed the demo logins from "${USERS_DB}" and the memberships from "${PROJECT_DB}".`); return; }
  const result = await applyDemoStaff(dbs, plan, (password) => bcrypt.hash(password, 12));
  console.log(`Loaded ${result.users} login(s) into "${USERS_DB}" and ${result.teams} team(s) and ${result.members} member(s) into "${PROJECT_DB}". Passwords are in scripts/placemakers/demo-staff.ts.`);
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
