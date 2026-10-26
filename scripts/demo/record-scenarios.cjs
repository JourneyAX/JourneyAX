#!/usr/bin/env node
/**
 * Records the narrated scenario videos: a real person's journey through the chat, signed in as one of the demo personas, with the real
 * assistant, the real catalogue and the connected systems answering. Each video is about two minutes, in 4K (3840 x 2160), with a spoken
 * commentary (the Mac's own voice) and the speaker notes written beside it as <name>.notes.md.
 *
 *   node scripts/demo/record-scenarios.cjs --list
 *   node scripts/demo/record-scenarios.cjs --out <folder> --base http://localhost:3108 [--only 04-customer-care-ticket,06-installation-guide] --yes-run-real-chats [--no-allow]
 *        --no-allow: for a rehearsal, do not press "Allow" on the ask-first card (so no case is raised)
 *        --captions: draw each scene's title over the picture (off by default: the picture shows only the app and the cursor)
 *
 * Every scenario is a real model run (several questions each), and the customer-care scenario raises one real case in the connected Salesforce
 * (the person in the video presses "Allow" on the ask-first card, exactly as a colleague would). Without --yes-run-real-chats nothing is
 * recorded: the script only prints the plan. Each person signs in by typing their own email and password (from the private demo logins file, see recorder-core.cjs); the password field shows dots.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createKit, wait, demoLogin } = require('./recorder-core.cjs');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'scenario-videos')));
const BASE = opt('base', 'http://localhost:3108').replace(/\/$/, '');
const PROJECT = opt('project', 'placemakers');
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
/** The signed-in browser state of the commercetools Merchant Center (made by the owner signing in; a private file), and where its orders are. */
const MC_STATE = opt('mc-state', '');
const MC_ORDERS = opt('mc-orders', 'https://mc.us-central1.gcp.commercetools.com/placemaker/orders');
const { openRecorder } = createKit({ out: OUT, keepFrames: flag('keep-frames'), voice: opt('voice', 'Karen'), rate: Number(opt('rate', '168')), captionAt: 'top', captions: flag('captions') });

/* ── what a person does in the chat ────────────────────────────────────────────────────────────────────────────────────────────────── */
function chat(r) {
  const { page } = r;
  const input = () => page.locator('#chat-input-field');
  const answering = async () => (await page.locator('#chat-stop-btn').count()) > 0;
  const toEnd = async () => {
    await page.evaluate(() => {
      const list = document.querySelector('.chat-messages');
      const scroller = [list, ...(list ? [list.parentElement, list.parentElement?.parentElement] : [])].find((el) => el && el.scrollHeight > el.clientHeight + 4);
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    });
    await wait(900);
  };
  return {
    async open() { await r.goto(`${BASE}/?project=${PROJECT}`); },
    /** Signs in the way a person does: types the email and the password (shown as dots) and presses Sign in. */
    async signIn(persona) {
      const login = demoLogin(persona);
      const email = page.locator('#login-email');
      await email.waitFor({ timeout: 30000 });
      await wait(2200);
      await r.type(email, login.email, 40);
      await r.type(page.locator('#login-password'), login.password, 40);
      await wait(600);
      await r.click(page.locator('#login-submit'), 600);
      await page.waitForSelector('#chat-input-field', { timeout: 60000 });
      await wait(1200);
    },
    async pointAtSignIn() { await r.point(page.locator('#login-email')); await wait(1500); },
    /** Moves the cursor along the first few product cards of the latest answer, and along the row if it scrolls sideways. */
    async pointAtProducts() {
      const cards = page.locator('[data-card-type="products"] .jx-card');
      const n = await cards.count();
      if (n === 0) return false;
      await cards.first().scrollIntoViewIfNeeded().catch(() => {});
      await wait(600);
      for (let i = 0; i < Math.min(n, 4); i += 1) { await r.point(cards.nth(i)); await wait(900); }
      await page.evaluate(() => { const row = [...document.querySelectorAll('.product-card')].map((el) => el.parentElement).find((el) => el && el.scrollWidth > el.clientWidth + 4); if (row) row.scrollTo({ left: row.scrollWidth, behavior: 'smooth' }); });
      await wait(1200);
      return true;
    },
    /** Signs in fast, the way someone who knows the form does: the email, then the password (dots), then Sign in. */
    async signInQuick(persona) {
      const login = demoLogin(persona);
      const email = page.locator('#login-email');
      await email.waitFor({ timeout: 30000 });
      await wait(500);
      await r.type(email, login.email, 12);
      await r.type(page.locator('#login-password'), login.password, 12);
      await r.click(page.locator('#login-submit'), 300);
      await page.waitForSelector('#chat-input-field', { timeout: 60000 });
      await wait(700);
    },
    /** Presses a button by its words (the first one, or the last), optionally only inside one part of the page. */
    async press(label, { within, last = false, pause = 800 } = {}) {
      const scope = within ? page.locator(within) : page;
      const buttons = scope.getByRole('button', { name: label, exact: typeof label === 'string' });
      const button = last ? buttons.last() : buttons.first();
      await button.waitFor({ timeout: 30000 });
      await r.click(button, pause);
    },
    /** Scrolls the open side panel until a heading is in the middle. */
    async scrollPanelTo(text) {
      const heading = page.getByText(text, { exact: true }).first();
      await heading.waitFor({ timeout: 15000 });
      await heading.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await wait(1700);
    },
    async closePanel() { await r.click(page.locator('button[aria-label="Close side panel"]').first(), 700); },
    /** "Add" on the first product tile of the latest recommendations. */
    async addFromTile() { await this.press('Add', { within: '[data-card-type="products"]' }); },
    /** The "How many do you need?" box: Add 1. */
    async confirmQuantity() {
      const add = page.getByRole('button', { name: /^Add \d+$/ });
      await add.first().waitFor({ timeout: 20000 });
      await r.click(add.first(), 700);
    },
    /** The first "Add" under one group of the accessories card ("Basin mixer", "Basin waste"). */
    async addFromGroup(label) {
      const marked = await page.evaluate((text) => {
        const card = [...document.querySelectorAll('[data-card-type="accessories"]')].pop();
        if (!card) return false;
        const heading = [...card.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.trim() === text);
        if (!heading) return false;
        const button = [...card.querySelectorAll('button')].find((b) => /^\s*Add\s*$/.test(b.textContent) && (heading.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (!button) return false;
        button.setAttribute('data-rec-target', 'yes');
        return true;
      }, label);
      if (!marked) throw new Error(`no Add under "${label}"`);
      const button = page.locator('[data-rec-target="yes"]').first();
      await r.click(button, 600);
      await button.evaluate((el) => el.removeAttribute('data-rec-target')).catch(() => {});
    },
    async openBag() { await r.click(page.locator('button[aria-label^="View your"]').first(), 1500); },
    /** Stripe's payment form in the panel, filled quickly with a test person and Stripe's published test card. */
    async payWithTestCard() {
      await page.waitForSelector('iframe[src*="stripe"]', { timeout: 60000 });
      await wait(6000);
      const frame = page.frames().find((f) => /embedded-checkout-inner/.test(f.url()));
      if (!frame) throw new Error('the payment form did not open');
      const fill = async (id, value) => { await r.click(frame.locator(`#${id}`), 150); await page.keyboard.type(value, { delay: 9 }); };
      await fill('email', 'shopper@placemakers.demo');
      await fill('shippingName', 'Sam Shopper');
      await frame.locator('#shippingCountry').selectOption('NZ').catch(() => {});
      const manual = frame.getByText(/enter address manually/i).first();
      if (await manual.count()) await manual.click({ timeout: 10000 }).catch(() => {});
      await wait(600);
      await fill('shippingAddressLine1', '1 Queen Street');
      await page.keyboard.press('Escape');
      await wait(400);
      await fill('shippingLocality', 'Auckland');
      await fill('shippingPostalCode', '1010');
      await fill('phoneNumber', '021 123 4567').catch(() => {});
      await fill('cardNumber', '4242 4242 4242 4242');
      await fill('cardExpiry', '12 / 34');
      await fill('cardCvc', '123');
      await wait(700);
      await r.click(frame.getByRole('button', { name: /pay/i }).last(), 600);
    },
    /** Waits for the order panel ("Order #XXXXXXXX") and returns its number. */
    async orderNumber() {
      const heading = page.locator('text=/Order #[A-Z0-9]{6,}/').first();
      await heading.waitFor({ timeout: 150000 });
      const match = /#([A-Z0-9]{6,})/.exec(await heading.innerText());
      return match ? match[1] : '';
    },
    /** The commercetools Merchant Center: the orders list, then the order opened. */
    async showMerchantCenterOrder(number) {
      // What the conversation said, kept before the picture leaves the chat.
      r.savedThread = await page.evaluate(() => (document.querySelector('.chat-messages') || document.body).innerText).catch(() => '');
      await page.goto(MC_ORDERS, { waitUntil: 'domcontentloaded' });
      const row = page.getByText(number, { exact: true }).first();
      await row.waitFor({ timeout: 120000 });
      await wait(1500);
      await r.click(row, 1500);
      await page.waitForLoadState('networkidle').catch(() => {});
      await wait(3500);
    },
    async typeAndSend(text) {
      await r.type(input(), text, 34);
      await wait(700);
      await r.click(page.locator('#chat-send-btn'), 600);
    },
    /** Waits until the assistant has finished the answer (up to a few minutes), then shows the end of the thread. */
    async waitAnswer(maxSeconds = 180) {
      await page.waitForSelector('#chat-stop-btn', { timeout: 20000 }).catch(() => {});
      for (let i = 0; i < maxSeconds && (await answering()); i += 1) await wait(1000);
      await wait(1500);
      await toEnd();
    },
    async ask(text) { await this.typeAndSend(text); await this.waitAnswer(); },
    toEnd,
    /** Opens the "Worked for N s" line of the latest answer to show the tools that were used. */
    async showWork() {
      const toggles = page.locator('.ax-worked__toggle');
      const n = await toggles.count();
      if (n === 0) return false;
      const last = toggles.nth(n - 1);
      if ((await last.getAttribute('aria-expanded')) !== 'true') await r.click(last, 900);
      await toEnd();
      return true;
    },
    async openConnectors() {
      const plus = page.locator('.ax-composer button[aria-haspopup="menu"]').first();
      await r.click(plus, 700);
      const row = page.locator('.ax-plusmenu button[role="menuitem"]', { hasText: 'Connectors' }).first();
      if (await row.count()) await r.click(row, 900);
    },
    async closeMenus() { await page.keyboard.press('Escape'); await wait(300); await page.keyboard.press('Escape'); await wait(500); },
    /** Presses a button of the latest card, like "Allow". */
    async pressCard(label) {
      const button = page.locator('button', { hasText: new RegExp(`^${label}$`) }).last();
      await button.waitFor({ timeout: 20000 });
      await r.click(button, 800);
    },
    async hasCard(label) { return (await page.locator('button', { hasText: new RegExp(`^${label}$`) }).count()) > 0; },
  };
}

/* ── the scenarios ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
const SCENARIOS = [
  {
    id: '01-bathroom-end-to-end',
    title: 'A bathroom remodel, from the first question to the order in commercetools',
    persona: 'shopper',
    mcState: true,
    async run(r, c) {
      await c.open();
      await c.signInQuick('shopper');
      await r.step('The question', 'A homeowner, renovating a bathroom.', () => c.typeAndSend('We are renovating our bathroom and need a new vanity, a basin and tapware. Where should we start?'));
      await r.step('Its questions', 'It asks what a good counter person would ask.', async () => { await c.waitAnswer(); await wait(1200); await c.typeAndSend('A small family bathroom, about 1.8 by 2.4 metres. We like a modern white look and want the vanity to be around $800.'); });
      await r.step('The products', 'Real products, real prices and stock, four to a row.', async () => { await c.waitAnswer(); await c.pointAtProducts(); });
      await r.step('The details', 'The details open beside the chat.', async () => {
        await c.press('Details', { within: '[data-card-type="products"]' }); await wait(3500);
        await c.scrollPanelTo('What buyers often mention'); await wait(1500);
        await c.scrollPanelTo('Worth checking before you buy'); await wait(1200);
      });
      await r.step('Why this one', 'She asks why this one.', async () => { await c.press('Why this one?'); await c.waitAnswer(); });
      await r.step('The warranty', 'No warranty on file, so it says so, and offers a person.', async () => { await c.press('Warranty and guarantee'); await c.waitAnswer(); });
      await r.step('Who installs it', 'And whether she needs a plumber or can do it herself.', async () => { await c.press('Who installs it?'); await c.waitAnswer(); });
      await r.step('Only what the job needs', 'Only what the job needs: a basin mixer and a waste.', async () => { await c.closePanel(); await c.addFromTile(); await c.confirmQuantity(); await c.waitAnswer(); });
      await c.addFromGroup('Basin mixer'); await c.confirmQuantity(); await c.waitAnswer();
      await c.addFromGroup('Basin waste'); await c.confirmQuantity(); await c.waitAnswer();
      await r.step('A last look', 'A last look before she pays.', async () => {
        await c.openBag(); await wait(1800);
        await r.click(r.page.locator('button.cv__btn--primary').first(), 800);
        await c.waitAnswer();
      });
      await r.step('Payment', 'Secure payment. This is a test card.', async () => { await c.press(/Take me to payment/, { last: true }); await c.payWithTestCard(); });
      let number = '';
      await r.step('The order', 'Paid. This is her order number.', async () => { number = await c.orderNumber(); await wait(3500); });
      // The order number is kept beside the video: the commercetools screens are made from the owner's own signed-in Merchant Center afterwards.
      fs.writeFileSync(path.join(OUT, '01-bathroom-end-to-end.order.txt'), `${number}\n`);
      if (MC_STATE) {
        await r.step('In commercetools', 'The same order, with the same number, is in commercetools.', () => c.showMerchantCenterOrder(number));
        await r.step('The end', 'From the first question to the order, in one conversation.', async () => { await wait(3500); });
      }
    },
  },
  {
    id: '01-homeowner-bathroom',
    title: 'A homeowner plans a bathroom',
    persona: 'shopper',
    async run(r, c) {
      await c.open();
      await r.step('The sign-in page', 'This is the PlaceMakers assistant. Every person here, customers and colleagues, has their own username and password, so each one sees what their role allows. We start with the simplest: a homeowner planning a new bathroom.', () => c.pointAtSignIn());
      await r.step('She signs in', 'She signs in with her own login. Notice the assistant does not open with a wall of products. It waits to hear what she wants.', () => c.signIn('shopper'));
      await r.step('She says what she is doing', 'She says what she is doing in her own words. That is a project, not a product search, and the assistant treats it that way.', () => c.typeAndSend('We are renovating our bathroom and need a new vanity, a basin and tapware. Where should we start?'));
      await r.step('It asks before it recommends', 'It asks the few things a good person on the counter would ask: the size of the room, the look she wants, and a rough budget. The answers are tappable, so she is never staring at an empty box.', () => c.waitAnswer());
      await r.step('She answers in a sentence', 'She answers in a sentence. She does not have to tap anything.', () => c.typeAndSend('A small family bathroom, about 1.8 by 2.4 metres. We like a modern white look and want the vanity to be around $800.'));
      await r.step('Real products', 'Now real products from the PlaceMakers catalogue, with real prices and stock, in a row she can swipe through. Each one can be opened, compared or added.', async () => { await c.waitAnswer(); await c.pointAtProducts(); });
      await r.step('How the answer was made', 'If she, or the shop owner, wants to see how the answer was made, the line that says worked for a few seconds opens up and lists each step the assistant took.', () => c.showWork());
      await r.step('Add to the cart', 'When she picks one, the assistant adds it to her cart.', () => c.typeAndSend('Add the first vanity to my cart, please.'));
      await r.step('What else the job needs', 'Then it suggests what the job still needs, such as a mixer and the waste fittings, and it does not suggest the same product twice. That is a homeowner\'s journey: a conversation that starts from the project, real products and a sensible cart.', async () => { await c.waitAnswer(); await r.hold(2500); });
    },
  },
  {
    id: '02-trade-customer-account',
    title: 'A trade customer asks about their own account',
    persona: 'trade.admin',
    async run(r, c) {
      await c.open();
      await r.step('A trade customer signs in', 'Now a trade customer. This is the owner of a landscaping business, Harlow and Talbot. She signs in with her own login, and the back office has linked that login to her company by hand. That link is the only way the assistant knows whose account to open.', () => c.signIn('trade.admin'));
      await r.step('She asks about her deliveries', 'She asks where her deliveries are. She never types an account number, and the assistant never asks for one. The company comes from her login, not from anything she says.', () => c.typeAndSend('Where are my deliveries?'));
      await r.step('The assistant checks her account', 'The assistant reads her account in the business system, the ERP, and shows only her company\'s deliveries, with the order, the status and the time window. Open the work line and you can see the account tool it used.', async () => { await c.waitAnswer(); await c.showWork(); });
      await r.step('What does her business owe?', 'As the account administrator she is allowed to see money, so she asks what the business owes and whether anything is overdue.', () => c.typeAndSend('What do we owe at the moment, and are we overdue?'));
      await r.step('Balance, terms and last payment', 'The answer gives the balance, the payment terms and the last payment. It does not show the credit limit, because that is internal. A buyer or a job viewer on the same account would be told this is for the account administrator.', () => c.waitAnswer());
      await r.step('Her own trade price', 'Next she asks for her own price on a product. Her account is on the silver tier, so she gets the silver price next to the standard price, and never sees what the other tiers pay.', () => c.ask('What is our price for product 1357685, and how does it compare with the standard price?'));
      await r.step('Another company is off limits', 'Finally she tries to look at another company\'s orders. The assistant politely says it can only share her own account. There is no company field for her, or for the model, to change, and the server checks again anyway.', () => c.ask('Can you show me the orders for Ormond & Harlow Joinery Ltd, ACC-0026?'));
      await r.step('Safe by design', 'That is the trade customer journey: real account data, the right person sees the right things, and nobody sees another company. The same assistant, with the same login, but the back office decides who belongs to which company.', async () => { await c.toEnd(); await r.hold(2500); });
    },
  },
  {
    id: '03-salesperson-account-brief',
    title: 'A salesperson prepares for a call',
    persona: 'sales',
    async run(r, c) {
      await c.open();
      await r.step('A salesperson signs in', 'Now a member of the sales team, a trade account manager. She signs in with her own login. Her team decides which systems she can use, and which things she must be asked about first.', () => c.signIn('sales'));
      await r.step('Her connected systems', 'Open the plus menu and then connectors, and you see exactly what she is connected to: the shop, Salesforce for accounts, deals and cases, and the business system for prices, stock and deliveries. A colleague in marketing would see a different list.', async () => { await c.openConnectors(); await r.hold(3500); await c.closeMenus(); });
      await r.step('A call this afternoon', 'She has a call this afternoon with a customer, and wants a quick brief: who they are, any open deals or cases, and their recent deliveries.', () => c.typeAndSend('I am calling Harlow & Talbot Landscapes this afternoon. Give me a quick brief: who they are, their open deals and open cases, and their recent deliveries.'));
      await r.step('One question, several systems', 'One question, several systems. The assistant finds the account in Salesforce, reads the open cases, and then looks at the deliveries in the business system. She does not have to open three screens and piece it together.', async () => { await c.waitAnswer(); await c.showWork(); });
      await r.step('A boundary: money is for finance', 'Then she asks something her team is not allowed to see: how much the customer owes. The rules say balances belong to finance, so the assistant tells her it cannot show that and suggests who to ask, instead of guessing.', () => c.ask('And what is their account balance, are they overdue?'));
      await r.step('Stock and prices in one go', 'Next, a product the customer mentioned, a weatherboard. What are the trade prices for each tier, and which branch has the most stock.', () => c.typeAndSend('What are the trade prices by tier for product 1357685, and which branch has the most stock of it?'));
      await r.step('Real-time stock and tier prices', 'The business system answers with stock by branch and the bronze, silver and gold prices, so she can quote the right one for this customer. Anything that would change data, such as raising a case, asks her first.', async () => { await c.waitAnswer(); await c.showWork(); });
      await r.step('Prepared in under two minutes', 'That is the salesperson journey: a prepared call from the connected systems, with the same permissions the team has everywhere else, without leaving the chat.', async () => { await c.toEnd(); await r.hold(2500); });
    },
  },
  {
    id: '04-customer-care-ticket',
    title: 'Customer care: a missed delivery and a new case',
    persona: 'csr',
    async run(r, c) {
      await c.open();
      await r.step('A customer care adviser signs in', 'Now a customer care adviser. A customer rings to say a delivery has not arrived. Her team gives her the shop, Salesforce for cases, and the business system for deliveries.', () => c.signIn('csr'));
      await r.step('Her connectors', 'Here are her connectors. Salesforce is where the cases live, which is the help desk for this business. She can read it freely, and creating a case will ask her first.', async () => { await c.openConnectors(); await r.hold(3500); await c.closeMenus(); });
      await r.step('The customer\'s problem', 'She types what the customer told her: the delivery for one order has not turned up, and she wants to know what is going on and whether they already have a case open.', () => c.typeAndSend('Harlow & Talbot Landscapes say their delivery for order ORD-100024 has not turned up. What is going on with it, and have they got any open cases with us?'));
      await r.step('Delivery and cases together', 'The assistant looks up the delivery in the business system, and the open cases in Salesforce. The answer gives the scheduled day and window, and tells her there is already a case open for damaged goods, so she does not create a duplicate by accident.', async () => { await c.waitAnswer(); await c.showWork(); });
      await r.step('Raise a new case', 'The customer wants this followed up, so she asks the assistant to raise a high priority case for the missed delivery.', () => c.typeAndSend('Please raise a high priority case on their account for the missed delivery. They need the order by Friday.'));
      await r.step('It asks first', 'Raising a case changes data in Salesforce, so the assistant does not do it on its own. It shows a card with exactly what it is about to create: the account, the subject, the priority and the description. She reads it, and decides.', () => c.waitAnswer());
      await r.step('She presses Allow', 'She presses allow. Only now does the assistant create the case, and it says so only after Salesforce confirms.', async () => { if (!flag('no-allow') && await c.hasCard('Allow')) { await c.pressCard('Allow'); await c.waitAnswer(); } });
      await r.step('The ticket is in Salesforce', 'The case now exists in Salesforce with its own number, ready for the team to pick up. The adviser can read the number back to the customer. That is the ticket flow: look up, check for duplicates, ask first, create, confirm.', async () => { await c.toEnd(); await r.hold(3500); });
    },
  },
  {
    id: '05-erp-price-and-stock',
    title: 'Branch counter: real-time price and stock from the ERP',
    persona: 'branch',
    async run(r, c) {
      await c.open();
      await r.step('A branch counter associate signs in', 'Now a branch counter associate. A builder is standing at the counter and wants rusticated weatherboards for a cladding job, and wants to know if they are in stock and what price to give them.', () => c.signIn('branch'));
      await r.step('Her connectors', 'Her team has the shop and the business system, the ERP, for stock and prices, and Salesforce in read only mode for accounts and cases. Nothing here can change an order.', async () => { await c.openConnectors(); await r.hold(3200); await c.closeMenus(); });
      await r.step('Stock across the branches', 'She asks how many of the weatherboard are in stock across the branches, and which branch has the most.', () => c.typeAndSend('How many of product 1357685 are in stock at our branches? Which branch has the most?'));
      await r.step('Live stock by branch', 'The ERP answers with stock by branch: on hand, reserved, and what is actually available. She can tell the builder where to collect, or offer another branch.', async () => { await c.waitAnswer(); await c.showWork(); });
      await r.step('The trade price by tier', 'Then the price. The ERP holds the standard price and the three trade tiers, and she asks for them all so she can quote the right one for this builder\'s account.', () => c.typeAndSend('What are the trade prices for product 1357685 by tier, and the standard price?'));
      await r.step('Prices from the business system', 'The assistant reads the price list from the business system. These are not typed in by hand, they come from the same place the accounts team uses, so the counter and the website agree.', () => c.waitAnswer());
      await r.step('A real order for the counter', 'Now the builder says how many he wants: forty lengths, and he is on the silver tier. She asks which branch near Albany can supply that, and what it would cost.', () => c.typeAndSend('We are at Albany and the customer wants 40 lengths of product 1357685. Which branch nearest to Albany can supply that, and what would 40 lengths cost at the silver tier?'));
      await r.step('The sum comes from the system\'s own figures', 'The assistant looks at the stock and the silver price together. It does the multiplication from the ERP\'s own price, tells her Albany does not have that many, and names the nearby branches that do.', async () => { await c.waitAnswer(); await c.showWork(); });
      await r.step('One answer for the counter', 'In about two minutes she has stock, the nearest alternative and the right price for the whole order, and the builder has not had to wait while she walks to a terminal.', async () => { await c.toEnd(); await r.hold(2500); });
    },
  },
  {
    id: '06-installation-guide',
    title: 'Reading the installation guide',
    persona: 'shopper',
    async run(r, c) {
      await c.open();
      await r.step('A customer with an installation question', 'This one is about the guides. Thousands of products come with a supplier guide, the specification guide or the installation guide, kept as text in the shop\'s database. The assistant can read them. A customer is building a pergola and has bought glulam posts.', () => c.signIn('shopper'));
      await r.step('He asks to be taken through it', 'He asks the question the way a person would, without a product code: how do I install these, can you read the installation guide and take me through it.', () => c.typeAndSend('I am building a pergola and bought the 88 x 88 glulam posts, 2.7m, pre-primed H5. How do I install them? Can you read the installation guide and take me through it?'));
      await r.step('It finds the product and reads its guide', 'The assistant works out which product he means, finds its installation guide in the shop\'s data, and reads it. If two products share the same guide, it reads it once and says so. It never invents a product code.', () => c.waitAnswer());
      await r.step('The steps, in the guide\'s own words', 'The answer follows the guide: the steps in order, the figures exactly as the supplier wrote them, and a link to the full guide. It says whose guide it is, and it does not add steps from general knowledge.', async () => { await r.hold(2500); await c.showWork(); });
      await r.step('The product, ready to buy', 'And because he is buying, the product he is installing is shown with its price and stock, ready to add to the cart.', async () => { await c.toEnd(); await r.hold(3000); });
      await r.step('A follow-up on the guide', 'He can keep asking about the guide. Here he asks how much concrete goes under and around each post, and how soon he must paint them. The assistant goes back into the guide and gives the figures it states: a hundred millimetres of concrete under the post and around it, and painting within fourteen days.', () => c.ask('How much concrete should go under and around each post, and how soon do I need to paint them?'));
      await r.step('Grounded in the supplier', 'That is the guide flow: grounded in the supplier\'s own document, with the link, and honest when the guide does not say.', async () => { await c.toEnd(); await r.hold(2500); });
    },
  },
  {
    id: '07-comparison-guide',
    title: 'Comparing two products, with their guides',
    persona: 'shopper',
    async run(r, c) {
      await c.open();
      await r.step('A customer who cannot decide', 'Now a comparison. A customer cannot decide between two sizes of the same glulam post, and wants to know which suits a pergola corner.', () => c.signIn('shopper'));
      await r.step('He asks for the difference', 'He asks what the difference is between the eighty-eight and the one-twelve post, and which to use for a corner, going by the guides.', () => c.typeAndSend('What is the difference between the 88 x 88 and the 112 x 112 pre-primed H5 glulam posts at 2.7m? Which should I use for a pergola corner post, going by the guides?'));
      await r.step('It looks up both, and reads their guides', 'The assistant looks up both products and reads their guides. When the two products share the same guide, it reads it once and uses it for both.', () => c.waitAnswer());
      await r.step('Side by side', 'The answer puts the two side by side on what differs: size, price and where they are in stock. Then it says what the guide says about choosing between them.', async () => { await r.hold(3000); await c.showWork(); });
      await r.step('Honest about the limits', 'Here the supplier\'s guide says the right size depends on the loads and the wind zone, and points to its own online calculator. So the assistant says exactly that, gives the link, and does not choose for him. It also reminds him to confirm structural questions with a licensed professional.', async () => { await c.toEnd(); await r.hold(3500); });
      await r.step('The prices come from the shop', 'The prices on the cards are real shop prices. Where a product has no price in the catalogue, the demo shows a made-up price, clearly marked as a demo price, instead of the words price on request.', async () => { await r.hold(3000); });
      await r.step('A comparison you can trust', 'That is a comparison you can trust: facts from the catalogue, advice from the guides, and a clear line where the guide hands over to an engineer.', async () => { await c.toEnd(); await r.hold(2500); });
    },
  },
  {
    id: '08-design-inspiration',
    title: 'Inspiration: help me make a room feel better',
    persona: 'shopper',
    async run(r, c) {
      await c.open();
      await r.step('A customer with no product in mind', 'The last scenario is the open-ended one. A customer has no product in mind. She wants her living room to feel warmer and more modern, and does not know where to start.', () => c.signIn('shopper'));
      await r.step('She says what she wants', 'She says it the way she would to a friend.', () => c.typeAndSend('I want to make our living room feel warmer and more modern but I honestly do not know where to start.'));
      await r.step('It asks about the room and the look', 'The assistant is curious before it sells. It asks about the space, the look she is after and what she can spend, using the shop\'s own inspiration and project pages, not generic advice.', () => c.waitAnswer());
      await r.step('She gives a few details', 'She answers: a mid-sized living room, a warm natural feel, timber and soft colours, and a budget of three thousand dollars.', () => c.typeAndSend('A mid-sized living room, about 5 by 4 metres. I like warm natural timber and soft colours, and we have about $3,000.'));
      await r.step('Ideas from the shop\'s own pages', 'Now it gives ideas that fit, such as timber feature walls, flooring or lighting, from the shop\'s own pages, with links to read more. Then it shows the products that go with the idea she likes.', async () => { await c.waitAnswer(); await r.hold(2000); await c.showWork(); });
      await r.step('From idea to a list', 'She can say which idea she likes, and the assistant moves from inspiration to a real shopping list, with quantities worked out for her room, and a picture of how the finished job could look.', () => c.ask('I love the timber feature wall idea. What would I need for a wall that is 4 metres wide and 2.4 metres high?'));
      await r.step('Inspiration that leads somewhere', 'That is the inspiration journey: it starts with the person, uses the shop\'s own ideas, and ends at products and quantities, not at a list of links.', async () => { await c.toEnd(); await r.hold(2500); });
    },
  },
];

/* ── run ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
(async () => {
  const chosen = SCENARIOS.filter((s) => !ONLY.length || ONLY.includes(s.id));
  if (flag('list')) { for (const s of SCENARIOS) console.log(`${s.id}  (${s.persona})  ${s.title}`); return; }
  console.log(`${chosen.length} scenario(s) against ${BASE}, into ${OUT}:`);
  for (const s of chosen) console.log(`  ${s.id}  signed in as ${s.persona}: ${s.title}`);
  if (!flag('yes-run-real-chats')) { console.log('Dry run: nothing was recorded. Add --yes-run-real-chats to record (each scenario is a set of real model runs; scenario 04 raises one real case in Salesforce).'); return; }
  fs.mkdirSync(OUT, { recursive: true });
  for (const s of chosen) {
    const r = await openRecorder(s.id, s.mcState && MC_STATE ? { storageState: MC_STATE } : {});
    try { await s.run(r, chat(r)); } catch (error) { console.error(`  ✗ ${s.id}: ${String(error.message || error).slice(0, 300)}`); }
    // What the conversation said, kept beside the video so it can be checked against the commentary.
    try {
      const thread = r.savedThread || await r.page.evaluate(() => (document.querySelector('.chat-messages') || document.body).innerText);
      fs.writeFileSync(path.join(OUT, `${s.id}.thread.txt`), `${s.title}\nsigned in as ${s.persona}\n\n${thread}\n`);
    } catch { /* the page may be gone */ }
    console.log(`    ${s.title}: ${r.seconds()} s`);
    await r.finish();
  }
})().catch((error) => { console.error(String(error.message || error)); process.exit(1); });
