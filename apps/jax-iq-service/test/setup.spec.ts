import './setup/no-world';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { applyNoWorld, startsWithGuardImport } from './setup/no-world';

const suite = createSuite('jax-iq-service: the no-world guard and the scan that makes every spec load it first');

async function main() {
  await suite.test('every spec in test/ loads the no-world guard before anything else', () => {
    const specs = readdirSync(__dirname).filter((name) => name.endsWith('.spec.ts')).sort();
    assert.ok(specs.includes('setup.spec.ts') && specs.includes('smoke.spec.ts'), 'the scan found the specs of this service');
    const offenders = specs.filter((name) => !startsWithGuardImport(readFileSync(path.join(__dirname, name), 'utf8')));
    assert.deepEqual(offenders, [], `these specs do not start with "import './setup/no-world';": ${offenders.join(', ')}`);
  });

  await suite.test('the scan refuses a spec that has the guard second or only in a comment', () => {
    assert.equal(startsWithGuardImport(`import './setup/no-world';\nimport assert from 'node:assert/strict';\n`), true);
    assert.equal(startsWithGuardImport(`import assert from 'node:assert/strict';\nimport './setup/no-world';\n`), false);
    assert.equal(startsWithGuardImport(`// import './setup/no-world';\n`), false);
  });

  await suite.test('the guard is on for this service\'s specs: fetch throws, a socket cannot connect, key and database variables are removed', () => {
    assert.throws(() => fetch('http://127.0.0.1:1/'), /no-world guard/);
    const socket = new net.Socket();
    socket.on('error', () => undefined);
    assert.throws(() => socket.connect(1, '127.0.0.1'), /no-world guard/);
    socket.destroy();
    const env: NodeJS.ProcessEnv = { MONGODB_URI: 'test-only', JAX_IQ_API_KEY: 'test-only', JAX_IQ_ENABLED: '1' };
    assert.deepEqual(applyNoWorld(env).sort(), ['JAX_IQ_API_KEY', 'MONGODB_URI']);
    assert.deepEqual(env, { JAX_IQ_ENABLED: '1' });
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
