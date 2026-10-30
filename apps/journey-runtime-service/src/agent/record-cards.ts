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
  // Staff have their team's cards; a signed-in trade customer has the cards of the company role they hold; an ordinary shopper has none.
  const companyRoles = (ctx.companies ?? []).map((company) => company.role);
  if (!setting || !person || (person.audience !== 'staff' && companyRoles.length === 0)) return [];
  const entry = dashboardFor(setting, { audience: person.audience, groups: person.groups, companyRoles });
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

/**
 * What the model is told when cards were shown: say what stands out, do not read the records out again. When the answer holds several
 * records and the person has to pick one (three accounts match one name), the model names each with its number so they can choose: the
 * card alone does not say which one the person meant, and a skill that says "list the closest with their numbers and ask" must not be
 * contradicted here.
 */
export function cardsShownNote(headings: string[], records = 1): string {
  const list = `${headings.map((heading) => `"${heading}"`).join(' and ')} as ${headings.length === 1 ? 'a card' : 'cards'}`;
  const choose = records > 1
    ? ' When the question needs the person to pick one of these records (several match the name they gave), name each in one short line with its number so they can choose, and ask which one. Otherwise, in'
    : ' In';
  return `The person can now see ${list} under your reply, with each record's figures. Do not read the records out again or repeat their figures.${choose} two or three short sentences say what stands out and what the person might do next.`;
}
