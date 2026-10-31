/**
 * What the storefront config route answers when the published configuration cannot be loaded, and the rule that keeps `next build` working:
 * a Next route file may export only HTTP handlers and route settings.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/config/__tests__/configFailure.test.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { handleConfigFailure } from '../configFailure';

let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const APP = path.resolve(__dirname, '../../../app');
const ALLOWED = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|dynamic|dynamicParams|revalidate|fetchCache|runtime|preferredRegion|maxDuration|generateStaticParams)$/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : routeFiles(full);
    return /^route\.(ts|tsx|js)$/.test(entry) ? [full] : [];
  });
}

async function main() {
  console.log('config failure');

  await check('a tenant that has been moved to the canonical configuration fails closed with 503 and no fallback values', async () => {
    process.env.TENANT_CUTOVER_PLACEMAKERS = 'migrated';
    try {
      const response = await handleConfigFailure('placemakers');
      assert.equal(response.status, 503);
      const body: any = await response.json();
      assert.equal(body.error, 'CanonicalConfigurationUnavailable');
      assert.match(body.message, /Legacy fallback is prohibited after canonical activation/);
      assert.equal(body.cutoverState, 'migrated');
      assert.equal(body.companyName, undefined);
      assert.equal(body.theme, undefined);
    } finally { delete process.env.TENANT_CUTOVER_PLACEMAKERS; }
  });

  await check('a tenant explicitly not moved gets the legacy fallback as JSON, and an unknown tenant gets a plain one under its own id', async () => {
    process.env.TENANT_CUTOVER_PLACEMAKERS = 'unmigrated';
    try {
      const response = await handleConfigFailure('placemakers');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/json');
      assert.equal(((await response.json()) as any).companyName, 'PlaceMakers (Fletcher Building)');
    } finally { delete process.env.TENANT_CUTOVER_PLACEMAKERS; }
    assert.equal(((await (await handleConfigFailure('someone-else')).json()) as any).projectId, 'someone-else');
  });

  await check('no route file exports anything but HTTP handlers and route settings (a production build refuses it)', () => {
    const files = routeFiles(APP);
    assert.ok(files.length > 20, `the scan found the route files (${files.length})`);
    const stray: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        if (!ALLOWED.test(match[1])) stray.push(`${path.relative(APP, file)}: ${match[1]}`);
      }
      for (const match of readFileSync(file, 'utf8').matchAll(/^export\s*\{([^}]*)\}/gm)) {
        for (const name of match[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop()!).filter(Boolean)) if (!ALLOWED.test(name)) stray.push(`${path.relative(APP, file)}: ${name}`);
      }
    }
    assert.deepEqual(stray, [], 'move the helper into src/lib and import it');
  });

  console.log(`${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
