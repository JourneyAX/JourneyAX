#!/usr/bin/env node
/**
 * Asks the assistant one real question in a browser and prints what it answered and the steps it took: a way to see what a person would see.
 *
 *   node scripts/demo/ask.cjs --yes-run-real-chats --question "How do I install ..." [--base http://localhost:3008] [--project placemakers]
 *        [--wait 180] [--shot out.png] [--steps]
 *
 * Each run is a real model run (and writes a conversation record), so it only runs with --yes-run-real-chats. It signs in with the sign-in
 * screen's own "Quick Demo Sign-in" button (the app's built-in dev login) when it meets the screen; it never types a password.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const ROOT = path.resolve(__dirname, '../..');
const { chromium } = require(require.resolve('playwright', { paths: [ROOT] }));
const base = opt('base', 'http://localhost:3008').replace(/\/$/, '');
const project = opt('project', 'placemakers');
const question = opt('question', '');
const waitSeconds = Number(opt('wait', '180'));
if (!args.includes('--yes-run-real-chats')) { console.log('Dry run: this would ask the assistant at', base, 'one real question. Add --yes-run-real-chats to run it.'); process.exit(0); }
if (!question) throw new Error('--question "..." is needed');

function chromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  for (const dir of fs.readdirSync(cache).filter((n) => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    const found = ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64'].map((sub) => path.join(cache, dir, sub, 'chrome-headless-shell')).find((p) => fs.existsSync(p));
    if (found) return found;
  }
  return undefined;
}

(async () => {
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${base}/?project=${project}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat-input-field, #quick-login-btn', { timeout: 60000 });
  if (await page.locator('#quick-login-btn').count()) { await page.click('#quick-login-btn'); await page.waitForSelector('#chat-input-field', { timeout: 60000 }); }
  await page.waitForTimeout(1500);
  await page.fill('#chat-input-field', question);
  await page.press('#chat-input-field', 'Enter');
  const started = Date.now();
  await page.waitForSelector('#chat-stop-btn', { timeout: 20000 }).catch(() => {});
  while (Date.now() - started < waitSeconds * 1000) {
    if ((await page.locator('#chat-stop-btn').count()) === 0) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2500);
  if (args.includes('--steps')) {
    for (const fold of await page.locator('summary, button', { hasText: /Worked for/ }).all()) { try { await fold.click({ timeout: 2000 }); } catch {} }
    await page.waitForTimeout(800);
  }
  const text = await page.evaluate(() => (document.querySelector('.chat-thread') || document.querySelector('.chat-messages') || document.body).innerText);
  console.log(`--- answered in ${Math.round((Date.now() - started) / 1000)} s ---`);
  console.log(text);
  if (opt('shot')) await page.screenshot({ path: path.resolve(opt('shot')), fullPage: false });
  await browser.close();
})().catch((error) => { console.error(String(error.message || error).slice(0, 300)); process.exit(1); });
