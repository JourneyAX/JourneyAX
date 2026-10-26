/**
 * The care person's tickets as the portal holds them right now. Held outside React (like the side panel and the compare selection) because the
 * thing that changes a ticket, the care desk telling us a ticket arrived or the AI finished a stage, lives far from the canvases that show it.
 *
 * Two ways in, one function: `applyCareEvent`. In a connected portal `useCareSync` asks the care desk for the tickets every two seconds while a
 * care canvas is open, so a ticket that reaches Zendesk shows up within moments and moves as the AI works. In a preview with no server
 * (NEXT_PUBLIC_CARE_FIXTURES=1) the store starts with a fixed list and `simulateArrival` replays a ticket arriving.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { CARE_STAGES, CARE_TICKETS, arrivalTicket, stageIndex, type CareStage, type CareTicket } from './careData';
import { FIXTURES, fetchTickets, type CareActor } from './careApi';

let tickets: CareTicket[] = FIXTURES ? [...CARE_TICKETS] : [];
let actor: CareActor | null = null;
let status: { loaded: boolean; error: string } = { loaded: FIXTURES, error: '' };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export type CareEvent = { type: 'ticket'; ticket: CareTicket };

/** A ticket arrived or moved on: replace it by id (or add it at the top), never moving a ticket backwards a stage. */
export function applyCareEvent(event: CareEvent): void {
  const incoming = event.ticket;
  const existing = tickets.find((t) => t.id === incoming.id);
  if (existing && stageIndex(incoming.stage) < stageIndex(existing.stage)) return;
  tickets = existing ? tickets.map((t) => (t.id === incoming.id ? incoming : t)) : [incoming, ...tickets];
  emit();
}

/** The care desk's own list replaces ours: it is the truth. A ticket we have already seen at a later stage is not taken back a stage. */
export function replaceCareTickets(next: CareTicket[], who?: CareActor): void {
  const kept = new Map(tickets.map((t) => [t.id, t]));
  tickets = next.map((t) => { const seen = kept.get(t.id); return seen && stageIndex(seen.stage) > stageIndex(t.stage) ? seen : t; });
  if (who) actor = who;
  status = { loaded: true, error: '' };
  emit();
}

export const getCareTickets = (): CareTicket[] => tickets;
export const useCareTickets = (): CareTicket[] => useSyncExternalStore(subscribe, getCareTickets, () => (FIXTURES ? CARE_TICKETS : []));
export function useCareTicket(id: string | undefined): CareTicket | undefined {
  const all = useCareTickets();
  return all.find((t) => t.id === id || t.ref === id);
}
export const useCareActor = (): CareActor | null => useSyncExternalStore(subscribe, () => actor, () => null);
export const useCareStatus = () => useSyncExternalStore(subscribe, () => status, () => status);

export function resetCareStore(): void { tickets = FIXTURES ? [...CARE_TICKETS] : []; actor = null; status = { loaded: FIXTURES, error: '' }; emit(); }

export async function syncCareNow(): Promise<void> {
  const answer = await fetchTickets();
  if ('error' in answer) { status = { loaded: status.loaded, error: answer.error }; emit(); return; }
  replaceCareTickets(answer.tickets, answer.actor);
}

/** While a care canvas is open, keep the tickets current: ask now, then every `everyMs`. Does nothing in a preview with a fixed list. */
export function useCareSync(everyMs = 2000): void {
  useEffect(() => {
    if (FIXTURES) return undefined;
    let stopped = false;
    const tick = () => { if (!stopped && (typeof document === 'undefined' || !document.hidden)) void syncCareNow(); };
    tick();
    const timer = window.setInterval(tick, everyMs);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [everyMs]);
}

/** The stage the AI is working on for a ticket that is not yet waiting for a person. */
export const aiStage = (t: CareTicket) => CARE_STAGES.find((s) => s.id === t.stage);

/** For a preview: a ticket reaches the ticket desk and the AI works through it, one stage every `everyMs`. Returns a function that stops it. */
export function simulateArrival(everyMs = 2200): () => void {
  const path: CareStage[] = ['arrived', 'read', 'researched', 'drafted', 'waiting'];
  const timers: number[] = [];
  path.forEach((stage, i) => timers.push(window.setTimeout(() => applyCareEvent({ type: 'ticket', ticket: arrivalTicket(stage) }), i * everyMs)));
  return () => timers.forEach((t) => window.clearTimeout(t));
}
