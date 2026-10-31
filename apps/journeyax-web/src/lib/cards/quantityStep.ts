/**
 * The "how many?" step between tapping Add and the item landing in the list. Nothing is added blindly: the customer says how many,
 * or asks the consultant to work it out from their area. Held outside React state (like the compare selection) so a card anywhere
 * in the thread can open it and one host can show it.
 */
import { useSyncExternalStore } from 'react';

export const MAX_QUANTITY = 9999;

export interface QuantityRequest {
  sku: string;
  title: string;
  imageUrl?: string | null;
  price?: number | null;
  currency?: string;
  /** The number offered first. */
  initial: number;
  /** The customer chose a number: carry on and add it. */
  onConfirm: (quantity: number) => void;
  /** The customer wants help working the number out from their area. */
  onWorkItOut: () => void;
}

/** A whole number from 1 to MAX_QUANTITY; anything else becomes the fallback. */
export function clampQuantity(value: unknown, fallback = 1): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_QUANTITY, n);
}

let current: QuantityRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function getQuantityRequest(): QuantityRequest | null { return current; }

export function requestQuantity(request: QuantityRequest): void {
  current = { ...request, sku: request.sku.trim(), title: request.title.trim() || request.sku.trim(), initial: clampQuantity(request.initial) };
  emit();
}

export function closeQuantityStep(): void {
  if (!current) return;
  current = null;
  emit();
}

export function useQuantityRequest(): QuantityRequest | null {
  return useSyncExternalStore(subscribe, getQuantityRequest, () => null);
}
