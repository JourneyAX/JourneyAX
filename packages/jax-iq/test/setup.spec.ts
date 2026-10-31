import './setup/no-world';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { applyNoWorld, isWorldVariable, startsWithGuardImport } from './setup/no-world';

const suite = createSuite('jax-iq: the no-world guard, and the scan that makes every spec load it first');

async function main() {
  await suite.test('every spec in test/ loads the no-world guard before anything else', () => {
    const specs = readdirSync(__dirname).filter((name) => name.endsWith('.spec.ts')).sort();
    assert.ok(specs.includes('setup.spec.ts') && specs.includes('smoke.spec.ts'), 'the scan found the specs of this package');
    const offenders = specs.filter((name) => !startsWithGuardImport(readFileSync(path.join(__dirname, name), 'utf8')));
    assert.deepEqual(offenders, [], `these specs do not start with "import './setup/no-world';": ${offenders.join(', ')}`);
  });

  await suite.test('the scan accepts the guard first, after comments, and refuses every other order', () => {
    const guard = `import './setup/no-world';`;
    assert.equal(startsWithGuardImport(`${guard}\nimport assert from 'node:assert/strict';\n`), true);
    assert.equal(startsWithGuardImport(`import "./setup/no-world"\n`), true);
    assert.equal(startsWithGuardImport(`// a note\n/** A block\n * of notes. */\n\n${guard}\n`), true);
    assert.equal(startsWithGuardImport(''), false, 'an empty file');
    assert.equal(startsWithGuardImport(`import assert from 'node:assert/strict';\n${guard}\n`), false, 'the guard second');
    assert.equal(startsWithGuardImport(`// ${guard}\nimport assert from 'node:assert/strict';\n`), false, 'the guard only in a comment');
    assert.equal(startsWithGuardImport(`/* ${guard}\nimport assert from 'node:assert/strict';\n`), false, 'a comment that never closes');
    assert.equal(startsWithGuardImport(`import './no-world';\n`), false, 'another file of the same name');
    assert.equal(startsWithGuardImport(`import './setup/no-world-other';\n`), false, 'a file that only starts with the same name');
    assert.equal(startsWithGuardImport(`const x = 1;\n${guard}\n`), false, 'code before the guard');
  });

  await suite.test('the guard removes settings that look like a key, a secret or an address, and every database and vendor setting', () => {
    const removed = [
      'MONGODB_URI', 'MONGODB_DB_NAME', 'MONGODB', 'TEST_MONGODB_URI', 'INTERNAL_API_KEY', 'JAX_IQ_API_KEY', 'JAX_IQ_MCP_KEY', 'JAX_IQ_SCOPE_SECRET',
      'SOME_SERVICE_URL', 'SOME_SERVICE_URI', 'SOME_PASSWORD', 'SOME_TOKEN', 'SOME_CLIENT_ID', 'CLIENT_ID', 'KEY', 'URL',
      'CONNECTOR_MCP_SERVERS', 'CONNECTOR_MCP_BASE_URL', 'CONNECTOR_FORWARD_CALLER', 'SALESFORCE_BRANCH_FIELD', 'SALESFORCE_CLIENT_ID', 'COMMERCETOOLS_PROJECT_KEY', 'ZENDESK_SUBDOMAIN',
      'openai_api_key',
    ];
    const kept = [
      'PATH', 'HOME', 'NODE_ENV', 'HOST', 'PORT', 'JAX_IQ_ENABLED', 'JAX_IQ_REST_ENABLED', 'JAX_IQ_SERVICE_PORT', 'JAX_IQ_TENANTS', 'JAX_IQ_SCOPE_TTL_SECONDS',
      'JOURNEYAX_TEST_LOG_DIR', 'MONKEY', 'KEYBOARD', 'URLS', 'CONNECTORS_OTHER', 'ZENDESK',
    ];
    for (const name of removed) assert.equal(isWorldVariable(name), true, `${name} should be removed`);
    for (const name of kept) assert.equal(isWorldVariable(name), false, `${name} should be kept`);
  });

  await suite.test('applying the guard to an environment removes only the matching names and reports names, not values', () => {
    const env: NodeJS.ProcessEnv = { MONGODB_URI: 'test-only-1', SOME_TOKEN: 'test-only-2', JAX_IQ_ENABLED: '1', PATH: '/test-only/bin' };
    const removed = applyNoWorld(env);
    assert.deepEqual(removed.sort(), ['MONGODB_URI', 'SOME_TOKEN']);
    assert.deepEqual(env, { JAX_IQ_ENABLED: '1', PATH: '/test-only/bin' });
    assert.ok(!removed.some((name) => name.includes('test-only')), 'only names come back');
  });

  await suite.test('a variable a spec sets after the import is left alone', () => {
    const name = 'JAX_IQ_TEST_ONLY_SET_AFTER_IMPORT_KEY';
    process.env[name] = 'test-only';
    try {
      assert.equal(process.env[name], 'test-only');
    } finally {
      delete process.env[name];
    }
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
