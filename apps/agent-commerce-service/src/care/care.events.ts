/** A small fan-out of what changed, per tenant, so every open portal sees a ticket move as it happens. */
import type { CareEvent } from './care.types';

type Listener = (event: CareEvent) => void;

export class CareEvents {
  private listeners = new Map<string, Set<Listener>>();
  subscribe(tenantId: string, listener: Listener): () => void {
    const set = this.listeners.get(tenantId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(tenantId, set);
    return () => { set.delete(listener); };
  }
  emit(tenantId: string, event: CareEvent): void {
    for (const listener of [...(this.listeners.get(tenantId) ?? [])]) {
      try { listener(event); } catch { /* one slow or broken portal must not stop the others */ }
    }
  }
}
