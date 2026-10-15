import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'output');
const clips = join(output, 'clips');
const timing = JSON.parse(await readFile(join(output, 'timing.json'), 'utf8'));
const film = join(output, 'journeyax-launch-v2-silent.mp4');
await mkdir(clips, { recursive: true });

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr}`)));
  });
}

let start = 0;
for (let i = 0; i < timing.scenes.length; i++) {
  const scene = timing.scenes[i];
  const path = join(clips, `${String(i + 1).padStart(2, '0')}-${scene.name}.mp4`);
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', film,
    '-t', String(scene.seconds), '-an', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]);
  process.stdout.write(`${String(i + 1).padStart(2, '0')} ${scene.seconds}s ${path}\n`);
  start += scene.seconds;
}
