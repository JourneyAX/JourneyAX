import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [mode] = process.argv.slice(2);
const isWindows = process.platform === 'win32';
const venvPython = join('.venv', isWindows ? 'Scripts/python.exe' : 'bin/python');

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('error', (error) => {
      console.error(`Unable to run ${command}: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

if (mode === 'setup') {
  // `py -3.12` is the standard Windows Python launcher equivalent of python3.12.
  const python = isWindows ? 'py' : 'python3.12';
  const pythonArgs = isWindows ? ['-3.12'] : [];
  const venvExitCode = await run(python, [...pythonArgs, '-m', 'venv', '.venv']);
  process.exitCode = venvExitCode === 0
    ? await run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'])
    : venvExitCode;
} else if (mode === 'dev' || mode === 'start') {
  if (!existsSync(venvPython)) {
    console.error('Python virtual environment not found. Run `npm run setup` first.');
    process.exitCode = 1;
  } else {
    const args = ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', process.env.PORT || '8091'];
    if (mode === 'dev') args.push('--reload');
    process.exitCode = await run(venvPython, args);
  }
} else {
  console.error('Usage: node scripts/run-python.mjs <setup|dev|start>');
  process.exitCode = 1;
}
