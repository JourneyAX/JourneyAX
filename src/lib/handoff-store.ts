/**
 * Coach reorder submissions, persisted so CSR staff can see them.
 *
 * Before this existed, a coach's "Complete" step minted a fake order number
 * client-side and forgot it the moment the tab closed — nothing was ever
 * handed to anyone. This is the other half: the coach's submit action writes
 * here, and the CSR desk reads from here.
 *
 * In-memory, like every other store this session (revocation, lockout,
 * codes) — lost on restart, not shared across instances. Fine for a single
 * demo process; swap for a real database before this represents money.
 */

export type CompletionPath = 'direct-reorder' | 'artwork-review';
export type HandoffStatus = 'new' | 'in-review' | 'processed';

export interface RosterSnapshot {
  id: string;
  number: string;
  name: string;
  size: string;
}

export interface DesignSnapshot {
  teamName: string;
  primaryColor: string;
  secondaryColor: string;
  logoText: string;
  logoPlacement: string;
  treatment: string;
  garmentStyle: string;
}

export interface HandoffRecord {
  id: string;
  reference: string;
  completionPath: CompletionPath;
  submittedAt: string;
  coachId: string;
  coachName: string;
  school: string;
  team: string;
  sport?: string;
  season: string;
  originalOrderId: string;
  /** What actually changed vs. the approved order — the whole point of the coach flow. */
  changedAreas: string[];
  roster: RosterSnapshot[];
  design: DesignSnapshot;
  deliveryNotes: string;
  statusMessage: string;
  status: HandoffStatus;
  /** Staff member who last touched the status, once one has. */
  handledBy?: string;
  handledAt?: string;
}

const handoffs = new Map<string, HandoffRecord>();

export function recordHandoff(record: Omit<HandoffRecord, 'status'>): HandoffRecord {
  const full: HandoffRecord = { ...record, status: 'new' };
  handoffs.set(full.id, full);
  return full;
}

/** Newest first — that's the order a CSR triaging a queue wants to see them. */
export function listHandoffs(): HandoffRecord[] {
  return [...handoffs.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

export function getHandoff(id: string): HandoffRecord | null {
  return handoffs.get(id) ?? null;
}

export function setHandoffStatus(
  id: string, status: HandoffStatus, handledBy: string,
): HandoffRecord | null {
  const existing = handoffs.get(id);
  if (!existing) return null;
  const updated: HandoffRecord = {
    ...existing, status, handledBy, handledAt: new Date().toISOString(),
  };
  handoffs.set(id, updated);
  return updated;
}

export function __clearHandoffs() {
  handoffs.clear();
}
