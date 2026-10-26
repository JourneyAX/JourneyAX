/**
 * What the empty chat suggests, for a person who works with the connected systems: a few things they can ask for today, taken from
 * what they may actually use (the same list the "+" menu shows). A customer service adviser is offered cases and orders, someone in
 * marketing is offered campaigns, a branch counter is offered stock. Nobody is offered something they would be refused.
 *
 * The tool list comes from the server (it is already cut down to the person), so this never grants anything: it only words a few
 * starting questions. When fewer than two can be offered (a shopper, or a person with no connected system) the shop's own starters stand.
 */
import type { ConnectorItem } from '../connectors/connectors';

export interface Starter { label: string; prompt: string }

/** In the order they are offered, one system at a time (`system.tool`). */
const TABLE: Array<Starter & { tool: string }> = [
  { tool: 'salesforce.find_account', label: 'Tell me about a trade account', prompt: 'I want a brief on one of our trade accounts. Ask me which one.' },
  { tool: 'commercetools.order_history', label: 'See an account’s recent orders', prompt: 'I want to see the recent orders of one of our accounts. Ask me which one.' },
  { tool: 'salesforce.list_cases', label: 'Show the open cases', prompt: 'Show me the open cases, newest first.' },
  { tool: 'commercetools.stock_by_branch', label: 'Check stock at a branch', prompt: 'I want to check the stock of a product at a branch. Ask me which product and which branch.' },
  { tool: 'salesforce.create_case', label: 'Raise a case for a customer', prompt: 'I need to raise a case for a customer. Ask me what you need to know.' },
  { tool: 'commercetools.get_order', label: 'Check an order', prompt: 'I want to check an order. Ask me for the order number.' },
  { tool: 'salesforce.list_opportunities', label: 'What deals are open?', prompt: 'Show me the open deals and their next steps.' },
  { tool: 'salesforce.pipeline_summary', label: 'Show the sales pipeline', prompt: 'Show me the pipeline by rep.' },
  { tool: 'salesforce.list_campaigns', label: 'What campaigns are running?', prompt: 'Which marketing campaigns are running right now?' },
  { tool: 'marketing-cloud.list_messages', label: 'What messages went out?', prompt: 'Which messages did we send to trade customers recently?' },
  { tool: 'google-analytics.traffic_by_page', label: 'How is the website doing?', prompt: 'How is our website doing? Show me the busiest pages.' },
  { tool: 'power-bi.list_reports', label: 'Show me a report', prompt: 'Which reports can you show me?' },
  { tool: 'zendesk.find_tickets', label: 'Find a support ticket', prompt: 'Find the open support tickets.' },
];

export const MAX_STARTERS = 4;

/** The person's own starters, or `fallback` when fewer than two can be offered. */
export function startersFor(connectors: ConnectorItem[], fallback: Starter[]): Starter[] {
  const usable = (tool: string): boolean => {
    const [system, name] = tool.split('.');
    return connectors.some((item) => item.connector === system && item.tools.some((t) => t.name === name && (t.state === 'allow' || t.state === 'ask')));
  };
  const available = TABLE.filter((entry) => usable(entry.tool));
  // One system at a time, so a person who has two systems is shown both, not four questions about the same one.
  const bySystem = new Map<string, typeof available>();
  for (const entry of available) bySystem.set(entry.tool.split('.')[0], [...(bySystem.get(entry.tool.split('.')[0]) ?? []), entry]);
  const picked: Starter[] = [];
  for (let round = 0; picked.length < MAX_STARTERS; round += 1) {
    let any = false;
    for (const list of bySystem.values()) {
      if (picked.length >= MAX_STARTERS) break;
      if (list[round]) { picked.push({ label: list[round].label, prompt: list[round].prompt }); any = true; }
    }
    if (!any) break;
  }
  return picked.length >= 2 ? picked : fallback;
}
