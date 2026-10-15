import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const film = join(root, 'output/journeyax-launch-v2-silent.mp4');
const cut = join(root, 'output/journeyax-linkedin-60-silent.mp4');

// Eight visually complete beats. All source intervals come from the authored film.
const segments = [
  { start:19, seconds:6 },  // shopping systems feel disconnected
  { start:0, seconds:8 },   // customer goals across industries
  { start:34, seconds:10 }, // connected systems → JAX → outcomes
  { start:52, seconds:5 },  // merchant-defined agents
  { start:66, seconds:6 },  // Business Pack
  { start:82, seconds:7 },  // adaptive journey
  { start:142, seconds:10 },// agent acts through the journey
  { start:169, seconds:8 }  // brand close
];
const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
if (total !== 60) throw new Error(`LinkedIn cut must be 60 seconds, got ${total}`);

const filters = segments.map((segment, i) =>
  `[0:v]trim=start=${segment.start}:duration=${segment.seconds},setpts=PTS-STARTPTS[v${i}]`
).join(';') + ';' + segments.map((_, i) => `[v${i}]`).join('') +
  `concat=n=${segments.length}:v=1:a=0[out]`;

const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', film,
  '-filter_complex', filters, '-map', '[out]', '-an', '-c:v', 'libx264',
  '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '20',
  '-movflags', '+faststart', cut], { stdio: ['ignore', 'inherit', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
child.on('error', error => { throw error; });
child.on('close', code => {
  if (code !== 0) throw new Error(`ffmpeg exit ${code}: ${stderr}`);
  process.stdout.write(`60-second silent cut: ${cut}\n`);
});
