import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Development seed data lives in JSON files, never in service code. Seeding is opt-in:
 *   PROJECT_SEED_DIR=<dir>      read projects.json / rules.json from that directory
 *   PROJECT_SEED_ENABLED=true   use the bundled development seeds in ./seed
 * With neither set the service starts with no seed data and the database is the only source of truth.
 */
function readArray(file: string, idKey: string): any[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Seed file ${file} must contain a JSON array`);
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || typeof entry[idKey] !== 'string' || !entry[idKey]) {
      throw new Error(`Seed file ${file}: every entry needs a string '${idKey}'`);
    }
  }
  return parsed;
}

export function resolveSeedDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.PROJECT_SEED_DIR) return path.resolve(env.PROJECT_SEED_DIR);
  if (env.PROJECT_SEED_ENABLED === 'true') {
    // Source layout (src/ → ../seed), compiled layout (cwd is the app directory), in that order.
    return [path.resolve(__dirname, '..', 'seed'), path.resolve(process.cwd(), 'seed')].find((dir) => existsSync(dir));
  }
  return undefined;
}

export function loadProjectSeeds(env: NodeJS.ProcessEnv = process.env): { projects: any[]; rules: any[] } {
  const dir = resolveSeedDirectory(env);
  if (!dir) return { projects: [], rules: [] };
  return {
    projects: readArray(path.join(dir, 'projects.json'), 'projectId'),
    rules: readArray(path.join(dir, 'rules.json'), 'ruleId'),
  };
}
