/**
 * The corner tile and the dashboard it opens, as the page holds them. The server works everything out from the shop's pack and the person's
 * own access; this file only reads the answer carefully (anything malformed is dropped, nothing is trusted to be the right shape), words
 * "updated 3 minutes ago", and keeps one copy that the tile and the canvas share.
 */
export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export interface DashboardFigure { id: string; label: string; value: string; tone: Tone; hint?: string; ask?: string; ok: boolean }
export interface DashboardRow { title: string; subtitle?: string; detail?: string; badge?: string; tone?: Tone; amount?: string; ask?: string }
export interface DashboardSection {
  id: string;
  title: string;
  state: 'ok' | 'blocked' | 'unavailable';
  rows: DashboardRow[];
  total: number;
  empty?: string;
  more?: { label: string; prompt: string };
}
export interface DashboardData {
  title: string;
  subtitle?: string;
  scope: 'mine' | 'team';
  name?: string;
  asOf: string;
  tile: DashboardFigure[];
  metrics: DashboardFigure[];
  sections: DashboardSection[];
}

const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const tone = (value: unknown): Tone => (value === 'good' || value === 'warn' || value === 'bad' || value === 'info' ? value : 'neutral');

function figure(raw: any): DashboardFigure | undefined {
  const id = text(raw?.id, 40);
  const label = text(raw?.label, 40);
  const value = text(raw?.value, 24);
  if (!id || !label || !value) return undefined;
  return { id, label, value, tone: tone(raw.tone), ok: raw.ok !== false, ...(text(raw.hint, 120) ? { hint: text(raw.hint, 120) } : {}), ...(text(raw.ask, 300) ? { ask: text(raw.ask, 300) } : {}) };
}

/** One row of a list or a card; a row with no title is dropped. */
export function parseRow(raw: any): DashboardRow | undefined {
  const title = text(raw?.title, 160);
  if (!title) return undefined;
  const row: DashboardRow = { title };
  for (const [key, max] of [['subtitle', 200], ['detail', 200], ['badge', 80], ['amount', 80], ['ask', 300]] as const) {
    const value = text(raw[key], max);
    if (value) row[key] = value;
  }
  if (row.badge && raw.tone) row.tone = tone(raw.tone);
  return row;
}

/** The `dashboard` of the answer; anything malformed is left out, and no usable tile means no dashboard. */
export function parseDashboard(json: unknown): DashboardData | undefined {
  const raw = (json as { dashboard?: any } | null | undefined)?.dashboard;
  if (!raw || typeof raw !== 'object') return undefined;
  const title = text(raw.title, 40);
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const tile = list(raw.tile).map(figure).filter((f): f is DashboardFigure => !!f).slice(0, 3);
  if (!title || tile.length === 0) return undefined;
  const sections = list(raw.sections).flatMap((entry: any): DashboardSection[] => {
    const id = text(entry?.id, 40);
    const heading = text(entry?.title, 60);
    if (!id || !heading) return [];
    const more = text(entry?.more?.label, 40) && text(entry?.more?.prompt, 300) ? { label: text(entry.more.label, 40)!, prompt: text(entry.more.prompt, 300)! } : undefined;
    return [{
      id, title: heading,
      state: entry.state === 'blocked' || entry.state === 'unavailable' ? entry.state : 'ok',
      rows: list(entry.rows).map(parseRow).filter((r): r is DashboardRow => !!r).slice(0, 10),
      total: Number.isFinite(entry.total) ? Math.max(0, Math.floor(entry.total)) : 0,
      ...(text(entry.empty, 160) ? { empty: text(entry.empty, 160) } : {}),
      ...(more ? { more } : {}),
    }];
  }).slice(0, 6);
  return {
    title,
    ...(text(raw.subtitle, 160) ? { subtitle: text(raw.subtitle, 160) } : {}),
    scope: raw.scope === 'mine' ? 'mine' : 'team',
    ...(text(raw.name, 120) ? { name: text(raw.name, 120) } : {}),
    asOf: text(raw.asOf, 40) ?? new Date().toISOString(),
    tile,
    metrics: list(raw.metrics).map(figure).filter((f): f is DashboardFigure => !!f).slice(0, 8),
    sections,
  };
}

/** "Updated just now", "Updated 3 minutes ago", "Updated 2 hours ago". */
export function updatedWords(asOf: string, now: Date = new Date()): string {
  const then = Date.parse(asOf);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));
  if (minutes < 1) return 'Updated just now';
  if (minutes === 1) return 'Updated a minute ago';
  if (minutes < 60) return `Updated ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? 'Updated an hour ago' : `Updated ${hours} hours ago`;
}

/** The line under the canvas heading: whose figures these are. */
export function scopeWords(data: Pick<DashboardData, 'scope' | 'name'>): string {
  return data.scope === 'mine' && data.name ? `Showing ${data.name}'s deals` : 'Showing the whole team';
}

/** True when any figure of the tile could not be read, so the tile can say so instead of showing a dash alone. */
export const tileHasGap = (data: Pick<DashboardData, 'tile'>): boolean => data.tile.some((f) => !f.ok);
