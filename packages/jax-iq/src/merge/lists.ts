import type { Binding } from '../model';

/**
 * Lists that reach us more than once: the orders of an account and of its divisions, the same ticket from two searches, the same account
 * found in two systems. A record is counted once. Two copies are the same record when they are the same thing and share a canonical id,
 * or share a system key (the system, the kind of key and its value). Copies with contradicting canonical ids are never joined, and the
 * clash is reported. A copy with no canonical id joins no copy from another system, so a ticket and a case are never merged unless the key
 * table links them.
 */

export interface MergeListItem<P = unknown> {
  thing: string;
  system: string;
  key: { kind: string; value: string };
  /** From the key table; absent or `null` when the record is not in it. */
  canonicalId?: string | null;
  authority: Binding['authority'];
  payload: P;
}

/** The items one system returned for one call. */
export interface MergeListSource<P = unknown> {
  system: string;
  items: readonly MergeListItem<P>[];
  /** What the system says the whole list holds, when it says. */
  total?: number | null;
  /** The system, or the size cap, cut the list. */
  more: boolean;
  /** True: the system did not answer. It adds no items and the list is incomplete. */
  failed?: boolean;
}

export interface MergedListItem<P = unknown> extends MergeListItem<P> {
  /** Every system that returned this record, in the order they were first seen. */
  mergedFrom: string[];
}

export interface MergedList<P = unknown> {
  items: MergedListItem<P>[];
  returned: number;
  /** Some system cut its list. */
  more: boolean;
  /** Some system did not answer or cut its list: what is here may not be all there is. */
  incomplete: boolean;
  /** Said only when it is known: a system's own total, or a complete list counted here. Never above what was seen without a system saying so. */
  total?: { value: number; basis: 'source_total' | 'counted_here' };
  duplicatesRemoved: number;
  /** System keys that two different canonical ids claim: a defect in the key table. */
  conflicts: string[];
}

/** A higher number wins when two copies of one record are kept. */
const AUTHORITY_RANK: Readonly<Record<Binding['authority'], number>> = { source_of_truth: 3, fallback: 2, cross_check: 1 };

const part = (text: string): string => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const canonicalIdentity = (item: MergeListItem<unknown>, id: string): string => `${part(item.thing)}|${part(id)}`;
const keyIdentity = (item: MergeListItem<unknown>): string => [item.thing, item.system, item.key.kind, item.key.value].map(part).join('|');
const clash = (item: MergeListItem<unknown>): string => `${item.system}:${item.key.kind}:${item.key.value}`;

interface Group<P> {
  kept: MergeListItem<P>;
  canonicalId: string | null;
  systems: string[];
}

export function mergeLists<P = unknown>(sources: readonly MergeListSource<P>[]): MergedList<P> {
  const groups: Array<Group<P>> = [];
  const byCanonical = new Map<string, Group<P>>();
  const byKey = new Map<string, Group<P>>();
  const conflicts: string[] = [];
  let seen = 0;

  const join = (into: Group<P>, from: Group<P>) => {
    if (into === from) return;
    for (const system of from.systems) if (!into.systems.includes(system)) into.systems.push(system);
    if (AUTHORITY_RANK[from.kept.authority] > AUTHORITY_RANK[into.kept.authority]) into.kept = from.kept;
    if (into.canonicalId === null) into.canonicalId = from.canonicalId;
    for (const [id, group] of byCanonical) if (group === from) byCanonical.set(id, into);
    for (const [id, group] of byKey) if (group === from) byKey.set(id, into);
    groups.splice(groups.indexOf(from), 1);
  };
  const compatible = (a: Group<P>, canonicalId: string | null) => a.canonicalId === null || canonicalId === null || a.canonicalId === canonicalId;

  for (const source of sources) {
    if (source.failed) continue;
    for (const item of source.items) {
      seen += 1;
      const canonicalId = item.canonicalId ?? null;
      const canonicalKey = canonicalId === null ? null : canonicalIdentity(item, canonicalId);
      const key = keyIdentity(item);
      let group = canonicalKey === null ? undefined : byCanonical.get(canonicalKey);
      const viaKey = byKey.get(key);
      if (viaKey && viaKey !== group) {
        if (!compatible(viaKey, canonicalId)) {
          if (!conflicts.includes(clash(item))) conflicts.push(clash(item));
        } else if (!group) {
          group = viaKey;
        } else {
          // The canonical id and the system key each lead to a different group: this copy shows they are one record.
          const earlier = groups.indexOf(group) < groups.indexOf(viaKey) ? group : viaKey;
          join(earlier, earlier === group ? viaKey : group);
          group = earlier;
        }
      }
      if (!group) {
        group = { kept: item, canonicalId, systems: [item.system] };
        groups.push(group);
      } else {
        if (!group.systems.includes(item.system)) group.systems.push(item.system);
        if (AUTHORITY_RANK[item.authority] > AUTHORITY_RANK[group.kept.authority]) group.kept = item;
        if (group.canonicalId === null && canonicalId !== null) group.canonicalId = canonicalId;
      }
      if (canonicalKey !== null && !byCanonical.has(canonicalKey)) byCanonical.set(canonicalKey, group);
      if (!byKey.has(key)) byKey.set(key, group);
    }
  }

  const items = groups.map((group): MergedListItem<P> => ({ ...group.kept, canonicalId: group.canonicalId, mergedFrom: [...group.systems] }));
  const answered = sources.filter((source) => !source.failed);
  const more = answered.some((source) => source.more);
  const failed = sources.some((source) => source.failed);
  const duplicatesRemoved = seen - items.length;

  const merged: MergedList<P> = { items, returned: items.length, more, incomplete: more || failed, duplicatesRemoved, conflicts };
  if (!failed) {
    const [only] = answered;
    if (answered.length === 1 && duplicatesRemoved === 0 && typeof only.total === 'number' && only.total >= items.length) {
      merged.total = { value: only.total, basis: 'source_total' };
    } else if (!more) {
      merged.total = { value: items.length, basis: 'counted_here' };
    }
  }
  return merged;
}
