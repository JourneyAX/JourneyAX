/**
 * The corner tile, the dashboard it opens and the cards the chat shows when the assistant looks something up, all worked out from one
 * pack setting (`extensions.dashboard`) and the answers of connector tools. Pure and tenant-neutral: the tenant's pack says which tools to
 * ask and which fields to show, and nothing here knows a system, a team or a word of the shop's. It grants nothing: the caller makes the
 * tool calls through the connector gate and hands the outcomes in, so a tool the person may not use simply has no answer here.
 */
import { DashboardSchema, type DashboardEntry } from './schemas/skill.schema';

export type DashboardTone = 'good' | 'warn' | 'bad' | 'info';

/** `companyRoles` are the roles the person holds in the companies the team linked them to (a signed-in trade customer); empty for staff and for an ordinary shopper. */
export interface DashboardPerson { audience: string; groups: string[]; userId?: string; companyRoles?: string[] }

/** The reserved name a pack's dashboard gives to the signed-in customer's own account tools (`my_balance`, `my_deliveries`): they are the platform's, not a connector's. */
export const CUSTOMER_ACCOUNT_CONNECTOR = 'customer-account';

type Source = DashboardEntry['metrics'][number]['source'];
type Where = NonNullable<DashboardEntry['metrics'][number]['where']>[number];
type RowTemplate = DashboardEntry['sections'][number]['row'];
type Args = Record<string, string | number | boolean>;

export interface DashboardFormat { today: string; currency?: string; locale?: string; /** The shop's time zone: a time written in UTC is read as the shop's day, which can be the next one. */ timeZone?: string }

/** What one connector call gave back: the tool's answer, or the reason there is none. */
export type CallOutcome = { ok: true; data: unknown } | { ok: false; reason: 'blocked' | 'unavailable' };

export interface DashboardCall { key: string; connector: string; tool: string; args: Args }

export interface RowView { title: string; subtitle?: string; detail?: string; badge?: string; tone?: DashboardTone; amount?: string; ask?: string }

export interface TileFigure {
  id: string;
  label: string;
  /** What is shown: "22", "$78,511", or a dash when the number could not be read. */
  value: string;
  raw?: number;
  tone: DashboardTone | 'neutral';
  hint?: string;
  ask?: string;
  /** False when the number could not be read (the tool is not allowed or did not answer). */
  ok: boolean;
}

export interface SectionView {
  id: string;
  title: string;
  state: 'ok' | 'blocked' | 'unavailable';
  rows: RowView[];
  total: number;
  /** The system stopped at its limit, so the true number is this or more. */
  atLeast?: boolean;
  empty?: string;
  more?: { label: string; prompt: string };
}

export interface DashboardView {
  title: string;
  subtitle?: string;
  /** `mine` when the numbers are the signed-in person's own, `team` when they are everyone's. */
  scope: 'mine' | 'team';
  /** The person's name in the connected systems, when the pack gives one. */
  name?: string;
  asOf: string;
  tile: TileFigure[];
  metrics: TileFigure[];
  sections: SectionView[];
}

export interface RecordsCardState { heading: string; rows: RowView[]; total: number; shown: number; atLeast?: boolean }

/** The first entry of the pack's dashboard setting that fits this person, or none (no tile is shown). */
export function dashboardFor(setting: unknown, person: DashboardPerson): DashboardEntry | undefined {
  if (!setting) return undefined;
  const parsed = DashboardSchema.safeParse(setting);
  if (!parsed.success) return undefined;
  const mine = new Set(person.groups.map((group) => group.toLowerCase()));
  const roles = new Set(person.companyRoles ?? []);
  for (const entry of parsed.data.entries) {
    const groups = (entry.groups ?? []).map((group) => group.toLowerCase());
    // An entry for company roles fits a signed-in customer who holds one of them in a company; an ordinary shopper (no company) never fits.
    const fits = entry.companyRoles?.length
      ? person.audience === 'shopper' && entry.companyRoles.some((role) => roles.has(role))
      : groups.length ? person.audience === 'staff' && groups.some((group) => mine.has(group)) : entry.audience === person.audience;
    if (fits) return entry;
  }
  return undefined;
}

/** The person's name in the connected systems, from the pack's `people` list (matched on the login, any case). */
export function dashboardName(setting: unknown, userId: string | undefined): string | undefined {
  const people = (setting as { people?: Record<string, { name?: string }> } | undefined)?.people;
  if (!people || !userId) return undefined;
  const key = Object.keys(people).find((login) => login.toLowerCase() === userId.toLowerCase());
  const name = key ? people[key]?.name : undefined;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Inputs of a call

const NEEDS_NAME = /\{me\.name\}/;
const NAME_HOLE = /\{me\.name\}/g;

/** The inputs of a call with `{me.name}` filled in; an input that needs a name nobody has is left out. */
export function resolveArgs(args: Source['args'], name: string | undefined): { args: Args; usedName: boolean } {
  const out: Args = {};
  let usedName = false;
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === 'string' && NEEDS_NAME.test(value)) {
      if (!name) continue;
      out[key] = value.replace(NAME_HOLE, name);
      usedName = true;
    } else {
      out[key] = value;
    }
  }
  return { args: out, usedName };
}

const stable = (args: Args) => JSON.stringify(Object.keys(args).sort().map((key) => [key, args[key]]));
export const callKey = (source: { connector: string; tool: string }, args: Args) => `${source.connector}.${source.tool}:${stable(args)}`;

/** Every distinct call the tile and the dashboard need, so the caller asks each only once. */
export function dashboardCalls(entry: DashboardEntry, name: string | undefined): DashboardCall[] {
  const seen = new Map<string, DashboardCall>();
  for (const source of [...entry.metrics.map((metric) => metric.source), ...entry.sections.map((section) => section.source)]) {
    const { args } = resolveArgs(source.args, name);
    const key = callKey(source, args);
    if (!seen.has(key)) seen.set(key, { key, connector: source.connector, tool: source.tool, args });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reading an answer

const lookup = (record: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, part) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined), record);

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const WITH_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const WITH_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The calendar day of a date or a time as the shop lives it. A plain date stays as it is; a time with a zone ("…T22:57:42Z", or Salesforce's
 * "…+0000") is read in the shop's zone, where 22:57 UTC is already tomorrow in New Zealand. Without a zone to go by, the written day is used.
 */
function dayOf(value: unknown, timeZone?: string): string | undefined {
  if (typeof value !== 'string' || !DAY.test(value)) return undefined;
  if (!timeZone || !WITH_TIME.test(value) || !WITH_ZONE.test(value)) return value.slice(0, 10);
  const at = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(at) ? value.slice(0, 10) : todayIn(timeZone, new Date(at));
}

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today's date as YYYY-MM-DD in the shop's time zone (UTC when none is given or it is not a zone). */
export function todayIn(timeZone?: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The list a tool answered with: the path the pack names, else the tool's own `records` (or the one list or record it gave). */
export function recordsOf(data: unknown, from?: string): Array<Record<string, unknown>> {
  const objects = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)) : []);
  if (from) {
    const picked = lookup(data, from);
    if (Array.isArray(picked)) return objects(picked);
    return picked && typeof picked === 'object' ? [picked as Record<string, unknown>] : [];
  }
  const body = data as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return [];
  for (const key of ['records', 'stages', 'reps', 'orders', 'items', 'results', 'deliveries', 'tickets']) {
    if (Array.isArray(body[key])) return objects(body[key]);
  }
  return body.record && typeof body.record === 'object' ? [body.record as Record<string, unknown>] : [];
}

function passes(record: Record<string, unknown>, where: Where[] | undefined, format: DashboardFormat): boolean {
  const today = format.today;
  return (where ?? []).every((rule) => {
    const value = lookup(record, rule.field);
    if (rule.op === 'equals') return String(value ?? '').toLowerCase() === String(rule.value ?? '').toLowerCase();
    if (rule.op === 'notEquals') return String(value ?? '').toLowerCase() !== String(rule.value ?? '').toLowerCase();
    if (rule.op === 'in') return String(rule.value ?? '').split(',').map((one) => one.trim().toLowerCase()).filter(Boolean).includes(String(value ?? '').toLowerCase());
    const day = dayOf(value, format.timeZone);
    if (!day) return false;
    const edge = typeof rule.value === 'string' && DAY.test(rule.value) ? rule.value.slice(0, 10) : today;
    if (rule.op === 'before') return day < edge;
    if (rule.op === 'onOrBefore') return day <= edge;
    if (rule.op === 'after') return day > edge;
    const days = Number(rule.value);
    if (rule.op === 'withinLastDays') return Number.isFinite(days) && day <= today && day >= addDays(today, -days);
    return Number.isFinite(days) && day >= today && day <= addDays(today, days);
  });
}

function sorted(records: Array<Record<string, unknown>>, sort: { field: string; order?: 'asc' | 'desc' } | undefined): Array<Record<string, unknown>> {
  if (!sort) return records;
  const direction = sort.order === 'desc' ? -1 : 1;
  const key = (record: Record<string, unknown>) => lookup(record, sort.field);
  return [...records].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === y) return 0;
    if (x === undefined || x === null) return 1;
    if (y === undefined || y === null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * direction;
    return String(x).localeCompare(String(y)) * direction;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Words

function money(value: unknown, format: DashboardFormat, cents = false): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '';
  const digits = cents ? 2 : 0;
  const rounded = cents ? Math.round(n * 100) / 100 : Math.round(n);
  // The shop's own currency and locale come from its pack; with no currency given the figure is shown as a plain number, never as a guessed currency.
  if (!format.currency) return new Intl.NumberFormat(format.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(rounded);
  try {
    return new Intl.NumberFormat(format.locale, { style: 'currency', currency: format.currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  } catch {
    return String(rounded);
  }
}

function dateWords(value: unknown, format: DashboardFormat): string {
  const day = dayOf(value, format.timeZone);
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  const year = Number(format.today.slice(0, 4));
  return `${d} ${MONTHS[m - 1]}${y !== year ? ` ${y}` : ''}`;
}

function show(value: unknown, filter: string | undefined, format: DashboardFormat): string {
  if (value === undefined || value === null || value === '') return '';
  if (filter === 'money') return money(value, format);
  // An order or a line is shown to the cent; a deal is not.
  if (filter === 'price') return money(value, format, true);
  // A count is written with its thousands (9,111 views), in the shop's own locale; text that is not a number is shown as it is.
  if (filter === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? new Intl.NumberFormat(format.locale).format(n) : String(value).trim();
  }
  // A status a system writes with underscores (out_for_delivery) is read as words, with a capital: "Out for delivery".
  if (filter === 'words') return String(value).replace(/_+/g, ' ').trim().replace(/^./u, (first) => first.toUpperCase());
  if (filter === 'date') return dateWords(value, format);
  // A system that writes "pending" or "public reply" in lower case is shown with a capital, as the rest of the words are.
  if (filter === 'title') return String(value).trim().replace(/^./u, (first) => first.toUpperCase());
  const text = String(value);
  // A deal's name ends with its number in brackets; the number is for the system, not for the person.
  if (filter === 'clean') return text.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  // The same, and without the account the name starts with ("Ngata & Penrose Joinery: Garrison Roof Garden" becomes "Garrison Roof Garden").
  if (filter === 'item') {
    const clean = text.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    const colon = clean.indexOf(': ');
    return colon > 0 && colon < clean.length - 2 ? clean.slice(colon + 2).trim() : clean;
  }
  return text.trim();
}

const PLACEHOLDER = /\{([a-zA-Z0-9_.]+)(?:\|([a-z]+))?\}/g;

/**
 * A template filled from a record. Pieces are separated by " · ": a piece whose field is empty is left out with its words, so a missing
 * date never leaves "closes" hanging.
 */
export function fillTemplate(template: string, record: Record<string, unknown>, format: DashboardFormat): string {
  return template.split(' · ').map((piece) => {
    let missing = false;
    const text = piece.replace(PLACEHOLDER, (_all, path: string, filter?: string) => {
      const shown = show(lookup(record, path), filter, format);
      if (!shown) missing = true;
      return shown;
    });
    return missing ? '' : text.trim();
  }).filter(Boolean).join(' · ');
}

function rowView(template: RowTemplate, record: Record<string, unknown>, format: DashboardFormat): RowView {
  const part = (text: string | undefined) => (text ? fillTemplate(text, record, format) : '');
  const badge = part(template.badge);
  const tone = badge ? template.tones?.[badge] : undefined;
  const row: RowView = { title: part(template.title) || '—' };
  for (const [key, text] of [['subtitle', template.subtitle], ['detail', template.detail], ['amount', template.amount], ['ask', template.ask]] as const) {
    const filled = part(text);
    if (filled) row[key] = filled;
  }
  if (badge) row.badge = badge;
  if (tone) row.tone = tone;
  return row;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The tile and the dashboard

const formatNumber = (n: number, kind: 'number' | 'money' | undefined, format: DashboardFormat) => (kind === 'money' ? money(n, format) : new Intl.NumberFormat(format.locale).format(n));

/** The tool stopped before the end: it says "more", or it counted more than it returned. */
function cutShort(data: unknown): boolean {
  const body = data as { total?: unknown; returned?: unknown; more?: unknown } | undefined;
  return body?.more === true || (typeof body?.total === 'number' && typeof body?.returned === 'number' && body.total > body.returned);
}

function figure(metric: DashboardEntry['metrics'][number], outcome: CallOutcome | undefined, format: DashboardFormat): TileFigure {
  const base = { id: metric.id, label: metric.label, ...(metric.ask ? { ask: metric.ask } : {}) };
  if (!outcome || !outcome.ok) return { ...base, value: '–', tone: 'neutral', ok: false };
  const data = outcome.data as Record<string, unknown> | undefined;
  const all = recordsOf(data);
  const rows = all.filter((record) => passes(record, metric.where, format));
  // A list the tool cut short gives a lower bound for anything counted or added up from it. A count the tool itself gave for the whole
  // search (more tickets than it returned) is exact; a "total" that only repeats how many it returned is not.
  const cut = cutShort(data);
  const filtered = !!metric.where?.length;
  const reported = (data as { total?: unknown } | undefined)?.total;
  const returned = Number((data as { returned?: unknown } | undefined)?.returned ?? all.length);
  const wholeCount = typeof reported === 'number' && (!cut || reported > returned);
  let raw: number;
  if (metric.measure === 'sum') raw = Math.round(rows.reduce((sum, record) => sum + (Number(lookup(record, metric.field!)) || 0), 0) * 100) / 100;
  else raw = !filtered && typeof reported === 'number' ? reported : rows.length;
  const lowerBound = cut && (filtered || metric.measure === 'sum' || !wholeCount);
  const tone = [...(metric.tone ?? [])].sort((a, b) => b.atLeast - a.atLeast).find((rule) => raw >= rule.atLeast)?.tone ?? 'neutral';
  let hint: string | undefined;
  if (metric.hint) {
    const total = rows.reduce((sum, record) => sum + (Number(lookup(record, metric.hint!.field)) || 0), 0);
    hint = metric.hint.text.replace('{value}', formatNumber(Math.round(total * 100) / 100, metric.hint.format, format));
  }
  return { ...base, value: `${formatNumber(raw, metric.format, format)}${lowerBound ? '+' : ''}`, raw, tone, ...(hint ? { hint } : {}), ok: true };
}

/**
 * How many there are in a list: the tool's own count for the whole search when it gave one (more tickets than it returned), else what matched
 * in what it returned, with "at least" when it stopped at its limit. A list taken from inside one record never carries the tool's flags.
 */
function howMany(data: unknown, matching: number, from: string | undefined, filtered: boolean): { total: number; atLeast?: boolean } {
  const body = from ? undefined : (data as { total?: unknown; returned?: unknown; more?: unknown } | undefined);
  const cut = !from && cutShort(data);
  const reported = typeof body?.total === 'number' ? body.total : undefined;
  const whole = !filtered && reported !== undefined && reported > matching && (!cut || reported > Number(body?.returned ?? matching)) ? reported : undefined;
  return { total: whole ?? matching, ...(cut && whole === undefined ? { atLeast: true } : {}) };
}

function sectionView(section: DashboardEntry['sections'][number], outcome: CallOutcome | undefined, format: DashboardFormat): SectionView {
  const base = { id: section.id, title: section.title, ...(section.empty ? { empty: section.empty } : {}), ...(section.more ? { more: section.more } : {}) };
  if (!outcome) return { ...base, state: 'unavailable', rows: [], total: 0 };
  if (!outcome.ok) return { ...base, state: outcome.reason, rows: [], total: 0 };
  const matching = sorted(recordsOf(outcome.data, section.from).filter((record) => passes(record, section.where, format)), section.sort);
  return { ...base, state: 'ok', ...howMany(outcome.data, matching.length, section.from, !!section.where?.length), rows: matching.slice(0, section.limit ?? 5).map((record) => rowView(section.row, record, format)) };
}

/**
 * The tile and the dashboard for one person. `outcomes` holds what each call of `dashboardCalls` gave back (by its key); a call with no
 * outcome counts as unavailable, so a slow system leaves its own number blank and nothing else.
 */
export function buildDashboard(entry: DashboardEntry, outcomes: ReadonlyMap<string, CallOutcome>, context: { format: DashboardFormat; name?: string; now?: Date }): DashboardView {
  let usedName = false;
  const outcomeOf = (source: Source) => {
    const resolved = resolveArgs(source.args, context.name);
    usedName = usedName || resolved.usedName;
    return outcomes.get(callKey(source, resolved.args));
  };
  const metrics = entry.metrics.map((metric) => figure(metric, outcomeOf(metric.source), context.format));
  const sections = entry.sections.map((section) => sectionView(section, outcomeOf(section.source), context.format));
  return {
    title: entry.title,
    ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
    scope: usedName ? 'mine' : 'team',
    ...(usedName && context.name ? { name: context.name } : {}),
    asOf: (context.now ?? new Date()).toISOString(),
    tile: entry.tile.map((id) => metrics.find((m) => m.id === id)!).filter(Boolean),
    metrics,
    sections,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cards in the chat

/**
 * The cards to show for one tool's answer: every card of the person's entry that names this connector and tool and has something to show.
 * Only fields the tool returned are shown, and the wording around them is the pack's, so a card cannot say anything the system did not.
 */
export function recordCardsFor(entry: DashboardEntry, connector: string, tool: string, data: unknown, format: DashboardFormat): RecordsCardState[] {
  const out: RecordsCardState[] = [];
  for (const card of entry.cards) {
    if (card.connector !== connector || card.tool !== tool) continue;
    const matching = sorted(recordsOf(data, card.from).filter((record) => passes(record, card.where, format)), card.sort);
    if (matching.length === 0) continue;
    const rows = matching.slice(0, card.limit ?? 5).map((record) => rowView(card.row, record, format));
    out.push({ heading: card.heading, rows, ...howMany(data, matching.length, card.from, !!card.where?.length), shown: rows.length });
  }
  return out;
}
