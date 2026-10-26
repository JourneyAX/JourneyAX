'use client';

/**
 * How the chat offers the care screens: two chips on the empty chat, shown only to a signed-in person the server says is care staff. Nobody
 * else is asked to see them, and a shopper's page never makes the call at all (it needs a signed-in person).
 */
import { useEffect, useState } from 'react';
import { fetchCareAccess } from './careApi';

export interface CareEntry { label: string; kind: 'care-queue' | 'care-board' }

export const CARE_ENTRIES: CareEntry[] = [
  { label: 'My tickets', kind: 'care-queue' },
  { label: 'Care board', kind: 'care-board' },
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
