/**
 * The sample support tickets, worked out from what the other systems already hold (see story.ts), so a ticket can be followed into them:
 *   delivery and invoice questions about the orders for the deals that were won, tagged with the account and the order number,
 *   tickets for the service cases that are being worked or are done, tagged with the account,
 *   quote requests from the leads that came in through the launch,
 *   and everyday questions from shoppers.
 * Like the story it is a pure, deterministic function of the sample data, with "today" fixed at STORY_TODAY.
 */
import { plan as story, STORY_TODAY } from './story';

export type TicketStatus = 'new' | 'open' | 'pending' | 'solved';
export interface Person { name: string; email: string }
export interface Message { from: 'customer' | 'agent'; public: boolean; body: string; hoursAfter: number }
export interface TicketPlan {
  externalId: string; requester: Person; subject: string; description: string; priority: 'low' | 'normal' | 'high' | 'urgent'; type: 'question' | 'incident' | 'problem' | 'task';
  tags: string[]; status: TicketStatus; createdDaysAgo: number; thread: Message[];
}

const hash = (text: string): number => { let x = 2166136261; for (const ch of text) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
const pad = (n: number) => String(n).padStart(4, '0');
const PRIORITY: Record<string, TicketPlan['priority']> = { low: 'low', normal: 'normal', high: 'high' };
const STATUS: Record<string, TicketStatus> = { new: 'new', open: 'open', waiting: 'pending', closed: 'solved' };

/** What the team says on the way to each status. */
function thread(status: TicketStatus, resolution: string, ask: string): Message[] {
  if (status === 'new') return [];
  const received: Message = { from: 'agent', public: true, hoursAfter: 2, body: 'Thanks for getting in touch. We are looking into this with the branch and will update you today.' };
  if (status === 'open') return [received, { from: 'agent', public: false, hoursAfter: 3, body: 'Checked with the branch. Waiting on dispatch to confirm.' }];
  if (status === 'pending') return [received, { from: 'agent', public: true, hoursAfter: 20, body: ask }];
  return [received, { from: 'agent', public: true, hoursAfter: 26, body: resolution }, { from: 'customer', public: true, hoursAfter: 30, body: 'Thanks, that has sorted it.' }, { from: 'agent', public: false, hoursAfter: 31, body: 'Resolved. Customer confirmed by reply.' }];
}

const EVERYDAY: Array<{ subject: string; description: string; type: TicketPlan['type']; tag: string; resolution: string; ask: string }> = [
  { subject: 'Opening hours over the long weekend', description: 'Hi, are the branches open on the Monday of the long weekend? I need to collect timber early.', type: 'question', tag: 'opening-hours', resolution: 'Most branches are open 7am to 1pm on the Monday. Your branch page shows its own hours.', ask: 'Which branch will you be collecting from? Then we can give you its exact hours.' },
  { subject: 'Click and collect: how long is an order held?', description: 'I ordered online for click and collect. How many days will you hold it for?', type: 'question', tag: 'click-and-collect', resolution: 'We hold click and collect orders for 7 days. We can extend that if you let the branch know.', ask: 'Can you give us your order number so we can check how long yours will be held?' },
  { subject: 'Returning cut-to-length framing', description: 'Can I return framing timber that was cut to length for me?', type: 'question', tag: 'returns', resolution: 'Cut-to-length timber cannot be returned unless it is faulty, but the branch can often use offcuts on your next order.', ask: 'Was the timber faulty, or has your plan changed? That decides what we can offer.' },
  { subject: 'Which shed suits a sloping section?', description: 'I have a sloping section. Which of the garden sheds can go on a slope, and what base do they need?', type: 'question', tag: 'product-advice', resolution: 'The Garrison range can sit on a levelled timber or concrete pad. The branch can quote the base for you.', ask: 'How steep is the slope, roughly? That tells us whether you need a retaining base.' },
  { subject: 'Delivery to a rural address', description: 'Do you deliver to a rural address about 25 km from the branch, and is there an extra charge?', type: 'question', tag: 'delivery', resolution: 'We deliver rural addresses. The charge depends on the distance and the load; the branch will confirm it when you order.', ask: 'What is the address, and what are you ordering? We will work out the delivery charge.' },
  { subject: 'Applying for a trade account', description: 'I run a small building business and would like to apply for a trade account. What do you need from me?', type: 'task', tag: 'trade-account', resolution: 'We have sent the application form. It needs your business details and two trade references.', ask: 'Please send the business name and the NZBN so we can start the application.' },
  { subject: 'Cannot sign in to my account', description: 'I cannot sign in to the website, it says my password is wrong but I just changed it.', type: 'incident', tag: 'website', resolution: 'We reset the sign-in and sent a fresh link. It works for 24 hours.', ask: 'Which e-mail address did you register with? We will send a reset link.' },
  { subject: 'Price match request', description: 'I found the same cordless drill cheaper elsewhere. Can you match the price?', type: 'question', tag: 'price-match', resolution: 'We can match a local competitor on an identical product. The branch will need to see the quote.', ask: 'Can you send us the competitor quote or a link to the product?' },
  { subject: 'Missing screws in a fastener pack', description: 'The box of decking screws I bought has fewer in it than the label says.', type: 'incident', tag: 'product-fault', resolution: 'Sorry about that. The branch has put a replacement box aside for you with no charge.', ask: 'Which branch did you buy it from, and do you still have the receipt?' },
  { subject: 'Gift card balance', description: 'How can I check how much is left on my gift card?', type: 'question', tag: 'gift-card', resolution: 'Any branch can check it from the card number, or you can call the contact centre.', ask: 'Please send the last four digits of the card number and we will look it up.' },
];
const SHOPPERS = [['Mark', 'Edwards'], ['Sarah', 'Whitaker'], ['Jon', 'Pearce'], ['Lena', 'Okafor'], ['Dylan', 'Munro'], ['Grace', 'Tan'], ['Peter', 'Scott'], ['Ana', 'Faleolo'], ['Nikau', 'Rangi'], ['Beth', 'Calder']];

export function plan(): TicketPlan[] {
  const s = story();
  const tickets: TicketPlan[] = [];
  const contactOf = (accountId: string): Person => {
    const account = s.accounts.find((entry) => String(entry.accountId) === accountId)!;
    return { name: String(account.contactName ?? account.name), email: String(account.contactEmail) };
  };
  const tagsFor = (accountId: string) => ['placemakers', accountId.toLowerCase()];

  // 1. Where is my order: the deals that were won.
  s.opportunities.filter((deal) => deal.stage === 'Closed Won').forEach((deal, i) => {
    const status: TicketStatus = (['solved', 'open', 'pending', 'solved', 'new', 'solved'] as const)[i % 6];
    const first = deal.lines[0];
    const invoice = i % 2 === 1;
    tickets.push({
      externalId: `PM-TKT-${pad(tickets.length + 1)}`, requester: contactOf(deal.accountId),
      subject: invoice ? `Invoice query for order ${deal.orderNumber}` : `Where is order ${deal.orderNumber}?`,
      description: invoice ? `The invoice for order ${deal.orderNumber} (${deal.accountName}) does not match my quote for ${first.name}. Can you check the prices?` : `We ordered ${first.quantity} x ${first.name} (order ${deal.orderNumber}) and it has not arrived yet. Can you tell me when to expect it?`,
      priority: i % 3 === 0 ? 'high' : 'normal', type: 'question', tags: [...tagsFor(deal.accountId), 'delivery', deal.orderNumber.toLowerCase()], status, createdDaysAgo: 2 + (hash(deal.key) % 8),
      thread: thread(status, invoice ? `We checked the invoice against your ${deal.tier} trade prices and it is correct. We have re-sent it.` : 'Your order left the branch this morning and the driver will call you before delivery.', invoice ? 'Can you send us the quote you are comparing it with?' : 'Which site is it going to, and is someone there to receive it?'),
    });
  });

  // 2. The service cases that are being worked or are done.
  const wanted = s.cases.filter((entry) => s.accounts.some((account) => account.accountId === entry.accountId)).slice(0, 12);
  wanted.forEach((entry, i) => {
    const status = STATUS[String(entry.status)] ?? 'open';
    const fault = /damag|crack|faulty|wrong|missing|leak|warranty/i.test(String(entry.subject));
    tickets.push({
      externalId: `PM-TKT-${pad(tickets.length + 1)}`, requester: contactOf(String(entry.accountId)), subject: String(entry.subject), description: String(entry.description ?? entry.subject),
      priority: PRIORITY[String(entry.priority)] ?? 'normal', type: fault ? 'incident' : 'question', tags: [...tagsFor(String(entry.accountId)), 'service-case'], status, createdDaysAgo: 1 + (hash(`case-${i}`) % 14),
      thread: thread(status, 'We have arranged a replacement and the branch will confirm the delivery day.', 'Could you send a photo of the problem so we can pass it to the supplier?'),
    });
  });

  // 3. Quote requests from the leads that came in through the launch.
  s.leads.filter((lead) => ['New', 'Contacted', 'Qualified'].includes(lead.status)).slice(0, 8).forEach((lead, i) => {
    const product = s.launchProducts[hash(lead.key) % s.launchProducts.length];
    const status: TicketStatus = lead.status === 'New' ? 'new' : lead.status === 'Contacted' ? 'open' : 'pending';
    tickets.push({
      externalId: `PM-TKT-${pad(tickets.length + 1)}`, requester: { name: `${lead.firstName} ${lead.lastName}`, email: lead.email }, subject: `Trade quote: ${String(product.title).slice(0, 70)}`,
      description: `We are ${lead.company} in ${lead.city}. We saw the Outdoor Living launch and would like a trade quote for the ${product.title} (${product.sku}), about ${2 + (i % 4)} of them.`,
      priority: lead.rating === 'Hot' ? 'high' : 'normal', type: 'question', tags: ['placemakers', 'launch', 'quote', lead.key], status, createdDaysAgo: 1 + (hash(`quote-${i}`) % 9),
      thread: thread(status, 'We have sent your quote with the trade price.', 'To price it properly, are you on a PlaceMakers trade account already?'),
    });
  });

  // 4. Everyday questions from shoppers.
  EVERYDAY.forEach((item, i) => {
    const [first, last] = SHOPPERS[i % SHOPPERS.length];
    const status: TicketStatus = (['solved', 'solved', 'open', 'pending', 'new', 'solved', 'open', 'solved', 'pending', 'solved'] as const)[i % 10];
    tickets.push({
      externalId: `PM-TKT-${pad(tickets.length + 1)}`, requester: { name: `${first} ${last}`, email: `${first}.${last}@example.test`.toLowerCase() }, subject: item.subject, description: item.description,
      priority: i === 6 || i === 8 ? 'high' : 'normal', type: item.type, tags: ['placemakers', 'web-enquiry', item.tag], status, createdDaysAgo: 1 + (hash(`everyday-${i}`) % 20),
      thread: thread(status, item.resolution, item.ask),
    });
  });
  return tickets;
}

export const TODAY = STORY_TODAY;
