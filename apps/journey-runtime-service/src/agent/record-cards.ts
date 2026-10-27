import { recordCardsFor, todayIn, dashboardFor, type DashboardFormat } from '@journeyax/business-pack';
import type { AgentToolContext } from './agent-tools';

/** Most record cards one turn shows: a reply with more than this is a report, and belongs on the dashboard. */
const MAX_CARDS_PER_TURN = 3;

/** How dates and money are written for this shop: its own currency and locale, and its own idea of today. */
export function dashboardFormat(release: { profile?: { primaryCurrency?: string; primaryLocale?: string } } | undefined, setting: { timeZone?: string } | undefined, now?: Date): DashboardFormat {
  return { today: todayIn(setting?.timeZone, now), ...(setting?.timeZone ? { timeZone: setting.timeZone } : {}), currency: release?.profile?.primaryCurrency, locale: release?.profile?.primaryLocale };
}

/**
 * Shows what a connector tool just returned as cards in the chat, when the person's team has a card for that tool in the pack's dashboard
 * setting. The card is made from the tool's answer and the pack's own wording: nothing is written by the model, and the model is told the
 * records are on screen so it keeps its own words short. Returns the headings shown, for that note.
 */
export function showRecordCards(ctx: AgentToolContext, connector: string, tool: string, answer: unknown, now?: Date): string[] {
  const setting = (ctx.release as { extensions?: Record<string, any> } | undefined)?.extensions?.dashboard;
  const person = ctx.principal;
  if (!setting || !person || person.audience !== 'staff') return [];
  const entry = dashboardFor(setting, { audience: person.audience, groups: person.groups });
  if (!entry) return [];
  const shown = (ctx.shownRecordCards ||= new Set<string>());
  const headings: string[] = [];
  for (const card of recordCardsFor(entry, connector, tool, answer, dashboardFormat(ctx.release as any, setting, now))) {
    if (shown.size >= MAX_CARDS_PER_TURN) break;
    const signature = `${card.heading}|${JSON.stringify(card.rows)}`;
    if (shown.has(signature)) continue;
    shown.add(signature);
    ctx.presentedCards.push({ cardType: 'records', state: card });
    ctx.emitUiAction?.({ name: 'presentCard', arguments: { card: { id: `records-${connector}-${tool}-${shown.size}-${Date.now()}`, cardType: 'records', state: card } } });
    headings.push(card.heading);
  }
  return headings;
}

/** What the model is told when cards were shown: say what stands out, do not read the records out again. */
export function cardsShownNote(headings: string[]): string {
  return `The person can now see ${headings.map((heading) => `"${heading}"`).join(' and ')} as ${headings.length === 1 ? 'a card' : 'cards'} under your reply, with each record's figures. Do not list those records in your reply, and do not repeat their numbers or reference numbers. In two or three short sentences say what stands out and what the person might do next.`;
}
