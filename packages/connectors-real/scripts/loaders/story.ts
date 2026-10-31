/**
 * The PlaceMakers demo story, worked out once and shared by the loaders so that Salesforce and commercetools agree with each other.
 *
 * One product launch, "Spring Outdoor Living 2026" (sheds and outdoor landscaping), runs through everything:
 *   a brief and a parent campaign with five channels, leads and campaign members, opportunities for the trade accounts with the launch
 *   products on them (priced at each account's tier), the sales reps who own the accounts, their calls and meetings, and the service cases'
 *   comments. The deals that were won also exist as commercetools orders with the same products and the same prices.
 *
 * Everything here is a pure, deterministic function of the sample data (no clock, no randomness), so a dry run, a load and a second load
 * all agree, and a test can check that the pieces fit. "Today" in the story is fixed at STORY_TODAY.
 */
import { sampleCollection, slug } from './shared';
import type { Rec } from '../../src/types';

export const STORY_TODAY = '2026-10-25';
export const LAUNCH_NAME = 'Spring Outdoor Living 2026';
export const LAUNCH_DEPARTMENTS = ['Sheds & Buildings', 'Outdoor & Landscaping'];
export const TIERS = ['bronze', 'silver', 'gold'] as const;
export type Tier = (typeof TIERS)[number];

const hash = (text: string): number => { let x = 2166136261; for (const ch of text) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
const pick = <T>(list: readonly T[], seed: string): T => list[hash(seed) % list.length];
const pad = (n: number, width = 4) => String(n).padStart(width, '0');
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const money = (n: number) => Math.round(n * 100) / 100;

// ── People ──────────────────────────────────────────────────────────────────────────────────
export interface Rep { key: string; firstName: string; lastName: string; name: string; role: 'sales' | 'marketing'; username: string; email: string; alias: string; nickname: string }
const person = (first: string, last: string, role: Rep['role']): Rep => {
  const id = `${first}.${last}`.toLowerCase();
  return { key: id, firstName: first, lastName: last, name: `${first} ${last}`, role, username: `${id}@placemakers-demo.example.test`, email: `${id}@example.test`, alias: `${first[0]}${last}`.toLowerCase().slice(0, 8), nickname: `${id}.pm` };
};
/** Eight sales reps and one marketer: this org has ten user seats and one is the owner's, so the thirty accounts share the reps. */
export const REPS: Rep[] = [
  ...[['Hemi', 'Ashworth'], ['Aroha', 'Bellamy'], ['Ella', 'Tomlinson'], ['Finn', 'Paterson'], ['Jess', 'Penrose'], ['Nina', 'Brennan'], ['Sione', 'Paterson'], ['Wendy', 'Hartley']].map(([f, l]) => person(f, l, 'sales')),
  person('Yvette', 'Ellery', 'marketing'),
];
export const SALES_REPS = REPS.filter((rep) => rep.role === 'sales');
export const MARKETERS = REPS.filter((rep) => rep.role === 'marketing');

/** The sales rep who looks after an account. The sample data gives each account its own manager name; here the eight reps share them out. */
export function repFor(account: Rec, index: number): Rep {
  return SALES_REPS.find((rep) => rep.name === account.accountManager) ?? SALES_REPS[index % SALES_REPS.length];
}

// ── The launch ──────────────────────────────────────────────────────────────────────────────
export interface CampaignPlan { key: string; parent?: string; name: string; type: string; status: string; start: string; end: string; budget: number; actual: number; expectedRevenue: number; expectedResponse: number; leadSource: string; owner: Rep; description: string }
export interface LeadPlan { key: string; firstName: string; lastName: string; company: string; title: string; email: string; phone: string; city: string; status: string; rating: string; leadSource: string; campaign: string; owner: Rep; description: string }
export interface MemberPlan { campaign: string; lead?: string; accountId?: string; status: 'Sent' | 'Responded' }
export interface LinePlan { sku: string; name: string; quantity: number; unitPrice: number }
export interface OpportunityPlan { key: string; orderNumber: string; accountId: string; accountName: string; tier: Tier; name: string; stage: string; closeDate: string; owner: Rep; campaign: string; leadSource: string; nextStep: string; description: string; lines: LinePlan[]; amount: number }
export interface TaskPlan { key: string; opportunity?: string; lead?: string; subject: string; status: 'Completed' | 'Not Started'; priority: 'High' | 'Normal'; date: string; owner: Rep; description: string }
export interface EventPlan { key: string; opportunity: string; subject: string; start: string; minutes: number; location: string; owner: Rep; description: string }
export interface CommentPlan { caseSubject: string; accountId: string; body: string }

const FIRST = ['Aroha', 'Wiremu', 'Mereana', 'Tane', 'Hana', 'Ngaio', 'Rawiri', 'Kiri', 'Jack', 'Priya', 'Sione', 'Mele', 'Liam', 'Emma', 'Hemi', 'Anika', 'Zane', 'Tui', 'Ravi', 'Leilani'];
const LAST = ['Walker', 'Singh', 'Parata', 'Henare', 'Fraser', 'Ngata', 'Cooper', 'Tamati', 'Wilson', 'Kumar', 'Brown', 'Taylor', 'Reid', 'Moana', 'Hughes', 'Patel'];
const PREFIX = ['Kauri', 'Tui', 'Rimu', 'Harbour', 'Summit', 'Ridgeline', 'Pohutukawa', 'Coastal', 'Southern', 'Riverbend', 'Kiwi', 'Longbeach', 'Ironbark', 'Totara', 'Wairua', 'Pacific'];
const SUFFIX = ['Builders Ltd', 'Landscapes Ltd', 'Joinery Ltd', 'Fencing Ltd', 'Construction Ltd', 'Decks and Outdoors Ltd', 'Roofing Ltd', 'Homes Ltd'];
const TITLES = ['Director', 'Site manager', 'Owner', 'Purchasing officer', 'Project manager'];
const LEAD_STATUS = ['New', 'Contacted', 'Nurturing', 'Qualified', 'Unqualified'] as const;
const LEAD_STATUS_PATTERN = ['New', 'Contacted', 'Contacted', 'Nurturing', 'Qualified', 'New', 'Contacted', 'Nurturing', 'Unqualified', 'Qualified'];
const STAGE_PATTERN = ['Closed Won', 'Propose', 'Qualify', 'Negotiate', 'Meet & Present', 'Propose', 'Closed Won', 'Qualify', 'Meet & Present', 'Negotiate', 'Propose', 'Closed Lost', 'Meet & Present', 'Closed Won', 'Propose', 'Qualify', 'Negotiate', 'Closed Won', 'Propose', 'Meet & Present', 'Qualify', 'Closed Won', 'Negotiate', 'Propose', 'Closed Lost', 'Meet & Present', 'Qualify', 'Closed Won', 'Negotiate', 'Propose'];

export function plan(options: { products?: number; accounts?: number; leads?: number } = {}) {
  const products = sampleCollection('sap-commerce', 'products').slice(0, options.products ?? 100);
  const priceList = new Map(sampleCollection('ace-erp', 'price_list').map((row) => [String(row.sku), row]));
  const branches = sampleCollection('ace-erp', 'branches');
  const accounts = sampleCollection('salesforce', 'accounts').slice(0, options.accounts ?? 30);
  const cases = sampleCollection('salesforce', 'cases');
  const launchProducts = LAUNCH_DEPARTMENTS.flatMap((department) => products.filter((product) => product.department === department).slice(0, 6));
  const tierPrice = (sku: string, tier: Tier, fallback: number) => money(Number(priceList.get(sku)?.[`${tier}Price`] ?? fallback));
  const cityOf = (code: unknown) => String(branches.find((branch) => String(branch.code) === String(code))?.name ?? 'Hamilton');

  const [marketing] = MARKETERS;
  const coordinator = marketing; // one marketer in this org
  const campaigns: CampaignPlan[] = [
    { key: 'launch', name: LAUNCH_NAME, type: 'Other', status: 'In Progress', start: '2026-09-14', end: '2026-12-13', budget: 38500, actual: 19850, expectedRevenue: 150000, expectedResponse: 6, leadSource: 'Other', owner: marketing, description: `The spring launch of ${launchProducts.length} outdoor products: garden sheds and the outdoor and landscaping range, at trade prices for Bronze, Silver and Gold accounts. See the launch brief.` },
    { key: 'email', parent: 'launch', name: 'Launch email to trade accounts', type: 'Email', status: 'Completed', start: '2026-09-14', end: '2026-09-28', budget: 3500, actual: 3200, expectedRevenue: 30000, expectedResponse: 12, leadSource: 'Web', owner: coordinator, description: 'One email to every trade contact and to prospects on the list, with the trade price for their tier.' },
    { key: 'night', parent: 'launch', name: 'Trade night: sheds and decking, Hamilton', type: 'Seminar / Conference', status: 'Completed', start: '2026-10-08', end: '2026-10-08', budget: 6000, actual: 5750, expectedRevenue: 25000, expectedResponse: 25, leadSource: 'Seminar - Internal', owner: marketing, description: 'An evening at the Hamilton branch: the new shed range on the floor, supplier talks and trade price offers.' },
    { key: 'tele', parent: 'launch', name: 'Telesales to Gold and Silver accounts', type: 'Telemarketing', status: 'In Progress', start: '2026-10-05', end: '2026-11-15', budget: 9000, actual: 4400, expectedRevenue: 45000, expectedResponse: 30, leadSource: 'Other', owner: coordinator, description: 'The sales reps call their Gold and Silver accounts to walk through the launch range and book a quote.' },
    { key: 'banner', parent: 'launch', name: 'Outdoor Living web banners', type: 'Banner Ads', status: 'In Progress', start: '2026-10-01', end: '2026-11-30', budget: 12000, actual: 6500, expectedRevenue: 30000, expectedResponse: 3, leadSource: 'Advertisement', owner: marketing, description: 'Banners on the trade site and partner sites sending builders to the Outdoor Living landing page.' },
    { key: 'referral', parent: 'launch', name: 'Builder referral reward', type: 'Referral Program', status: 'Planned', start: '2026-11-09', end: '2026-12-13', budget: 8000, actual: 0, expectedRevenue: 20000, expectedResponse: 8, leadSource: 'Word of mouth', owner: coordinator, description: 'A reward for trade customers who bring a new builder to the launch range. Not started yet.' },
  ];

  // The whole name of each product if the list fits the brief's 1,024-character field, with the sku after it only while it still fits.
  const withSkus = launchProducts.map((product) => `${product.title} (${product.sku})`).join('; ');
  const launchList = withSkus.length <= 800 ? withSkus : launchProducts.map((product) => String(product.title)).join('; ');
  const brief = {
    name: `${LAUNCH_NAME}: launch brief`,
    keyMessage: 'Everything for the deck, the shed and the garden, at your trade price.',
    targetAudience: 'Builders, landscapers, fencers and joiners on a PlaceMakers trade account (Bronze, Silver and Gold), North Island first, then the rest of the country.',
    description: `We are launching ${launchProducts.length} outdoor products this spring across ${LAUNCH_DEPARTMENTS.join(' and ')}, each with its own price for the Bronze, Silver and Gold trade tiers. The launch runs from 14 September to 13 December 2026 across email, a trade night, telesales to Gold and Silver accounts, web banners and a builder referral reward. Success is trade account responses, qualified leads and orders for the launch range.`,
    additionalNotes: `Launch range: ${launchList}. Web traffic to the Outdoor Living pages is reported from Google Analytics in the weekly report.`,
  };

  // Leads: new businesses that came in through the launch campaigns.
  const leadCount = options.leads ?? 40;
  const leadChannels = [...Array(14).fill('banner'), ...Array(10).fill('night'), ...Array(8).fill('email'), ...Array(8).fill('tele')] as string[];
  const leads: LeadPlan[] = [];
  for (let i = 0; i < leadCount; i++) {
    const company = `${PREFIX[i % PREFIX.length]} ${SUFFIX[(i * 3 + Math.floor(i / PREFIX.length)) % SUFFIX.length]}`;
    const first = FIRST[(i * 7) % FIRST.length];
    const last = LAST[(i * 5 + 3) % LAST.length];
    const channel = leadChannels[i % leadChannels.length];
    const campaign = campaigns.find((c) => c.key === channel)!;
    const status = LEAD_STATUS_PATTERN[i % LEAD_STATUS_PATTERN.length];
    const interest = pick(launchProducts, `lead-${i}`);
    leads.push({
      key: `lead-${pad(i + 1)}`, firstName: first, lastName: last, company, title: pick(TITLES, `title-${i}`),
      email: `${first}.${last}.${pad(i + 1)}@example.test`.toLowerCase(), phone: `021 555 ${pad(1000 + ((i * 137) % 8999))}`,
      city: cityOf(pick(branches, `lead-branch-${i}`).code), status, rating: status === 'Qualified' ? 'Hot' : status === 'Unqualified' ? 'Cold' : pick(['Hot', 'Warm', 'Cold'], `rating-${i}`),
      leadSource: campaign.leadSource, campaign: campaign.key, owner: SALES_REPS[i % SALES_REPS.length],
      description: `Came in through "${campaign.name}". Interested in the ${interest.title} (${interest.sku}).`,
    });
  }

  // Opportunities: the launch products for the trade accounts, at each account's tier price.
  const opportunities: OpportunityPlan[] = [];
  const accountsWithDeals = accounts.slice(0, 24);
  let n = 0;
  accountsWithDeals.forEach((account, index) => {
    const tier = String(account.tier) as Tier;
    const rep = repFor(account, index);
    const count = index % 4 === 0 ? 2 : 1;
    for (let d = 0; d < count; d++) {
      const stage = STAGE_PATTERN[n % STAGE_PATTERN.length];
      n++;
      const wanted = 1 + (hash(`lines-${account.accountId}-${d}`) % 3);
      const chosen: Rec[] = [];
      for (let k = 0; chosen.length < wanted && k < 12; k++) {
        const candidate = pick(launchProducts, `opp-${account.accountId}-${d}-${k}`);
        if (!chosen.includes(candidate)) chosen.push(candidate);
      }
      const lines: LinePlan[] = chosen.map((product, k) => {
        const price = Number(product.price);
        const seed = hash(`qty-${account.accountId}-${d}-${k}`);
        const quantity = String(product.unitOfMeasure) === 'EA' ? (price > 500 ? 1 + (seed % 3) : 2 + (seed % 9)) : 10 + (seed % 40);
        return { sku: String(product.sku), name: String(product.title), quantity, unitPrice: tierPrice(String(product.sku), tier, price) };
      });
      const won = stage === 'Closed Won';
      const lost = stage === 'Closed Lost';
      const closeDate = won ? addDays(STORY_TODAY, -(3 + (hash(`won-${n}`) % 14))) : lost ? addDays(STORY_TODAY, -(5 + (hash(`lost-${n}`) % 10))) : addDays(STORY_TODAY, 7 + (hash(`close-${n}`) % 50));
      const channel = (['email', 'night', 'tele'] as const)[hash(`campaign-${account.accountId}`) % 3];
      const campaign = campaigns.find((c) => c.key === channel)!;
      const short = String(account.name).replace(/ (Ltd|Limited)$/i, '');
      opportunities.push({
        key: `opp-${pad(n)}`, orderNumber: `OPP-${pad(n)}`, accountId: String(account.accountId), accountName: String(account.name), tier,
        name: `${short}: ${lines[0].name.split(' ').slice(0, 4).join(' ')}${lines.length > 1 ? ` and ${lines.length - 1} more` : ''}`.slice(0, 120),
        stage, closeDate, owner: rep, campaign: campaign.key, leadSource: campaign.leadSource,
        nextStep: won ? 'Delivered, check in after a month' : lost ? 'Lost on price; ask again in the new year' : pick(['Send the quote', 'Book a site visit', 'Call to talk through delivery', 'Confirm quantities', 'Get the order signed off'], `next-${n}`),
        description: `Launch products for ${account.name} (${tier} tier). Influenced by the campaign "${campaign.name}"${won ? `. Placed in commercetools as order OPP-${pad(n)}.` : '.'}`,
        lines, amount: money(lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)),
      });
    }
  });

  // Campaign members: the trade contacts and the leads, and whether they answered.
  const members: MemberPlan[] = [];
  const dealAccounts = new Set(opportunities.map((opportunity) => opportunity.accountId));
  accounts.forEach((account, index) => {
    const id = String(account.accountId);
    members.push({ campaign: 'email', accountId: id, status: dealAccounts.has(id) && index % 5 !== 4 ? 'Responded' : 'Sent' });
    if (index % 5 < 2 && index < 20) members.push({ campaign: 'night', accountId: id, status: 'Responded' });
    if (account.tier !== 'bronze') members.push({ campaign: 'tele', accountId: id, status: index % 3 === 0 ? 'Responded' : 'Sent' });
  });
  for (const lead of leads) members.push({ campaign: lead.campaign, lead: lead.key, status: ['Contacted', 'Nurturing', 'Qualified'].includes(lead.status) ? 'Responded' : 'Sent' });

  // Calls and meetings.
  const tasks: TaskPlan[] = [];
  const events: EventPlan[] = [];
  for (const opportunity of opportunities) {
    const open = !opportunity.stage.startsWith('Closed');
    const calls: Array<[string, number]> = open ? [['Call to introduce the launch range', -9 - (hash(opportunity.key) % 8)], [opportunity.nextStep, 2 + (hash(`t-${opportunity.key}`) % 9)]] : [['Thank you call', -2]];
    calls.forEach(([subject, offset], k) => {
      const date = addDays(STORY_TODAY, offset);
      tasks.push({ key: `${opportunity.key}-t${k + 1}`, opportunity: opportunity.key, subject, status: offset < 0 ? 'Completed' : 'Not Started', priority: opportunity.stage === 'Negotiate' ? 'High' : 'Normal', date, owner: opportunity.owner, description: `${subject} with ${opportunity.accountName}.` });
    });
    if (['Meet & Present', 'Propose', 'Negotiate'].includes(opportunity.stage)) {
      const past = opportunity.stage === 'Meet & Present' ? hash(opportunity.key) % 2 === 0 : false;
      events.push({
        key: `${opportunity.key}-e1`, opportunity: opportunity.key, subject: `Site visit: ${opportunity.accountName}`,
        start: `${addDays(STORY_TODAY, past ? -4 : 3 + (hash(`e-${opportunity.key}`) % 12))}T${pick(['09:00', '10:30', '13:00', '14:30'], opportunity.key)}:00.000Z`, minutes: 60,
        location: cityOf(accounts.find((a) => String(a.accountId) === opportunity.accountId)?.homeBranchCode), owner: opportunity.owner, description: 'Walk the site, check quantities and talk through delivery of the launch products.',
      });
    }
  }
  for (const lead of leads.filter((l) => ['New', 'Contacted', 'Qualified'].includes(l.status))) {
    tasks.push({ key: `${lead.key}-t1`, lead: lead.key, subject: lead.status === 'New' ? 'First call to a new lead' : 'Follow up on the launch range', status: lead.status === 'New' ? 'Not Started' : 'Completed', priority: lead.rating === 'Hot' ? 'High' : 'Normal', date: addDays(STORY_TODAY, lead.status === 'New' ? 1 + (hash(lead.key) % 5) : -(1 + (hash(lead.key) % 7))), owner: lead.owner, description: lead.description });
  }

  // Service: a comment or two on the cases that are being worked or are done.
  const comments: CommentPlan[] = [];
  for (const entry of cases) {
    if (!accounts.some((account) => account.accountId === entry.accountId)) continue;
    const status = String(entry.status);
    if (status === 'new') continue;
    const said = status === 'closed'
      ? ['Called the customer and confirmed the fix. Closing the case.', 'Replacement delivered and signed for. Closed.']
      : status === 'waiting' ? ['Waiting on the supplier; the customer has been told to expect a call by Friday.'] : ['Spoke to the customer and the branch; we are sorting it this week.', 'Branch has checked the stock and booked the delivery.'];
    said.forEach((body, k) => comments.push({ caseSubject: String(entry.subject), accountId: String(entry.accountId), body: k === 0 ? body : `${body}` }));
  }

  return { products, launchProducts, priceList, branches, accounts, cases, campaigns, brief, leads, opportunities, members, tasks, events, comments, reps: REPS, cityOf, slug };
}
