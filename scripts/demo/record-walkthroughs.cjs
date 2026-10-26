#!/usr/bin/env node
/**
 * Records walkthrough videos of the app in 4K (3840 x 2160): a browser is driven the way a person would use it (a visible cursor, slow typing,
 * a caption at the bottom saying what is happening) and each walkthrough is saved as an .mp4 of about a minute.
 *
 *   node scripts/demo/record-walkthroughs.cjs --out <folder> [--base http://scratch.localhost:3918] [--project placemakers]
 *        [--login admin:demo] [--only connectors,skills]            the screens (they use no model and cost nothing)
 *   node scripts/demo/record-walkthroughs.cjs --out <folder> --chat TC-01,TC-05 --passwords <file.json> [--yes-run-real-chats]
 *        a real conversation for each test case: sign in as the case's login, type its question, wait for the answer
 *
 * The screens are recorded against whatever --base points at. Against the scratch demo (pretend data) they show the real screens with the
 * real persona library and pack rules, but nothing a customer would be told.
 *
 * Conversations (--chat) call the real assistant, so each one costs model usage and writes a conversation record. Without
 * --yes-run-real-chats the script only prints what it would do. --passwords is a JSON file {"csr@placemakers.demo": "..."} kept outside the repo; no
 * password is ever typed on screen (the browser starts already signed in) and none is written to the videos or to this repo.
 *
 * Needs: playwright (in the repo), a Chromium it can start (PLAYWRIGHT_CHROMIUM_PATH, else the newest one already installed), and ffmpeg.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'walkthroughs')));
const BASE = opt('base', 'http://scratch.localhost:3918').replace(/\/$/, '');
const PROJECT = opt('project', 'placemakers');
const [LOGIN_EMAIL, LOGIN_PASSWORD] = (opt('login', 'admin:demo') || '').split(':');
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const CHAT = (opt('chat', '') || '').split(',').filter(Boolean);

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

async function openRecorder(name, { storageState } = {}) {
  const dir = path.join(OUT, '.raw', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  // The page is laid out at 1920 x 1080 and drawn at twice the size, so the frames are real 3840 x 2160 pictures (crisp text), not a small picture in a big frame.
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, storageState, colorScheme: 'light' });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  // Pictures are taken as fast as the browser can make real 3840 x 2160 ones (about fifteen a second); a picture identical to the last is not kept.
  const frames = [];
  let capturing = true;
  let lastHash = '';
  const taking = (async () => {
    while (capturing) {
      const at = Date.now() / 1000;
      try {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 2 } });
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
  const rec = {
    page, context, browser, dir, name,
    seconds: () => Math.round((Date.now() - started) / 100) / 10,
    async caption(text) { await page.evaluate((t) => { try { sessionStorage.setItem('__cap', t); } catch {} const el = document.getElementById('__cap'); if (el) el.textContent = t; }, text); },
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
    async finish() {
      await rec.caption('');
      await wait(600);
      const endedAt = Date.now() / 1000;
      capturing = false;
      await taking;
      await context.close();
      await browser.close();
      if (frames.length === 0) throw new Error('no picture was captured');
      // Each picture is shown until the next one arrived (a screen that did not change sends no new picture), then made a steady 30 pictures a second.
      const list = frames.map((frame, i) => `file '${frame.file}'\nduration ${Math.max(0.02, ((i + 1 < frames.length ? frames[i + 1].at : Math.max(endedAt, frame.at + 0.5)) - frame.at)).toFixed(3)}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
      fs.writeFileSync(path.join(dir, 'frames.txt'), list);
      fs.mkdirSync(OUT, { recursive: true });
      const mp4 = path.join(OUT, `${name}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-movflags', '+faststart', mp4]);
      if (!flag('keep-frames')) fs.rmSync(dir, { recursive: true, force: true });
      const info = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration,size', '-of', 'csv=p=0', mp4]).toString().trim().split('\n').join(' ');
      console.log(`  ✓ ${name}.mp4  (${info})`);
      return mp4;
    },
  };
  return rec;
}

/** Signs in once, outside the video, and keeps the cookies so a recording starts already signed in. */
async function signedInState(email, password) {
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const context = await browser.newContext();
  const res = await context.request.post(`${BASE}/api/auth/login?project=${PROJECT}`, { data: { email, password } });
  if (!res.ok()) { await browser.close(); throw new Error(`could not sign in as ${email} (${res.status()})`); }
  const state = await context.storageState();
  await browser.close();
  return state;
}

const app = (p, query = '') => `${BASE}${p}?project=${PROJECT}${query}`;
const L = (page, text, tag = 'button') => page.locator(tag, { hasText: text });

/* ── the screens ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
const SCREENS = {
  'chat-menu': {
    title: 'The chat: a clean new chat and the + menu',
    async run(r) {
      const { page } = r;
      await r.goto(app('/'));
      await r.caption('A new chat: just the message box and a few things to ask, chosen from what this person may do');
      await r.hold(5500);
      await r.caption('The + button opens Skills, Connectors and Plugins, like Claude');
      await r.click(page.locator('button[aria-label="Add to the message"]'), 1400);
      await r.hold(2500);
      await r.caption('Skills: the playbooks the assistant has. Pick one and its request is typed for you');
      await r.click(L(page, 'Skills', 'button[role="menuitem"]'), 1500);
      await r.hold(4000);
      await r.caption('Manage skills and Browse skills are always at the bottom');
      await r.point(L(page, 'Manage skills', 'a'));
      await r.hold(3500);
      await r.caption('Connectors: one switch for each connected system, for this chat only');
      await r.click(L(page, 'Connectors', 'button[role="menuitem"]'), 1500);
      await r.hold(3500);
      await r.click(page.locator('button[role="menuitemcheckbox"]').first(), 1200);
      await r.caption('Switch one off and the assistant will not use it in this chat');
      await r.hold(3500);
      await r.click(page.locator('button[role="menuitemcheckbox"]').first(), 1000);
      await r.caption('Plugins: bundles of agents, skills and systems, and what each brings');
      await r.click(L(page, 'Plugins', 'button[role="menuitem"]'), 1500);
      await r.hold(5000);
      await r.caption('Manage and Browse take you to the Customize page');
      await r.point(L(page, 'Manage plugins', 'a'));
      await r.hold(3500);
      await page.keyboard.press('Escape');
      await r.caption('No agent dropdown, no empty cart: the screen stays as quiet as Claude\'s');
      await r.hold(5500);
    },
  },
  connectors: {
    title: 'Customize: connectors, and who may do what with each tool',
    async run(r) {
      const { page } = r;
      await r.goto(app('/customize', '&tab=connectors'));
      await r.caption('Connectors: every system the assistant can reach, its type and its status');
      await r.hold(5500);
      await r.caption('The connected systems come first; the platform\'s own tools are below');
      await r.scroll(500, 1600);
      await r.scroll(-500, 1200);
      await r.caption('Open Salesforce');
      await r.click(page.locator('.ax-ctable__name', { has: page.locator('strong', { hasText: /^Salesforce$/ }) }), 1800);
      await r.caption('The switch turns the whole system on or off for the assistant');
      await r.point(page.locator('button[role="switch"]'));
      await r.hold(3500);
      await r.caption('Tool permissions are set one team at a time. Customer Service first');
      await r.point(page.locator('.ax-teampick select'));
      await r.hold(3500);
      await r.scroll(420, 1600);
      await r.caption('Interactive tools change data, so they always ask first. Read-only tools can be allowed');
      await r.hold(5000);
      await r.scroll(450, 1600);
      await r.caption('Customer Service reads accounts and cases, but cannot see leads or deals');
      await r.hold(5500);
      await r.caption('Change a tool for the team: Allow, Ask first or Blocked');
      const lead = page.locator('.ax-permlist li', { hasText: 'Find lead' }).locator('.ax-perm__btn--allow');
      await r.click(lead, 1500);
      await r.caption('Nothing is live yet: the bar at the bottom says what would change');
      await r.hold(5000);
      await r.caption('Discard, or Make live: the publication check runs first and everything is put back if it refuses');
      await r.click(page.locator('.ax-savebar button', { hasText: 'Discard' }), 1500);
      await r.hold(3500);
      await r.caption('Systems that are switched off, like Zendesk, wait under Discover');
      await r.goto(app('/customize', '&tab=connectors&scope=discover'));
      await r.hold(6000);
    },
  },
  skills: {
    title: 'Customize: skills as rows, with a page for each',
    async run(r) {
      const { page } = r;
      await r.goto(app('/customize', '&tab=skills'));
      await r.caption('Skills: what the assistant knows how to do, in two groups');
      await r.hold(5000);
      await r.scroll(500, 1800);
      await r.caption('Always on, and opened when a request fits');
      await r.hold(4000);
      await r.scroll(-500, 1200);
      await r.caption('Open a skill');
      await r.click(page.locator('.ax-rowlist__item').first(), 1800);
      await r.caption('Overview: what it is for, who has it, which assistants carry it');
      await r.hold(5500);
      await r.caption('The side column lists the tools it uses, by system');
      await r.point(page.locator('.ax-detail__aside'));
      await r.hold(4500);
      await r.caption('Contents: the instructions, for people who may change the configuration');
      await r.click(L(page, 'Contents', 'button[role="tab"]'), 1500);
      await r.hold(5500);
      await r.caption('Try in chat starts a chat with an assistant that has this skill');
      await r.point(L(page, 'Try in chat', 'button'));
      await r.hold(4000);
      await r.click(L(page, 'Your skills', 'button'), 1500);
      await r.caption('Add: create a skill, or upload one from a SKILL.md file');
      await r.click(L(page, 'Add', 'button.ax-btn--primary'), 1500);
      await r.hold(6000);
      await page.keyboard.press('Escape');
    },
  },
  personas: {
    title: 'Customize: personas, their use cases and the tools check',
    async run(r) {
      const { page } = r;
      await r.goto(app('/customize', '&tab=personas'));
      await r.caption('Personas: the people who use the assistant, from the owner\'s sheets');
      await r.hold(5000);
      await r.caption('Every use case is checked: do the tools it needs work for that person\'s team?');
      await r.point(page.locator('.ax-summary'));
      await r.hold(5500);
      await r.scroll(450, 1800);
      await r.caption('Each team is a section, with its personas as cards');
      await r.hold(4500);
      await r.caption('Open a persona');
      await r.click(page.locator('.ax-linkbtn--title', { hasText: 'Trade Support Advisor' }), 1800);
      await r.hold(3000);
      await r.caption('Who they are, how they sign in, and each thing they want done');
      await r.scroll(420, 1600);
      await r.hold(3500);
      await r.caption('Each tool is marked: works, asks first, or blocked, and why');
      await r.hold(5500);
      await r.caption('Customer Service cannot see deals, so this one shows a gap');
      await r.point(page.locator('.ax-outcome--blocked').first());
      await r.hold(5000);
      await r.caption('Edit tools: say which other tools a scenario needs');
      await r.click(page.locator('article', { hasText: 'Handle any account enquiry' }).locator('button', { hasText: 'Edit tools' }), 2000);
      await r.hold(5000);
      await r.caption('Each tool shows what it would do for this team. Ticking only makes a note');
      await r.hold(4500);
      await page.keyboard.press('Escape');
      await r.hold(1500);
    },
  },
  scenarios: {
    title: 'Customize: a test scenario for every persona',
    async run(r) {
      const { page } = r;
      await r.goto(app('/customize', '&tab=personas'));
      await r.caption('Test scenarios: every use case of every persona, ready to try');
      await r.click(L(page, 'Test scenarios', 'button'), 2000);
      await r.hold(3000);
      await r.caption('Who to sign in as, what to ask, what should be possible');
      await r.scroll(450, 1800);
      await r.hold(4500);
      await r.caption('What the answer should say, and what it must not');
      await r.scroll(500, 1800);
      await r.hold(5000);
      await r.caption('Where the tools are stopped, it says which and why');
      await r.scroll(500, 1800);
      await r.hold(4500);
      await r.caption('Edit question: write it the way a colleague would say it');
      await r.click(L(page, 'Edit question', 'button').first(), 1800);
      await r.hold(4500);
      await page.keyboard.press('Escape');
      await r.hold(800);
      await r.caption('Try in chat opens a new chat with the question typed, not sent');
      await r.click(L(page, 'Try in chat', 'button').first(), 2500);
      await r.hold(6000);
      await r.caption('Sign in as the person named, press send, and see what the assistant does');
      await r.hold(5000);
    },
  },
};

/* ── real conversations, from the test set ─────────────────────────────────────────────────────────────────────────────────────────── */
async function recordChat(testCase, passwords) {
  const state = await signedInState(testCase.loginEmail, passwords[testCase.loginEmail]);
  const r = await openRecorder(`chat-${testCase.id}`, { storageState: state });
  const { page } = r;
  await r.goto(app('/'));
  await r.caption(`${testCase.id}: signed in as ${testCase.loginEmail}`);
  await r.hold(4500);
  await r.caption('Ask the question');
  await r.type(page.locator('#chat-input-field'), testCase.prompt, 50);
  await r.hold(1200);
  await r.click(page.locator('#chat-send-btn'), 800);
  await r.caption('The assistant works: it looks things up in the connected systems');
  await page.waitForSelector('#chat-send-btn', { state: 'attached', timeout: 180000 }).catch(() => {});
  await r.hold(1500);
  for (let i = 0; i < 90; i += 1) { if (await page.locator('#chat-stop-btn').count() === 0) break; await wait(1000); }
  await r.caption('The answer, with what it found');
  await r.hold(7000);
  await r.scroll(500, 1500);
  if (testCase.shouldSay.length) { await r.caption(`It should say: ${testCase.shouldSay.slice(0, 2).join('; ')}`); await r.hold(6000); }
  return r.finish();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (CHAT.length) {
    const library = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/agent-instructions/personas/placemakers-personas.json'), 'utf8'));
    const cases = CHAT.map((id) => library.testCases.find((c) => c.id === id)).filter(Boolean);
    if (cases.length !== CHAT.length) throw new Error(`not every test case exists: ${CHAT.join(', ')}`);
    console.log(`${cases.length} real conversation(s), each a model run against ${BASE}: ${cases.map((c) => `${c.id} (${c.loginEmail})`).join(', ')}`);
    if (!flag('yes-run-real-chats')) { console.log('Dry run: nothing was recorded. Add --yes-run-real-chats (and --passwords <file.json>) to record them.'); return; }
    const passwordsFile = opt('passwords');
    if (!passwordsFile) throw new Error('--passwords <file.json> is needed to sign in as the logins');
    const passwords = JSON.parse(fs.readFileSync(passwordsFile, 'utf8'));
    for (const testCase of cases) await recordChat(testCase, passwords);
    return;
  }
  const names = Object.keys(SCREENS).filter((name) => !ONLY.length || ONLY.includes(name));
  console.log(`Recording ${names.length} walkthrough(s) of ${BASE} into ${OUT}`);
  const state = await signedInState(LOGIN_EMAIL, LOGIN_PASSWORD);
  for (const name of names) {
    const r = await openRecorder(name, { storageState: state });
    try { await SCREENS[name].run(r); } catch (error) { console.error(`  ✗ ${name}: ${String(error.message || error).slice(0, 240)}`); }
    console.log(`    ${SCREENS[name].title}: ${r.seconds()} s`);
    await r.finish();
  }
})().catch((error) => { console.error(String(error.message || error)); process.exit(1); });
