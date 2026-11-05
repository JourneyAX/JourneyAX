import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentConfig } from './stack-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  const { env, ports } = developmentConfig(root);
  for (const { name, port } of ports) {
    const available = await new Promise(done => {
      const server = createServer();
      server.once('error', () => done(false));
      server.listen(port, () => server.close(() => done(true)));
    });
    if (!available) throw new Error(`${name} port ${port} is already in use. Stop the previous local stack first; no process was stopped.`);
  }
  console.log('Starting the existing DEV apps and package watchers. No seed, release publication or deployment step is run.');
  console.log('Go: http://localhost:3008  |  Back office: http://localhost:3009  |  Stripe: test mode');
  // Loose env is development-only. Vendor secrets are loaded separately by the connector workspace.
  const child = spawn(process.execPath, [resolve(root, 'node_modules/turbo/bin/turbo'), 'run', 'dev', '--concurrency=30', '--env-mode=loose', '--ui=stream'], { cwd: root, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('error', () => { console.error('Could not start the installed workspace runner.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
