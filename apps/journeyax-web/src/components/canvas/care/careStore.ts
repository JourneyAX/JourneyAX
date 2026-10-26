/**
 * The care person's tickets as the portal holds them right now. Held outside React (like the side panel and the compare selection) because the
 * thing that changes a ticket, a message from the server that the ticket desk sent something new or that the AI finished a stage, lives
 * far from the canvases that show it.
 *
 * `applyCareEvent` is the one way in. For this first look the events come from `simulateArrival`; the connected version feeds the same
 * function from the server's live stream, so the canvases do not change when the source does.
 */
import { useSyncExternalStore } from 'react';
import { CARE_STAGES, CARE_TICKETS, arrivalTicket, stageIndex, type CareStage, type CareTicket } from './careData';

let tickets: CareTicket[] = [...CARE_TICKETS];
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

export const getCareTickets = (): CareTicket[] => tickets;
export const useCareTickets = (): CareTicket[] => useSyncExternalStore(subscribe, getCareTickets, () => CARE_TICKETS);
export function useCareTicket(id: string | undefined): CareTicket | undefined {
  const all = useCareTickets();
  return all.find((t) => t.id === id || t.ref === id);
}

export function resetCareStore(): void { tickets = [...CARE_TICKETS]; emit(); }

/** The stage the AI is working on for a ticket that is not yet waiting for a person. */
export const aiStage = (t: CareTicket) => CARE_STAGES.find((s) => s.id === t.stage);

/** For the first look: a ticket reaches the ticket desk and the AI works through it, one stage every `everyMs`. Returns a function that stops it. */
export function simulateArrival(everyMs = 2200): () => void {
  const path: CareStage[] = ['arrived', 'read', 'researched', 'drafted', 'waiting'];
  const timers: number[] = [];
  path.forEach((stage, i) => timers.push(window.setTimeout(() => applyCareEvent({ type: 'ticket', ticket: arrivalTicket(stage) }), i * everyMs)));
  return () => timers.forEach((t) => window.clearTimeout(t));
}
