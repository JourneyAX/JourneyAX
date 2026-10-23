/**
 * The products a customer has ticked to compare. Held outside React state so a tile in the thread, the compare tray above the
 * composer and the action that opens the comparison all see the same selection without any of them owning it.
 */
import { useSyncExternalStore } from 'react';

export interface CompareEntry { sku: string; title: string }

/** Two to three products fit a side-by-side table in the thread; a fourth would squeeze the columns. */
export const MAX_COMPARE = 3;

let selection: CompareEntry[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function getCompareSelection(): CompareEntry[] { return selection; }

/** Ticks or unticks a product. Returns false when it was refused because the selection is full. */
export function toggleCompare(entry: CompareEntry): boolean {
  const sku = entry.sku.trim();
  if (!sku) return false;
  if (selection.some((item) => item.sku === sku)) {
    selection = selection.filter((item) => item.sku !== sku);
    emit();
    return true;
  }
  if (selection.length >= MAX_COMPARE) return false;
  selection = [...selection, { sku, title: entry.title.trim() || sku }];
  emit();
  return true;
}

export function clearCompare(): void {
  if (selection.length === 0) return;
  selection = [];
  emit();
}

export function useCompareSelection(): CompareEntry[] {
  return useSyncExternalStore(subscribe, getCompareSelection, () => []);
}
