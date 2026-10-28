'use client';

/**
 * How the chat offers the care screens: two chips on the empty chat, shown only to a signed-in person the server says is care staff. Nobody
 * else is asked to see them, and a shopper's page never makes the call at all (it needs a signed-in person).
 */
import { useEffect, useState } from 'react';
import { fetchCareAccess, fetchDeskAccess } from './careApi';
import type { DeskKind } from './careData';

export interface CareEntry { label: string; kind: 'care-queue' | 'care-board' | 'stock-queue' | 'stock-board' | 'quotes-queue' | 'quotes-board' }

export const CARE_ENTRIES: CareEntry[] = [
  { label: 'My tickets', kind: 'care-queue' },
  { label: 'Care board', kind: 'care-board' },
];

/** The chips for the stock exceptions desk, offered only to branch staff the server says work it. */
export const STOCK_ENTRIES: CareEntry[] = [
  { label: 'Stock exceptions', kind: 'stock-queue' },
  { label: 'Stock board', kind: 'stock-board' },
];

/** The chips for the quotes desk, offered only to the sales people the server says work it. */
export const QUOTES_ENTRIES: CareEntry[] = [
  { label: 'Quote requests', kind: 'quotes-queue' },
  { label: 'Quotes board', kind: 'quotes-board' },
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

/** True once the server has said the signed-in person works the desk; false while it is asking, for anyone else, when the desk is off, and when signed out. */
export function useDeskAccess(desk: Exclude<DeskKind, 'care'>, signedInAs: string | null | undefined): boolean {
  const [yes, setYes] = useState(false);
  useEffect(() => {
    if (!signedInAs) { setYes(false); return; }
    let cancelled = false;
    fetchDeskAccess(desk).then((answer) => { if (!cancelled) setYes(answer); });
    return () => { cancelled = true; };
  }, [desk, signedInAs]);
  return yes;
}
export const useStockAccess = (signedInAs: string | null | undefined): boolean => useDeskAccess('stock', signedInAs);
export const useQuotesAccess = (signedInAs: string | null | undefined): boolean => useDeskAccess('quotes', signedInAs);
