/**
 * The recording kit the demo scripts share: a browser driven the way a person would use it (a visible cursor, slow typing, a caption at the
 * bottom saying what is happening), recorded as real 3840 x 2160 pictures and made into an .mp4, with optional narration.
 *
 * Narration: `rec.say(text)` speaks the text with the Mac's own voice (macOS `say`), places it at the moment it was started, and `finish()`
 * mixes every spoken line into the video's sound track and writes the lines, with their times, to `<name>.notes.md` (the speaker notes).
 * `rec.step(caption, text, doing)` is the usual way in: the caption is shown, the line is spoken while `doing` runs, and the step lasts
 * until both are done, so a slow answer from the assistant is covered by what is being said.
 *
 * Needs: playwright (in the repo), a Chromium it can start (PLAYWRIGHT_CHROMIUM_PATH, else the newest one already installed), ffmpeg, and for
 * narration the macOS `say` command.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const { chromium } = require(require.resolve('playwright', { paths: [ROOT] }));

function chromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  const shells = fs.readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const dir of shells) {
    const found = ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64'].map((sub) => path.join(cache, dir, sub, 'chrome-headless-shell')).find((p) => fs.existsSync(p));
    if (found) return found;
  }
  return undefined;
}

/* ── what is drawn over the page: a caption, a cursor and a click ripple ───────────────────────────────────────────────────────────── */
const OVERLAY = `(() => {
  if (window.top !== window) return;
  const css = 'nextjs-portal{display:none!important}#__cap{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:2147483647;max-width:1500px;padding:16px 30px;border-radius:16px;background:rgba(32,26,22,.92);color:#fff;font:600 30px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none;transition:opacity .25s}#__cap:empty{opacity:0}'
    + '#__cur{position:fixed;left:0;top:0;width:34px;height:34px;z-index:2147483647;pointer-events:none;transform:translate(-4px,-2px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}'
    + '.__rip{position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:4px solid #a8346f;pointer-events:none;animation:__rip .55s ease-out forwards}@keyframes __rip{to{transform:scale(4.2);opacity:0}}';
  const mount = () => {
    if (document.getElementById('__cap')) return;
    const style = document.createElement('style'); style.textContent = css; document.documentElement.appendChild(style);
    const cap = document.createElement('div'); cap.id = '__cap'; cap.setAttribute('aria-hidden', 'true'); document.documentElement.appendChild(cap);
    try { cap.textContent = sessionStorage.getItem('__cap') || ''; } catch {}
    const cur = document.createElement('div'); cur.id = '__cur'; cur.setAttribute('aria-hidden', 'true');
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M3 2l7.5 19 2.6-7.6L21 10.8z" fill="#fff" stroke="#201a16" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    try { const p = JSON.parse(sessionStorage.getItem('__pos') || 'null'); if (p) { cur.style.left = p.x + 'px'; cur.style.top = p.y + 'px'; } } catch {}
    document.documentElement.appendChild(cur);
    addEventListener('mousemove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; try { sessionStorage.setItem('__pos', JSON.stringify({ x: e.clientX, y: e.clientY })); } catch {} }, true);
    addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = '__rip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700); }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount); else mount();
})();`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

/** A recording kit that writes into `out`. */
function createKit({ out, keepFrames = false, voice = 'Karen', rate = 168, captionAt = 'bottom', captions = true, ripple = '#a8346f' }) {
  // The caption sits at the bottom of the picture, or at the top where the screen has a message box at the bottom (a chat).
  const base = captionAt === 'top' ? OVERLAY.replace('bottom:34px', 'top:12px').replace('padding:16px 30px', 'padding:10px 26px').replace('font:600 30px/1.3', 'font:600 26px/1.3') : OVERLAY;
  // The click ripple takes the brand's colour (a recording for another brand passes its own).
  const overlay = base.split('#a8346f').join(ripple);
  async function openRecorder(name, { storageState, profileDir } = {}) {
    const dir = path.join(out, '.raw', name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // The page is laid out at 1920 x 1080 and drawn at twice the size, so the frames are real 3840 x 2160 pictures (crisp text), not a small picture in a big frame.
    // With `profileDir` the browser keeps its own saved state there (a rehearsal can come back to a conversation it built earlier).
    let browser = null;
    let context;
    if (profileDir) {
      context = await chromium.launchPersistentContext(profileDir, { executablePath: chromiumPath(), viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, colorScheme: 'light' });
      browser = context.browser();
    } else {
      browser = await chromium.launch({ executablePath: chromiumPath() });
      context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, storageState, colorScheme: 'light' });
    }
    await context.addInitScript(overlay);
    const page = profileDir ? (context.pages()[0] || await context.newPage()) : await context.newPage();
    // What happened to the page, kept beside the pictures: a crash or a close shows here.
    const events = path.join(dir, 'events.log');
    const note = (line) => { try { fs.appendFileSync(events, `${new Date().toISOString().slice(11, 23)} ${line}\n`); } catch { /* the folder may be gone */ } };
    page.on('crash', () => note('page crashed'));
    page.on('close', () => note('page closed'));
    page.on('pageerror', (error) => note(`page error: ${String(error.message).slice(0, 160)}`));
    page.on('framedetached', (frame) => note(`frame gone: ${frame.url().replace(/[?#].*/, '').slice(0, 80)}`));
    const cdp = await context.newCDPSession(page);
    // Pictures are taken as fast as the browser can make real 3840 x 2160 ones (about fifteen a second); a picture identical to the last is not kept.
    const frames = [];
    let capturing = true;
    let lastHash = '';
    const taking = (async () => {
      while (capturing) {
        const at = Date.now() / 1000;
        try {
          // A picture the browser never answers must not hold the recording (or its ending) forever: after eight seconds it is dropped and the next is tried.
          const { data } = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 2 } }), new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timed out')), 8000))]);
          const hash = crypto.createHash('md5').update(data).digest('hex');
          if (hash !== lastHash) {
            const file = path.join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
            frames.push({ file, at });
            lastHash = hash;
          } else await wait(40);
        } catch { await wait(100); }
      }
    })();
    const started = Date.now();
    const spoken = [];
    const rec = {
      page, context, browser, dir, name, spoken,
      seconds: () => Math.round((Date.now() - started) / 100) / 10,
      /** The line of text drawn over the picture; nothing is drawn when the kit is made with captions: false (the speaker notes still keep the scene's title). */
      async caption(text) { if (!captions) return; await page.evaluate((t) => { try { sessionStorage.setItem('__cap', t); } catch {} const el = document.getElementById('__cap'); if (el) el.textContent = t; }, text); },
      async hold(ms) { await wait(ms); },
      async goto(url) { await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle').catch(() => {}); await wait(900); },
      pos: { x: 960, y: 540 },
      async glide(x, y, ms = 650) {
        const from = rec.pos;
        const steps = Math.max(10, Math.round(ms / 22));
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
          await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
          await wait(ms / steps);
        }
        rec.pos = { x, y };
      },
      async target(locator) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        const box = await locator.boundingBox();
        if (!box) throw new Error(`nothing to point at: ${locator}`);
        return { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 };
      },
      async point(locator) { const p = await rec.target(locator); await rec.glide(p.x, p.y); await wait(350); },
      async click(locator, after = 900) { const p = await rec.target(locator); await rec.glide(p.x, p.y); await wait(300); await page.mouse.down(); await wait(70); await page.mouse.up(); await wait(after); },
      async type(locator, text, delay = 55) { await rec.click(locator, 200); await page.keyboard.type(text, { delay }); await wait(500); },
      async scroll(dy, ms = 1400) { const steps = Math.max(8, Math.round(ms / 60)); for (let i = 0; i < steps; i += 1) { await page.mouse.wheel(0, dy / steps); await wait(ms / steps); } await wait(300); },

      /** Speaks a line now. Returns when it will be finished; the line is recorded for the sound track and the speaker notes. */
      say(text, caption = '') {
        const index = spoken.length + 1;
        const file = path.join(dir, `say-${String(index).padStart(2, '0')}.aiff`);
        execFileSync('say', ['-v', voice, '-r', String(rate), '-o', file, text]);
        const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
        const line = { file, text, caption, startedAt: Date.now() / 1000, atSeconds: rec.seconds(), seconds };
        spoken.push(line);
        return { seconds, done: wait(seconds * 1000 + 250) };
      },
      /** A caption, a spoken line, and something being done meanwhile; the step lasts until the line and the doing are both over. */
      async step(caption, text, doing) {
        await rec.caption(caption);
        const line = text ? rec.say(text, caption) : { done: Promise.resolve() };
        await Promise.all([doing ? doing() : Promise.resolve(), line.done]);
        await wait(300);
      },

      async finish() {
        await rec.caption('');
        await wait(600);
        const endedAt = Date.now() / 1000;
        capturing = false;
        await taking;
        await context.close();
        if (browser) await browser.close().catch(() => {});
        if (frames.length === 0) throw new Error('no picture was captured');
        // Each picture is shown until the next one arrived (a screen that did not change sends no new picture), then made a steady 30 pictures a second.
        const list = frames.map((frame, i) => `file '${frame.file}'\nduration ${Math.max(0.02, ((i + 1 < frames.length ? frames[i + 1].at : Math.max(endedAt, frame.at + 0.5)) - frame.at)).toFixed(3)}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
        fs.writeFileSync(path.join(dir, 'frames.txt'), list);
        fs.mkdirSync(out, { recursive: true });
        const mp4 = path.join(out, `${name}.mp4`);
        const silent = spoken.length ? path.join(dir, 'silent.mp4') : mp4;
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', silent]);
        if (spoken.length) {
          const t0 = frames[0].at;
          const inputs = spoken.flatMap((line) => ['-i', line.file]);
          const delays = spoken.map((line, i) => `[${i + 1}:a]adelay=${Math.max(0, Math.round((line.startedAt - t0) * 1000))}|${Math.max(0, Math.round((line.startedAt - t0) * 1000))}[a${i}]`);
          const mix = `${delays.join(';')};${spoken.map((_, i) => `[a${i}]`).join('')}amix=inputs=${spoken.length}:normalize=0:dropout_transition=0[aout]`;
          execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', silent, ...inputs, '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', mp4]);
          const notes = [`# ${name}: speaker notes`, '', `Voice: ${voice}. Times are minutes:seconds into the video.`, '',
            ...spoken.flatMap((line) => [`**${clock(Math.max(0, line.startedAt - t0))}**${line.caption ? ` (${line.caption})` : ''}`, '', line.text, ''])];
          fs.writeFileSync(path.join(out, `${name}.notes.md`), notes.join('\n'));
        }
        if (!keepFrames) fs.rmSync(dir, { recursive: true, force: true });
        const info = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration,size', '-of', 'csv=p=0', mp4]).toString().trim().split('\n').join(' ');
        console.log(`  ✓ ${name}.mp4  (${info})${spoken.length ? `  ${spoken.length} spoken lines` : ''}`);
        return mp4;
      },
    };
    return rec;
  }
  return { openRecorder };
}

/**
 * The email and password of a demo person (its id is the part of the email before the @, for example "trade.admin"), read from the private file
 * `scripts/placemakers/demo-logins.ts` writes (DEMO_LOGINS_FILE, else .env.demo-logins.json in the repo root). The file holds passwords: make it
 * when recording and delete it afterwards.
 */
function demoLogin(persona) {
  const file = process.env.DEMO_LOGINS_FILE || path.join(ROOT, '.env.demo-logins.json');
  if (!fs.existsSync(file)) throw new Error('The demo logins file is missing: run "npx tsx scripts/placemakers/demo-logins.ts" first (it holds passwords; delete it when you are done).');
  const entry = (JSON.parse(fs.readFileSync(file, 'utf8')).logins || []).find((login) => String(login.email).split('@')[0] === persona);
  if (!entry) throw new Error(`There is no demo login for "${persona}" in ${file}.`);
  return { email: entry.email, password: entry.password };
}

module.exports = { createKit, chromium, chromiumPath, wait, demoLogin, ROOT };
