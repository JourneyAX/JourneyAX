#!/usr/bin/env node
/**
 * Asks the assistant one real question in a browser and prints what it answered and the steps it took: a way to see what a person would see.
 *
 *   node scripts/demo/ask.cjs --yes-run-real-chats --question "How do I install ..." [--question "a follow-up" ...] [--base http://localhost:3008]
 *        [--project placemakers] [--persona trade.admin] [--click Allow] [--wait 180] [--shot out.png] [--steps]
 *
 * Each run is a real model run (and writes a conversation record), so it only runs with --yes-run-real-chats. It signs in with the sign-in
 * demo person's email and password (--persona <id>, for example trade.admin; read from the private demo logins file, see recorder-core.cjs) or "Quick Demo Sign-in" button (the app's built-in dev login) when it meets the screen.
 * Give --question more than once to ask several messages in a row, each after the previous answer has finished.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const ROOT = path.resolve(__dirname, '../..');
const { demoLogin } = require('./recorder-core.cjs');
const { chromium } = require(require.resolve('playwright', { paths: [ROOT] }));
const base = opt('base', 'http://localhost:3008').replace(/\/$/, '');
const project = opt('project', 'placemakers');
const questions = args.flatMap((a, i) => (a === '--question' && args[i + 1] ? [args[i + 1]] : []));
const persona = opt('persona', '');
const clickLabel = opt('click', '');
const waitSeconds = Number(opt('wait', '180'));
if (!args.includes('--yes-run-real-chats')) { console.log('Dry run: this would ask the assistant at', base, 'one real question. Add --yes-run-real-chats to run it.'); process.exit(0); }
if (questions.length === 0) throw new Error('--question "..." is needed');

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
  if (args.includes('--net')) page.on('response', async (res) => { const u = res.url(); if (/chat|agent|runtime|turn|stream/i.test(u) && !/_next|\.js|\.css/.test(u)) console.log('NET', res.status(), res.request().method(), u.replace(base, '').slice(0, 110)); if (args.includes('--net-body') && /chat\/stream/.test(u)) { try { const t = await res.text(); console.log('BODY', t.length, JSON.stringify(t.slice(-1200))); } catch (e) { console.log('BODY unreadable', String(e.message).slice(0, 80)); } } });
  if (args.includes('--net-req')) page.on('request', (req) => { if (/chat\/stream/.test(req.url())) { try { const b = JSON.parse(req.postData() || '{}'); delete b.messages; delete b.state; console.log('REQ', JSON.stringify(b).slice(0, 700)); } catch { console.log('REQ (not json)'); } } });
  if (args.includes('--net')) page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
  await page.goto(`${base}/?project=${project}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chat-input-field, #quick-login-btn, #login-email', { timeout: 60000 });
  if (persona) {
    if (await page.locator('#chat-input-field').count()) throw new Error('already signed in; use a fresh browser to sign in as a persona');
    const login = demoLogin(persona);
    await page.fill('#login-email', login.email);
    await page.fill('#login-password', login.password);
    await page.click('#login-submit');
    await page.waitForSelector('#chat-input-field', { timeout: 60000 });
  } else if (await page.locator('#quick-login-btn').count()) { await page.click('#quick-login-btn'); await page.waitForSelector('#chat-input-field', { timeout: 60000 }); }
  await page.waitForTimeout(1500);
  const started = Date.now();
  for (const question of questions) {
    await page.fill('#chat-input-field', question);
    await page.press('#chat-input-field', 'Enter');
    const askedAt = Date.now();
    await page.waitForSelector('#chat-stop-btn', { timeout: 20000 }).catch(() => {});
    while (Date.now() - askedAt < waitSeconds * 1000) {
      if ((await page.locator('#chat-stop-btn').count()) === 0) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(1500);
  }
  if (clickLabel) {
    // Presses a button of the last card (for example "Allow") and waits for what follows.
    const button = page.locator('button', { hasText: new RegExp(`^${clickLabel}$`) }).last();
    await button.click({ timeout: 20000 });
    const pressedAt = Date.now();
    await page.waitForTimeout(3000);
    while (Date.now() - pressedAt < waitSeconds * 1000 && (await page.locator('#chat-stop-btn').count()) > 0) await page.waitForTimeout(1000);
    await page.waitForTimeout(4000);
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
