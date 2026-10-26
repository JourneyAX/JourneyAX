/**
 * The demo persona sign-in file: one entry per demo login, with the password, for the web server to read (DEMO_LOGINS_FILE). The sign-in
 * screen then offers a button per persona. The file holds passwords, so it is written outside git (`.env*` is ignored) and only the web
 * server reads it; the browser is only ever told the name and description of each button.
 *
 *   npx tsx scripts/placemakers/demo-logins.ts [--out .env.demo-logins.json]
 *   then start the web app with DEMO_LOGINS_FILE=<that path>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO_STAFF, DEMO_TEAMS, type DemoStaffPerson } from './demo-staff';

export interface DemoLoginEntry { email: string; password: string; label: string; description: string; group: 'Staff' | 'Customers'; team?: string }

const firstSentence = (text: string): string => { const flat = text.replace(/\s+/g, ' ').trim(); const end = flat.search(/[.!?](\s|$)/); return end >= 0 ? flat.slice(0, end + 1) : flat; };

/** One entry per demo person: named after the persona they stand for (or the team), described by what their team does (or the persona is). */
export function demoLoginEntries(people: DemoStaffPerson[], library: { personas: Array<{ id: string; name: string; description: string }> }): DemoLoginEntry[] {
  const persona = new Map(library.personas.map((p) => [p.id, p]));
  const team = new Map(DEMO_TEAMS.map((t) => [t.name, t.description]));
  return people.map((person) => {
    const stands = person.persona ? persona.get(person.persona) : undefined;
    const staff = person.teams.length > 0;
    const teamName = person.teams[0];
    return {
      email: person.email,
      password: person.password,
      label: staff ? `${teamName}${stands ? `: ${stands.name}` : ''}` : stands?.name ?? person.fullName,
      description: staff ? (team.get(teamName) ?? firstSentence(stands?.description ?? '')) : firstSentence(stands?.description ?? ''),
      group: staff ? 'Staff' : 'Customers',
      ...(staff ? { team: teamName } : {}),
    };
  });
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../..');
  const i = process.argv.indexOf('--out');
  const out = path.resolve(root, i >= 0 ? process.argv[i + 1] : '.env.demo-logins.json');
  const libraryFile = path.join(root, 'docs/agent-instructions/personas/placemakers-personas.json');
  if (!existsSync(libraryFile)) throw new Error('The persona library is missing.');
  const entries = demoLoginEntries(DEMO_STAFF, JSON.parse(readFileSync(libraryFile, 'utf8')));
  writeFileSync(out, `${JSON.stringify({ logins: entries }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote ${entries.length} demo logins to ${out} (private: it holds passwords; start the web app with DEMO_LOGINS_FILE=${out}).`);
}
