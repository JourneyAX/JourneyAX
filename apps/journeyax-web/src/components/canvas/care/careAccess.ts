'use client';

/**
 * How the chat offers the care screens: two chips on the empty chat, shown only to a signed-in person the server says is care staff. Nobody
 * else is asked to see them, and a shopper's page never makes the call at all (it needs a signed-in person).
 */
import { useEffect, useState } from 'react';
import { fetchCareAccess, fetchStockAccess } from './careApi';

export interface CareEntry { label: string; kind: 'care-queue' | 'care-board' | 'stock-queue' | 'stock-board' }

export const CARE_ENTRIES: CareEntry[] = [
  { label: 'My tickets', kind: 'care-queue' },
  { label: 'Care board', kind: 'care-board' },
];

/** The chips for the stock exceptions desk, offered only to branch staff the server says work it. */
export const STOCK_ENTRIES: CareEntry[] = [
  { label: 'Stock exceptions', kind: 'stock-queue' },
  { label: 'Stock board', kind: 'stock-board' },
];

/** True once the server has said the signed-in person is care staff; false while it is asking, for anyone else, and when signed out. */
export function useCareAccess(signedInAs: string | null | undefined): boolean {
  const [care, setCare] = useState(false);
  useEffect(() => {
    if (!signedInAs) { setCare(false); return; }
    let cancelled = false;
    fetchCareAccess().then((yes) => { if (!cancelled) setCare(yes); });
    return () => { cancelled = true; };
  }, [signedInAs]);
  return care;
}

/** True once the server has said the signed-in person works the stock desk; false while it is asking, for anyone else, when the desk is off, and when signed out. */
export function useStockAccess(signedInAs: string | null | undefined): boolean {
  const [stock, setStock] = useState(false);
  useEffect(() => {
    if (!signedInAs) { setStock(false); return; }
    let cancelled = false;
    fetchStockAccess().then((yes) => { if (!cancelled) setStock(yes); });
    return () => { cancelled = true; };
  }, [signedInAs]);
  return stock;
}
