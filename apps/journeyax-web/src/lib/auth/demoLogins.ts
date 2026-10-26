/**
 * Demo persona sign-ins: on a demo, the sign-in screen offers one button per persona (a customer service adviser, a branch counter, a
 * trade customer...), so a person can try the assistant as each of them without typing a password.
 *
 * The passwords never reach the browser. They sit in a private JSON file that only the web server reads, named by DEMO_LOGINS_FILE; with
 * no such file the screen shows no persona buttons and the sign-in route refuses (so a real shop never offers them). The browser is told
 * who each button is (name, a line about them, their group) and sends back only the button's id.
 */
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

export interface DemoLogin {
  /** The button's id: the part of the e-mail before the @. */
  id: string;
  email: string;
  password: string;
  label: string;
  description: string;
  /** "Staff" or "Customers", for grouping the buttons. */
  group: 'Staff' | 'Customers';
  /** The staff team, if any. */
  team?: string;
}
export type PublicDemoLogin = Omit<DemoLogin, 'password' | 'email'>;

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** The file's list, keeping only well-formed entries (a bad one is dropped, never half-shown); at most 40. */
export function parseDemoLogins(json: unknown): DemoLogin[] {
  const list = Array.isArray(json) ? json : Array.isArray((json as { logins?: unknown })?.logins) ? (json as { logins: unknown[] }).logins : [];
  const seen = new Set<string>();
  const out: DemoLogin[] = [];
  for (const raw of list.slice(0, 40)) {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const email = text(entry.email, 120).toLowerCase();
    const password = typeof entry.password === 'string' ? entry.password : '';
    const label = text(entry.label, 80);
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !password || !label) continue;
    const id = email.split('@')[0].replace(/[^a-z0-9._-]/g, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, email, password, label, description: text(entry.description, 200), group: entry.group === 'Customers' ? 'Customers' : 'Staff', ...(text(entry.team, 60) ? { team: text(entry.team, 60) } : {}) });
  }
  return out;
}

/** What the browser is told: everything except the password and the e-mail. */
export function publicView(logins: DemoLogin[]): PublicDemoLogin[] {
  return logins.map(({ password: _p, email: _e, ...rest }) => rest);
}

export const findDemoLogin = (logins: DemoLogin[], id: unknown): DemoLogin | undefined => (typeof id === 'string' ? logins.find((login) => login.id === id) : undefined);

let cache: { path: string; mtime: number; logins: DemoLogin[] } | undefined;

/** The logins of the file DEMO_LOGINS_FILE names (re-read when it changes); none when it is not set or cannot be read. */
export function loadDemoLogins(env: NodeJS.ProcessEnv = process.env): DemoLogin[] {
  const file = env.DEMO_LOGINS_FILE;
  if (!file || !existsSync(file)) return [];
  try {
    const mtime = statSync(file).mtimeMs;
    if (cache && cache.path === file && cache.mtime === mtime) return cache.logins;
    const logins = parseDemoLogins(JSON.parse(readFileSync(file, 'utf8')));
    cache = { path: file, mtime, logins };
    return logins;
  } catch { return []; }
}

/**
 * The environment the sign-in routes read the demo logins with: DEMO_LOGINS_FILE when it is set, otherwise a private `.env.demo-logins.json` in the
 * repository root if one exists there (the web app runs from apps/journeyax-web, two folders down). So a running web app shows the demo box as soon as
 * the file is made, with no restart and no change to how it was started; with no file there is no box.
 */
export function demoLoginsEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): NodeJS.ProcessEnv {
  if (env.DEMO_LOGINS_FILE) return env;
  const fallback = path.resolve(cwd, '../../.env.demo-logins.json');
  return existsSync(fallback) ? { ...env, DEMO_LOGINS_FILE: fallback } : env;
}
