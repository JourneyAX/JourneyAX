/**
 * One copy of the dashboard for the tile and the canvas. Held outside React (like the side panel and the care tickets) because the tile that
 * asks for it and the canvas that shows it are far apart and neither owns the other.
 *
 * While someone is signed in and the page is visible it is asked for again every minute; the server keeps its answers for under a minute, so
 * this does not make the connected systems work any harder. A different person signing in starts from nothing, so the last person's figures
 * are never shown to the next.
 */
import { useSyncExternalStore } from 'react';
import { parseDashboard, type DashboardData } from './dashboard';

export type DashboardStatus = 'idle' | 'loading' | 'ready' | 'none' | 'error';
export interface DashboardState { status: DashboardStatus; data?: DashboardData; refreshing: boolean }

export const REFRESH_MS = 60_000;

let state: DashboardState = { status: 'idle', refreshing: false };
let owner = '';
let projectId = '';
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const set = (next: DashboardState) => { state = next; emit(); };

export const getDashboardState = (): DashboardState => state;
export const useDashboardState = (): DashboardState => useSyncExternalStore(subscribe, getDashboardState, () => state);

export async function loadDashboard(): Promise<void> {
  if (!owner) return;
  const mine = owner;
  const ticket = ++inFlight;
  set({ ...state, status: state.data ? state.status : 'loading', refreshing: true });
  try {
    const res = await fetch('/api/dashboard', { credentials: 'same-origin', cache: 'no-store', headers: projectId ? { 'X-Tenant-ID': projectId } : {} });
    const json = res.ok ? await res.json().catch(() => ({})) : null;
    // A newer request, or a different person, has taken over since this was sent.
    if (ticket !== inFlight || mine !== owner) return;
    if (json === null) { set({ status: state.data ? 'ready' : 'error', data: state.data, refreshing: false }); return; }
    const data = parseDashboard(json);
    set(data ? { status: 'ready', data, refreshing: false } : { status: 'none', refreshing: false });
  } catch {
    if (ticket !== inFlight || mine !== owner) return;
    set({ status: state.data ? 'ready' : 'error', data: state.data, refreshing: false });
  }
}

/** Starts keeping the dashboard current for this signed-in person; `null` stops and forgets everything. Safe to call again with the same person. */
export function trackDashboard(person: string | null | undefined, project: string | undefined): void {
  const next = (person || '').toLowerCase();
  if (next === owner && (project || '') === projectId) return;
  if (timer) { clearInterval(timer); timer = undefined; }
  inFlight++;
  owner = next;
  projectId = project || '';
  set({ status: 'idle', refreshing: false });
  if (!owner || typeof window === 'undefined') return;
  void loadDashboard();
  timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void loadDashboard(); }, REFRESH_MS);
}
