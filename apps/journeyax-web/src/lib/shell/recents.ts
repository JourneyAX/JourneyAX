/**
 * The sidebar's "Recents": conversations grouped by how long ago they were last used.
 *
 * Day boundaries are the visitor's own local midnights (a chat from 11 pm last night is "Yesterday" at 8 am, however few
 * hours ago it was). Empty groups are left out, groups keep a fixed order, and chats stay newest-first inside a group.
 */
export interface RecentItem {
  id: string;
  title: string;
  updatedAt: number;
}

export type RecentGroupId = 'today' | 'yesterday' | 'week' | 'older';

export const RECENT_GROUP_LABELS: Record<RecentGroupId, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  older: 'Older',
};

const ORDER: RecentGroupId[] = ['today', 'yesterday', 'week', 'older'];

/** Local midnight at the start of the day holding `ts`, shifted by `dayOffset` whole days (DST-safe: uses calendar dates). */
export function startOfDay(ts: number, dayOffset = 0): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset).getTime();
}

export function groupOf(updatedAt: number, now: number): RecentGroupId {
  if (updatedAt >= startOfDay(now)) return 'today'; // also covers a clock a little ahead of ours
  if (updatedAt >= startOfDay(now, -1)) return 'yesterday';
  if (updatedAt >= startOfDay(now, -7)) return 'week';
  return 'older';
}

export interface RecentGroup<T extends RecentItem> {
  id: RecentGroupId;
  label: string;
  items: T[];
}

/** Groups `items` for display. A non-blank `query` keeps only chats whose title contains it (case-insensitive). */
export function groupRecents<T extends RecentItem>(items: T[], now: number = Date.now(), query = ''): RecentGroup<T>[] {
  const needle = query.trim().toLowerCase();
  const kept = needle ? items.filter((item) => String(item.title || '').toLowerCase().includes(needle)) : items;
  const buckets: Record<RecentGroupId, T[]> = { today: [], yesterday: [], week: [], older: [] };
  for (const item of [...kept].sort((a, b) => b.updatedAt - a.updatedAt)) buckets[groupOf(item.updatedAt, now)].push(item);
  return ORDER.filter((id) => buckets[id].length > 0).map((id) => ({ id, label: RECENT_GROUP_LABELS[id], items: buckets[id] }));
}
