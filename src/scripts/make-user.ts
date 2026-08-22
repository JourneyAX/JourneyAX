/**
 * Account administration.
 *
 *   npx tsx src/scripts/make-user.ts add    <username> <csr|admin>
 *   npx tsx src/scripts/make-user.ts reset  <username>
 *   npx tsx src/scripts/make-user.ts disable <username>
 *   npx tsx src/scripts/make-user.ts enable  <username>
 *   npx tsx src/scripts/make-user.ts mfa-off <username>
 *   npx tsx src/scripts/make-user.ts list
 *
 * Where accounts live depends on configuration:
 *
 *   JOURNEYAX_USER_STORE set  → writes to that JSON file directly.
 *   otherwise                 → prints a JOURNEYAX_USERS line to paste in.
 *
 * Only the first form supports reset/disable/mfa-off: the environment
 * directory is read-only by design.
 *
 * `reset` is the password-recovery path. There is no email provider here, so
 * recovery is deliberately out-of-band: an administrator generates a
 * temporary password, hands it over through a channel they trust, and the
 * account is forced to change it at next sign-in. A self-service email reset
 * is only as strong as the mailbox behind it, and adding one would mean
 * shipping a mail dependency and a token store.
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { hashPassword } from '../lib/auth/passwords';
import { checkPassword } from '../lib/auth/password-policy';
import { createFileDirectory, upsertUser } from '../lib/auth/file-store';
import type { Role } from '../lib/auth/types';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const storePath = process.env.JOURNEYAX_USER_STORE;

function prompt(question: string, silent = false): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  return new Promise(resolve => {
    const out = rl as unknown as { output?: { write(chunk: string): void } };
    const original = out.output?.write.bind(out.output);
    let muted = false;

    if (silent && out.output && original) {
      out.output.write = (chunk: string) => { if (!muted) original(chunk); };
    }

    stdout.write(question);
    muted = silent;

    rl.question('', answer => {
      muted = false;
      if (silent) stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function readNewPassword(username: string): Promise<string> {
  const password = await prompt(`Password for ${username}: `, true);
  const policy = checkPassword(password, username);
  if (!policy.ok) {
    console.error('\nThat password is not acceptable:');
    for (const p of policy.problems) console.error(`  · ${p}`);
    process.exit(1);
  }
  const confirm = await prompt('Confirm password: ', true);
  if (password !== confirm) {
    console.error('Passwords did not match.');
    process.exit(1);
  }
  return password;
}

function requireStore(action: string): string {
  if (!storePath) {
    console.error(
      `"${action}" needs a writable store. Set JOURNEYAX_USER_STORE=./data/users.json ` +
      'and re-run. The JOURNEYAX_USERS environment directory is read-only.',
    );
    process.exit(1);
  }
  return storePath;
}

/** Readable, high-entropy temporary password. Avoids ambiguous characters. */
function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, b => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 5).join('')}-${chars.slice(5, 10).join('')}-${chars.slice(10, 15).join('')}-${chars.slice(15, 20).join('')}`;
}

async function main() {
  const [command, username, roleArg] = process.argv.slice(2);

  if (!command || command === 'help') {
    console.log(`Usage:
  add     <username> <csr|admin>   create an account
  reset   <username>               issue a temporary password
  disable <username>               block sign-in without deleting
  enable  <username>               undo disable
  mfa-off <username>               clear MFA after a lost device
  list                             show accounts (never secrets)`);
    return;
  }

  if (command === 'list') {
    const dir = createFileDirectory(requireStore('list'));
    const users = (await dir.list?.()) ?? [];
    if (users.length === 0) { console.log('No accounts.'); return; }
    console.log('username           role   mfa   disabled  must-change');
    for (const u of users) {
      console.log(
        u.username.padEnd(18),
        u.role.padEnd(6),
        (u.totpSecret ? 'on' : 'off').padEnd(5),
        (u.disabled ? 'yes' : 'no').padEnd(9),
        u.mustChangePassword ? 'yes' : 'no',
      );
    }
    return;
  }

  if (!username) {
    console.error(`"${command}" needs a username.`);
    process.exit(1);
  }

  switch (command) {
    case 'add': {
      if (roleArg !== 'csr' && roleArg !== 'admin') {
        console.error('Role must be "csr" or "admin".');
        process.exit(1);
      }
      const password = await readNewPassword(username);
      const passwordHash = await hashPassword(password);

      if (storePath) {
        await upsertUser(storePath, {
          username: username.toLowerCase(),
          role: roleArg as Role,
          passwordHash,
          passwordChangedAt: new Date().toISOString(),
        });
        console.log(`\nCreated ${username} (${roleArg}) in ${storePath}\n`);
      } else {
        console.log('\nAdd this to JOURNEYAX_USERS in .env.local (comma-separate multiple users):\n');
        console.log(`${username.toLowerCase()}:${roleArg}:${passwordHash}\n`);
        console.log('Note: the environment directory is read-only — password changes and');
        console.log('MFA need JOURNEYAX_USER_STORE instead.\n');
      }
      return;
    }

    case 'reset': {
      const dir = createFileDirectory(requireStore('reset'));
      const temp = temporaryPassword();
      const updated = await dir.update?.(username, {
        passwordHash: await hashPassword(temp),
        mustChangePassword: true,
        passwordChangedAt: new Date().toISOString(),
      });
      if (!updated) { console.error(`No such account: ${username}`); process.exit(1); }

      console.log(`\nTemporary password for ${username}:\n\n    ${temp}\n`);
      console.log('Give this to them through a channel you trust — not email, if you can');
      console.log('avoid it. They must change it at next sign-in.');
      console.log('\nTheir existing sessions are NOT revoked by this script (it does not run');
      console.log('in the server process). Restart the app, or have them sign out everywhere.\n');
      return;
    }

    case 'disable':
    case 'enable': {
      const dir = createFileDirectory(requireStore(command));
      const updated = await dir.update?.(username, { disabled: command === 'disable' });
      if (!updated) { console.error(`No such account: ${username}`); process.exit(1); }
      console.log(`${username} is now ${command === 'disable' ? 'disabled' : 'enabled'}.`);
      return;
    }

    case 'mfa-off': {
      const dir = createFileDirectory(requireStore('mfa-off'));
      const updated = await dir.update?.(username, {
        totpSecret: undefined,
        pendingTotpSecret: undefined,
        totpActivatedAt: undefined,
        totpLastStep: undefined,
        recoveryCodeHashes: [],
      });
      if (!updated) { console.error(`No such account: ${username}`); process.exit(1); }
      console.log(`MFA cleared for ${username}. They should re-enrol immediately.`);
      return;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
