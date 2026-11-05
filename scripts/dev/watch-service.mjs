// Use TypeScript's real compiler: Nest injection needs emitted decorator metadata.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { vendorKey } from './stack-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const entry = /^node (dist\/[\w./-]+\.js)$/.exec(pkg.scripts.start || '')?.[1];
if (!entry) throw new Error('The workspace needs a declared node dist/... start script.');
const env = { ...process.env };
if (pkg.name === '@journeyax/connectors-real' && env.JOURNEYAX_CONNECTORS_ENV_FILE) {
  Object.assign(env, Object.fromEntries(Object.entries(parse(readFileSync(env.JOURNEYAX_CONNECTORS_ENV_FILE))).filter(([key]) => vendorKey(key))));
  if (env.REAL_CONNECTORS_ENVIRONMENT !== 'dev') throw new Error('Local sources require DEV scope.');
}
let server, stopping = false, restarting = Promise.resolve();
function stopServer() {
  return new Promise(done => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return done();
    const current = server;
    current.once('exit', done);
    current.kill('SIGTERM');
    const timer = setTimeout(() => current.kill('SIGKILL'), 5000);
    timer.unref();
    current.once('exit', () => clearTimeout(timer));
  });
}
const compiler = spawn(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--watch', '--preserveWatchOutput', '--pretty', 'false', '--noEmitOnError'], { stdio: ['ignore', 'pipe', 'inherit'] });
let partial = '';
compiler.stdout.on('data', data => {
  process.stdout.write(data);
  partial += data.toString();
  const lines = partial.split(/\r?\n/); partial = lines.pop();
  for (const line of lines) if (/Found 0 errors\. Watching for file changes\./.test(line)) {
    restarting = restarting.then(async () => {
      await stopServer();
      if (stopping) return;
      server = spawn(process.execPath, [resolve(entry)], { env, stdio: 'inherit' });
      server.once('error', error => { console.error(error.message); stop(1); });
      server.once('exit', (code, signal) => {
        if (code && !signal && !stopping) console.error(`Service exited (${code}); fix the error and save a source file to restart.`);
      });
    });
  }
});
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  compiler.kill('SIGTERM');
  void stopServer().then(() => { process.exitCode = code; });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
compiler.once('error', error => { console.error(error.message); stop(1); });
compiler.once('exit', code => { if (!stopping) stop(code || 1); });
