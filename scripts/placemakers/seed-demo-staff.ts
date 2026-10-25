/**
 * Loads the demo members of staff (a customer-service person and a sales rep) so "who sees what" can be tried with real sign-ins.
 * Nothing is written without --apply, and --apply needs --db: the database is always named, never assumed.
 *
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/seed-demo-staff.ts [--tenant placemakers] [--db <database>] [--apply]
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/seed-demo-staff.ts --remove --db <database> [--tenant placemakers] [--apply]
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
const DB_NAME = option('db');
const APPLY = flag('apply');
const REMOVE = flag('remove');
if ((APPLY || REMOVE) && !DB_NAME) throw new Error('--apply and --remove need --db <database>: name the database to change (a scratch one to rehearse, the live one to load for real).');

async function main() {
  const plan = planDemoStaff(TENANT);
  console.log(`Demo staff for "${plan.tenantId}": ${plan.teams.length} team(s), ${plan.members.length} member(s), ${plan.users.length} login(s)`);
  for (const user of plan.users) console.log(`  login ${user.email}  role ${user.role}  teams ${plan.members.find((m) => m.email === user.email)?.teams.join(', ')}`);
  if (!APPLY) { console.log(REMOVE ? 'Dry run: nothing removed. Add --apply with --db to remove.' : 'Dry run: nothing written. Add --apply with --db to load.'); return; }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set.');
  const { db } = await connectToDatabase(uri, DB_NAME!);
  if (REMOVE) { await removeDemoStaff(db as any, plan); console.log(`Removed the demo logins and memberships from "${DB_NAME}".`); return; }
  const result = await applyDemoStaff(db as any, plan, (password) => bcrypt.hash(password, 12));
  console.log(`Loaded into "${DB_NAME}": ${result.teams} team(s), ${result.members} member(s), ${result.users} login(s). Passwords are in scripts/placemakers/demo-staff.ts.`);
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
