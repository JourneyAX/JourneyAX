#!/usr/bin/env node
/**
 * Records the narrated scenario videos: a real person's journey through the chat, signed in as one of the demo personas, with the real
 * assistant, the real catalogue and the connected systems answering. Each video is about two minutes, in 4K (3840 x 2160), with a spoken
 * commentary (the Mac's own voice) and the speaker notes written beside it as <name>.notes.md.
 *
 *   node scripts/demo/record-scenarios.cjs --list
 *   node scripts/demo/record-scenarios.cjs --out <folder> --base http://localhost:3108 [--only 04-customer-care-ticket,06-installation-guide] --yes-run-real-chats [--no-allow]
 *        --no-allow: for a rehearsal, do not press "Allow" on the ask-first card (so no case is raised)
 *
 * Every scenario is a real model run (several questions each), and the customer-care scenario raises one real case in the connected Salesforce
 * (the person in the video presses "Allow" on the ask-first card, exactly as a colleague would). Without --yes-run-real-chats nothing is
 * recorded: the script only prints the plan. No password is typed or shown: the sign-in screen's own persona buttons are used.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createKit, wait } = require('./recorder-core.cjs');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'scenario-videos')));
const BASE = opt('base', 'http://localhost:3108').replace(/\/$/, '');
const PROJECT = opt('project', 'placemakers');
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const { openRecorder } = createKit({ out: OUT, keepFrames: flag('keep-frames'), voice: opt('voice', 'Karen'), rate: Number(opt('rate', '168')), captionAt: 'top' });

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
    /** The sign-in screen's own button for a persona: no password is typed. */
    async signIn(persona) {
      const button = page.locator(`[data-persona="${persona}"]`);
      await button.waitFor({ timeout: 30000 });
      await wait(2200);
      await r.point(button);
      await wait(1200);
      await r.click(button, 600);
      await page.waitForSelector('#chat-input-field', { timeout: 60000 });
      await wait(1200);
    },
    async pointAtPersonas() { await r.point(page.locator('[data-persona]').nth(1)); await r.scroll(260, 1200); await wait(600); await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await wait(700); },
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
    id: '01-homeowner-bathroom',
    title: 'A homeowner plans a bathroom',
    persona: 'shopper',
    async run(r, c) {
      await c.open();
      await r.step('The sign-in screen: twelve demo people', 'This is the PlaceMakers assistant. On the sign-in screen there are twelve demo people, customers and colleagues, so you can see what each of them gets. We start with the simplest: a homeowner, planning a new bathroom.', () => c.pointAtPersonas());
      await r.step('Signed in as the homeowner', 'She signs in with one click. Notice the assistant does not start with a wall of products. It waits to hear what she wants, and the suggestions under the box are things a homeowner would ask.', () => c.signIn('shopper'));
      await r.step('She says what she is doing', 'She says what she is doing in her own words: a bathroom renovation, and she does not know where to start. This is the most common kind of question, and the assistant treats it as a project, not a product search.', () => c.typeAndSend('We are renovating our bathroom and need a new vanity, a basin and tapware. Where should we start?'));
      await r.step('The assistant asks before it recommends', 'It asks the few questions a good person on the counter would ask: how big the room is, the look she wants, and a rough budget. The answers become tappable choices, so she is never staring at an empty box.', () => c.waitAnswer());
      await r.step('She answers in a sentence', 'She does not have to tap anything. She can just answer in a sentence: a small family bathroom, a modern white look, and a vanity around eight hundred dollars.', () => c.typeAndSend('A small family bathroom, about 1.8 by 2.4 metres. We like a modern white look and want the vanity to be around $800.'));
      await r.step('Real products from the catalogue', 'Now it shows real products from the PlaceMakers catalogue, with real prices and stock. They sit in a row she can swipe through, and each one can be added, opened, or compared. Nothing here is invented: every product, price and stock figure comes from the shop\'s own data.', () => c.waitAnswer());
      await r.step('Open the work behind the answer', 'If she, or the shop owner, wants to see how the answer was made, the line that says worked for a few seconds opens up and shows each step the assistant took, from reading its playbook to looking up products.', () => c.showWork());
      await r.step('Add to the cart, with a quantity', 'When she picks one, the assistant adds it to the cart, and asks about the quantity before it does. After that it suggests what else the job needs, such as the tapware and fittings, and does not suggest the same product twice.', () => c.ask('Add the first vanity to my cart, please.'));
      await r.step('What happens next', 'That is the whole journey for a homeowner: a conversation that starts from the project, real products, a sensible cart, and the shop\'s own words throughout. Next, the same assistant for a trade customer with an account.', async () => { await c.toEnd(); await r.hold(2500); });
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
      await r.step('A boundary: money is for finance', 'Then she asks something her team is not allowed to see: how much the customer owes. The rules say balances belong to finance, so the assistant tells her so and points her to that team, instead of guessing.', () => c.ask('And what is their account balance, are they overdue?'));
      await r.step('Stock and prices in one go', 'Next, a product the customer mentioned, a weatherboard. How many are in stock across the branches, and what are the trade prices for each tier.', () => c.typeAndSend('How many of product 1357685 are in stock across our branches, and what are the trade prices by tier?'));
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
      await r.step('One answer for the counter', 'In under a minute she has stock, the nearest alternative and the right price, and the builder has not had to wait while she walks to a terminal.', async () => { await c.toEnd(); await r.hold(2500); });
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
      await r.step('A follow-up on the guide', 'He can keep asking about the guide. Here he asks how deep the footing needs to be, and the assistant goes back into the guide for that figure rather than guessing.', () => c.ask('How deep should the concrete footing be, and how long before I can fix the beams?'));
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
    const r = await openRecorder(s.id);
    try { await s.run(r, chat(r)); } catch (error) { console.error(`  ✗ ${s.id}: ${String(error.message || error).slice(0, 300)}`); }
    // What the conversation said, kept beside the video so it can be checked against the commentary.
    try {
      const thread = await r.page.evaluate(() => (document.querySelector('.chat-messages') || document.body).innerText);
      fs.writeFileSync(path.join(OUT, `${s.id}.thread.txt`), `${s.title}\nsigned in as ${s.persona}\n\n${thread}\n`);
    } catch { /* the page may be gone */ }
    console.log(`    ${s.title}: ${r.seconds()} s`);
    await r.finish();
  }
})().catch((error) => { console.error(String(error.message || error)); process.exit(1); });
