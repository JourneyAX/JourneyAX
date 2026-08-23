/**
 * Generate the private link Momentec emails to a coach.
 *
 *   npx tsx src/scripts/make-coach-link.ts list
 *   npx tsx src/scripts/make-coach-link.ts <coach-id> [baseUrl]
 *
 * The link identifies the coach; it does not sign them in. Clicking it sends
 * a six-digit code to the address on file, and only that code opens the
 * session. So a link that goes astray is not, on its own, access.
 *
 * Coaches come from REORDER_AUTHORIZED_USERS_JSON — the same list the reorder
 * API scopes against, so a link can never be minted for a school the coach
 * would not be allowed to see.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { allCoaches, findCoachById, maskEmail } from '../lib/coach/directory';
import { inviteUrl, INVITE_TTL_SECONDS } from '../lib/coach/invite';

function main() {
  const [arg, baseArg] = process.argv.slice(2);

  if (!arg || arg === 'help') {
    console.log('Usage:\n  make-coach-link.ts list\n  make-coach-link.ts <coach-id> [baseUrl]');
    return;
  }

  if (arg === 'list') {
    const coaches = allCoaches();
    if (coaches.length === 0) {
      console.error(
        'No coaches configured. Set REORDER_AUTHORIZED_USERS_JSON, e.g.\n' +
        '  [{"id":"coach-1","email":"a@b.com","name":"Coach A","role":"coach","schools":["X High School"]}]',
      );
      process.exit(1);
    }
    console.log('id'.padEnd(24), 'name'.padEnd(20), 'email'.padEnd(32), 'schools');
    for (const c of coaches) {
      console.log(
        c.id.padEnd(24),
        c.name.padEnd(20),
        maskEmail(c.email).padEnd(32),
        c.schools.join(' · '),
      );
    }
    return;
  }

  const coach = findCoachById(arg);
  if (!coach) {
    console.error(`No coach with id "${arg}". Run "list" to see who is configured.`);
    process.exit(1);
  }

  const baseUrl = baseArg || process.env.COACH_LINK_BASE_URL || 'http://localhost:3100';
  const url = inviteUrl(baseUrl, coach.id);
  const days = Math.round(INVITE_TTL_SECONDS / 86400);

  console.log(`\nPrivate link for ${coach.name} (${maskEmail(coach.email)})`);
  console.log(`Scoped to: ${coach.schools.join(', ')}`);
  console.log(`Valid for ${days} days.\n`);
  console.log(url);
  console.log(
    '\nEmail this to the address on file — not to one supplied over the phone. ' +
    'The code step checks the mailbox, so sending it elsewhere defeats the point.\n',
  );
}

main();
