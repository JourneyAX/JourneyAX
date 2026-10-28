/**
 * The care person's tickets as the portal holds them right now. Held outside React (like the side panel and the compare selection) because the
 * thing that changes a ticket, the care desk telling us a ticket arrived or the AI finished a stage, lives far from the canvases that show it.
 *
 * There is one list for each desk (customer care's tickets, the stock desk's exceptions, the quotes desk's requests); every function takes the desk and means customer care
 * when it is left out. A case says which desk it belongs to (`desk`), so an event finds its own list.
 *
 * Two ways in, one function: `applyCareEvent`. In a connected portal `useCareSync` asks the desk for its cases every two seconds while a care
 * canvas is open, so a ticket that reaches Zendesk shows up within moments and moves as the AI works. In a preview with no server
 * (NEXT_PUBLIC_CARE_FIXTURES=1) the store starts with a fixed list and `simulateArrival` replays a ticket arriving.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { CARE_TICKETS, arrivalTicket, stageIndex, type CareStage, type CareTicket, type DeskKind } from './careData';
import { deskOf, deskWords } from './deskWords';
import { FIXTURES, fetchTickets, type CareActor } from './careApi';

interface DeskState { tickets: CareTicket[]; actor: CareActor | null; status: { loaded: boolean; error: string } }
const initial = (desk: DeskKind): DeskState => ({ tickets: FIXTURES && desk === 'care' ? [...CARE_TICKETS] : [], actor: null, status: { loaded: FIXTURES && desk === 'care', error: '' } });
const desks: Record<DeskKind, DeskState> = { care: initial('care'), stock: initial('stock'), quotes: initial('quotes') };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export type CareEvent = { type: 'ticket'; ticket: CareTicket };

/** A ticket arrived or moved on: replace it by id (or add it at the top), never moving a ticket backwards a stage. */
export function applyCareEvent(event: CareEvent): void {
  const incoming = event.ticket;
  const state = desks[deskOf(incoming)];
  const existing = state.tickets.find((t) => t.id === incoming.id);
  if (existing && stageIndex(incoming.stage) < stageIndex(existing.stage)) return;
  state.tickets = existing ? state.tickets.map((t) => (t.id === incoming.id ? incoming : t)) : [incoming, ...state.tickets];
  emit();
}

/** The desk's own list replaces ours: it is the truth. A ticket we have already seen at a later stage is not taken back a stage. */
export function replaceCareTickets(next: CareTicket[], who?: CareActor, desk: DeskKind = 'care'): void {
  const state = desks[desk];
  const kept = new Map(state.tickets.map((t) => [t.id, t]));
  state.tickets = next.map((t) => { const seen = kept.get(t.id); return seen && stageIndex(seen.stage) > stageIndex(t.stage) ? seen : t; });
  if (who) state.actor = who;
  state.status = { loaded: true, error: '' };
  emit();
}

export const getCareTickets = (desk: DeskKind = 'care'): CareTicket[] => desks[desk].tickets;
export const useCareTickets = (desk: DeskKind = 'care'): CareTicket[] => useSyncExternalStore(subscribe, () => desks[desk].tickets, () => desks[desk].tickets);
export function useCareTicket(id: string | undefined, desk: DeskKind = 'care'): CareTicket | undefined {
  const all = useCareTickets(desk);
  return all.find((t) => t.id === id || t.ref === id);
}
export const useCareActor = (desk: DeskKind = 'care'): CareActor | null => useSyncExternalStore(subscribe, () => desks[desk].actor, () => desks[desk].actor);
export const useCareStatus = (desk: DeskKind = 'care') => useSyncExternalStore(subscribe, () => desks[desk].status, () => desks[desk].status);

export function resetCareStore(): void { desks.care = initial('care'); desks.stock = initial('stock'); desks.quotes = initial('quotes'); emit(); }

export async function syncCareNow(desk: DeskKind = 'care'): Promise<void> {
  const answer = await fetchTickets(desk);
  if ('error' in answer) { desks[desk].status = { loaded: desks[desk].status.loaded, error: answer.error }; emit(); return; }
  replaceCareTickets(answer.tickets, answer.actor, desk);
}

/** While a care canvas is open, keep the desk's cases current: ask now, then every `everyMs`. Does nothing in a preview with a fixed list. */
export function useCareSync(desk: DeskKind = 'care', everyMs = 2000): void {
  useEffect(() => {
    if (FIXTURES) return undefined;
    let stopped = false;
    const tick = () => { if (!stopped && (typeof document === 'undefined' || !document.hidden)) void syncCareNow(desk); };
    tick();
    const timer = window.setInterval(tick, everyMs);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [desk, everyMs]);
}

/** The stage the AI is working on for a ticket that is not yet waiting for a person. */
export const aiStage = (t: CareTicket) => deskWords(t.desk).stages.find((s) => s.id === t.stage);

/** For a preview: a ticket reaches the ticket desk and the AI works through it, one stage every `everyMs`. Returns a function that stops it. */
export function simulateArrival(everyMs = 2200): () => void {
  const path: CareStage[] = ['arrived', 'read', 'researched', 'drafted', 'waiting'];
  const timers: number[] = [];
  path.forEach((stage, i) => timers.push(window.setTimeout(() => applyCareEvent({ type: 'ticket', ticket: arrivalTicket(stage) }), i * everyMs)));
  return () => timers.forEach((t) => window.clearTimeout(t));
}
