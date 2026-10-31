import net from 'node:net';

/**
 * The no-world guard. Every new spec imports this first. It removes the settings that could point a spec at a database, a vendor or a key,
 * makes `fetch` throw and makes a socket refuse to connect, so a spec that forgot a fake fails loudly instead of reaching something real.
 * A spec that needs a variable sets it itself, after the import.
 */
const WORLD_NAME = /(^|_)(URI|URL|KEY|SECRET|TOKEN|PASSWORD|CLIENT_ID)$/i;
const WORLD_PREFIX = /^(MONGODB|TEST_MONGODB|CONNECTOR_|SALESFORCE_|COMMERCETOOLS_|ZENDESK_)/i;

export function isWorldVariable(name: string): boolean {
  return WORLD_NAME.test(name) || WORLD_PREFIX.test(name);
}

/** Applies the guard to this process. Returns the names it removed from `env`, never the values. */
export function applyNoWorld(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter(isWorldVariable);
  for (const name of removed) delete env[name];
  globalThis.fetch = () => {
    throw new Error('no-world guard: a spec called fetch. Pass a fake fetch instead.');
  };
  net.Socket.prototype.connect = () => {
    throw new Error('no-world guard: a spec opened a socket. Run the server in the same process instead.');
  };
  return removed;
}

applyNoWorld();

/** What a spec must start with. */
const GUARD_IMPORT = /^import\s+['"]\.\/setup\/no-world['"]\s*;?/;

/** The source after any leading blank lines and comments. */
function afterLeadingComments(source: string): string {
  let rest = source.replace(/^﻿/, '');
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('//')) rest = rest.replace(/^\/\/[^\n]*/, '');
    else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      if (end < 0) return '';
      rest = rest.slice(end + 2);
    } else return rest;
  }
}

/** True when the first statement of a spec is the guard import: blank lines and comments may come before it, nothing else. */
export function startsWithGuardImport(source: string): boolean {
  return GUARD_IMPORT.test(afterLeadingComments(source));
}
