/**
 * Links the three demo trade logins to companies of the sample accounts system, so a signed-in customer can be shown their own company's
 * deliveries, balance and prices. This is what the team does by hand in the back office (Customize, Personas, Customers); the script does it for the demo.
 *
 *   ACC-0028  Harlow & Talbot Landscapes Ltd   trade.admin  (account administrator), trade.buyer (buyer)
 *   ACC-0016  Marlow & Tasman Framing Ltd      trade.foreman (job viewer)
 *
 * Nothing is written without --apply, and --apply needs the project service's database named (--project-db), because it is not assumed.
 *
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/link-demo-companies.ts [--tenant placemakers] [--project-db <database> --apply]
 *   npx tsx --env-file=.env --tsconfig tests/public-path/tsconfig.json scripts/placemakers/link-demo-companies.ts --remove --project-db <database> [--tenant placemakers] [--apply]
 *
 * Undo: --remove --apply with the same database.
 */
import { connectToDatabase } from '@journeyax/database';
import { COMPANY_LINK_COLLECTION, CompanyLinkStore } from '../../apps/project-service/src/company-links';

export const DEMO_COMPANY_LINKS = [
  { email: 'trade.admin@placemakers.demo', companyId: 'ACC-0028', companyName: 'Harlow & Talbot Landscapes Ltd', role: 'account_admin' },
  { email: 'trade.buyer@placemakers.demo', companyId: 'ACC-0028', companyName: 'Harlow & Talbot Landscapes Ltd', role: 'buyer' },
  { email: 'trade.foreman@placemakers.demo', companyId: 'ACC-0016', companyName: 'Marlow & Tasman Framing Ltd', role: 'job_viewer' },
] as const;

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(`--${name}`);
  const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const tenant = (option('tenant') || 'placemakers').toLowerCase();
  const projectDb = option('project-db');
  const apply = flag('apply');
  const remove = flag('remove');
  if ((apply || remove) && !projectDb) throw new Error('--apply and --remove need --project-db <database>: name the project service\'s database (the live one to load for real).');

  console.log(`${remove ? 'Unlink' : 'Link'} ${DEMO_COMPANY_LINKS.length} demo login(s) in "${tenant}":`);
  for (const link of DEMO_COMPANY_LINKS) console.log(`  ${link.email}  ->  ${link.companyName} (${link.companyId}) as ${link.role}`);
  if (!apply) { console.log('Dry run: nothing written. Add --project-db <database> --apply to do it.'); return; }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set.');
  const { db } = await connectToDatabase(uri, projectDb!);
  const store = new CompanyLinkStore((db as any).collection(COMPANY_LINK_COLLECTION), () => new Date());
  for (const link of DEMO_COMPANY_LINKS) {
    if (remove) await store.unlink(tenant, link.email, link.companyId);
    else await store.link(tenant, link, 'script:link-demo-companies');
  }
  console.log(`${remove ? 'Unlinked' : 'Linked'} ${DEMO_COMPANY_LINKS.length} login(s) in "${projectDb}".`);
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
