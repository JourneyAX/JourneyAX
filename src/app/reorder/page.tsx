'use client';

import { ChangeEvent, CSSProperties, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import styles from './reorder.module.css';

type Phase = 'search' | 'results' | 'team' | 'order' | 'change-selection' | 'size-confirmation' | 'edit' | 'validation' | 'review' | 'completed';
type ChangeArea = 'identity' | 'roster' | 'sizes' | 'quantity' | 'logo' | 'design' | 'garment' | 'delivery';
type CompletionPath = 'direct-reorder' | 'artwork-review';
type ReadinessState = 'ready' | 'attention' | 'blocked';
type ApprovalStatus = 'not-required' | 'required' | 'pending' | 'approved';
type SizeReviewStatus = 'pending' | 'confirmed';
type Size = 'YS' | 'YM' | 'YL' | 'XS' | 'S' | 'M' | 'L' | 'XL' | '2XL' | '3XL';

type RosterEntry = {
  id: string;
  number: string;
  name: string;
  size: Size;
};

type DesignSnapshot = {
  teamName: string;
  primaryColor: string;
  secondaryColor: string;
  logoText: string;
  logoPlacement: 'Center chest' | 'Left chest' | 'Right chest';
  treatment: 'Classic block' | 'Athletic outline' | 'Modern condensed';
  garmentStyle: string;
};

type ReorderRecord = {
  id: string;
  po: string;
  account: string;
  school: string;
  team: string;
  sport?: string;
  dealer?: string;
  season: string;
  approvedAt: string;
  unitPrice: number;
  status: string;
  artOwner: string;
  proofCount: string;
  design: DesignSnapshot;
  roster: RosterEntry[];
};

/**
 * A team is the durable thing; an order is a photograph of it on one day.
 * Orders are grouped on school + sport because those two fields outlive the
 * S number, the coach who placed the order and the dealer who paid for it.
 */
type TeamRecord = {
  key: string;
  school: string;
  sport: string;
  dealer?: string;
  account: string;
  orders: ReorderRecord[];
  seasons: string[];
  totalUnits: number;
  totalValue: number;
};

type ValidationResult = {
  id: string;
  label: string;
  detail: string;
  state: 'pass' | 'attention' | 'fail';
};

type AgentMessage = {
  id: string;
  role: 'agent' | 'user';
  text: string;
};

type BusinessReadiness = {
  availability: { state: ReadinessState; label: string; detail: string; alternative: string };
  commercial: { state: ReadinessState; label: string; detail: string; approval: string };
  artwork: { state: ReadinessState; label: string; detail: string; owner: string };
  delivery: { state: ReadinessState; label: string; detail: string; promise: string };
};

type AuditEvent = {
  id: string;
  label: string;
  detail: string;
};

const SEARCH_STOP_WORDS = new Set([
  'i', 'want', 'need', 'would', 'like', 'to', 'reorder', 'repeat', 'again', 'our', 'my',
  'the', 'a', 'an', 'uniform', 'uniforms', 'kit', 'kits', 'order', 'orders', 'previous',
  'last', 'show', 'find', 'please', 'can', 'you', 'me', 'for', 'from',
]);

const SEARCH_CORRECTIONS: Record<string, string> = {
  wnat: 'want',
  reoder: 'reorder',
  reodr: 'reorder',
  roerder: 'reorder',
  unifrom: 'uniform',
  unifroms: 'uniforms',
  vollyball: 'volleyball',
  volleybal: 'volleyball',
  voleyball: 'volleyball',
  basktball: 'basketball',
  socer: 'soccer',
};

const SIZES: Size[] = ['YS', 'YM', 'YL', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

const COLOR_VALUES: Record<string, string> = {
  black: '#151515',
  white: '#f5f3ec',
  navy: '#142b50',
  blue: '#2457a6',
  royal: '#184fa3',
  red: '#b6242b',
  maroon: '#6f1d2c',
  green: '#245c3a',
  gold: '#d4a72c',
  yellow: '#f2c744',
  orange: '#d96b27',
  purple: '#5a347d',
  silver: '#c5c8ce',
  gray: '#7d8288',
  grey: '#7d8288',
};

const ORIGINAL_ROSTER: RosterEntry[] = [
  { id: 'p2', number: '2', name: 'A. Whitmore', size: 'M' },
  { id: 'p4', number: '4', name: 'J. Castellanos', size: 'S' },
  { id: 'p5', number: '5', name: 'R. Patel', size: 'M' },
  { id: 'p7', number: '7', name: 'K. Nguyen', size: 'L' },
  { id: 'p8', number: '8', name: 'M. Okafor', size: 'M' },
  { id: 'p10', number: '10', name: 'T. Bergstrom', size: 'S' },
  { id: 'p11', number: '11', name: 'S. Delacroix', size: 'M' },
  { id: 'p12', number: '12', name: 'L. Ferreira', size: 'L' },
  { id: 'p14', number: '14', name: 'D. Kaminski', size: 'M' },
  { id: 'p15', number: '15', name: 'B. Osei', size: 'S' },
  { id: 'p18', number: '18', name: 'C. Lindqvist', size: 'M' },
  { id: 'p21', number: '21', name: 'H. Yamamoto', size: 'L' },
];

const ORIGINAL_DESIGN: DesignSnapshot = {
  teamName: 'OSWEGO EAST',
  primaryColor: '#142b50',
  secondaryColor: '#c5c8ce',
  logoText: 'OE',
  logoPlacement: 'Center chest',
  treatment: 'Classic block',
  garmentStyle: '228325 · Lightweight reversible jersey',
};

const ORDERS: ReorderRecord[] = [
  {
    id: 'S482913',
    po: 'OE-VB-2025',
    account: '904188',
    school: 'Oswego East High School',
    team: 'Girls’ Volleyball',
    season: 'Spring 2025',
    approvedAt: 'March 18, 2025',
    unitPrice: 70.5,
    status: 'Completed · approved for repeat',
    artOwner: 'Gabriel Martin',
    proofCount: '1 proof · approved first pass',
    design: ORIGINAL_DESIGN,
    roster: ORIGINAL_ROSTER,
  },
  {
    id: 'S482915',
    po: 'OE-VB-WARMUP-25',
    account: '904188',
    school: 'Oswego East High School',
    team: 'Girls’ Volleyball warm-ups',
    season: 'Spring 2025',
    approvedAt: 'March 20, 2025',
    unitPrice: 50,
    status: 'Completed · approved for repeat',
    artOwner: 'Gabriel Martin',
    proofCount: '1 proof · approved',
    design: { ...ORIGINAL_DESIGN, teamName: 'WOLVES', garmentStyle: 'R20CSM · Performance warm-up top' },
    roster: ORIGINAL_ROSTER,
  },
];

/** The signed-in coach, as resolved by /api/coach/me. */
type CoachViewer = {
  name: string;
  role: string;
  schools: string[];
};

/**
 * Narrow records to the coach's own schools.
 *
 * This is now a DISPLAY filter, not the security boundary — /api/reorder-orders
 * already scoped the response server-side via filterOrdersForViewer, which is
 * the check that actually matters. This is belt and braces.
 *
 * The previous version fell back to `records[0].school` when the coach's own
 * school had no orders, which meant a coach with no history was shown some
 * OTHER school's orders. Returning nothing is the correct answer to "you have
 * no orders".
 */
function scopeOrdersForCoach(records: ReorderRecord[], schools: string[]) {
  if (!records.length || !schools.length) return [];
  const allowed = new Set(schools.map((s) => s.trim().toLowerCase()));
  return records.filter((record) => allowed.has(record.school.trim().toLowerCase()));
}

const CHANGE_AREAS: Array<{ id: ChangeArea; title: string; detail: string; icon: string }> = [
  { id: 'identity', title: 'Names & numbers', detail: 'Correct or replace player personalization.', icon: '24' },
  { id: 'roster', title: 'Roster', detail: 'Add new players or remove returning players.', icon: '+1' },
  { id: 'sizes', title: 'Sizes', detail: 'Update sizes without touching the approved art.', icon: 'M' },
  { id: 'quantity', title: 'Quantities', detail: 'Repeat or adjust unit counts.', icon: '×' },
  { id: 'logo', title: 'Logo or artwork', detail: 'Replace the logo and route it for proofing.', icon: '◆' },
  { id: 'design', title: 'Colors & design', detail: 'Adjust colors, placement or number treatment.', icon: '◐' },
  { id: 'garment', title: 'Garment style', detail: 'Move the approved look to another style.', icon: '▱' },
  { id: 'delivery', title: 'Delivery notes', detail: 'Add timing or destination instructions.', icon: '→' },
];

function cloneRoster(roster: RosterEntry[]) {
  return roster.map((entry) => ({ ...entry }));
}

function getBusinessReadiness(order: ReorderRecord, roster: RosterEntry[], artChange: boolean, unavailableScenario: boolean, alternativeAccepted: boolean, approvalStatus: ApprovalStatus, deliveryCommitment: BusinessReadiness['delivery']): BusinessReadiness {
  const requiredSizes = [...new Set(roster.map((entry) => entry.size))];
  const styleCode = order.design.garmentStyle.split(' · ')[0];
  return {
    availability: {
      state: unavailableScenario && !alternativeAccepted ? 'blocked' : 'ready',
      label: unavailableScenario
        ? alternativeAccepted ? 'Compatible alternative accepted' : `${styleCode} was retired after last season`
        : `${roster.length} units reserved in the POC`,
      detail: unavailableScenario
        ? alternativeAccepted
          ? `Style 228326 covers ${requiredSizes.join(', ')} and can carry forward the approved colors, logo and personalization.`
          : 'The previous style is discontinued, so JourneyAX compared the current catalog instead of ending the journey.'
        : `${styleCode} is available across ${requiredSizes.join(', ')}. JourneyAX checked every requested size.`,
      alternative: unavailableScenario
        ? alternativeAccepted ? 'Selected: 228326 · same category, fabric family and athletic fit.' : 'Recommended: style 228326 · same category, fabric family and athletic fit.'
        : 'If stock changes: preserve the design on compatible style 228326.',
    },
    commercial: {
      state: alternativeAccepted && approvalStatus !== 'approved' ? 'attention' : 'ready',
      label: alternativeAccepted
        ? approvalStatus === 'approved' ? 'Price increase approved' : approvalStatus === 'pending' ? 'Approval request is pending' : 'Price changed—approval required'
        : 'Contract price and PO matched',
      detail: alternativeAccepted
        ? `$${order.unitPrice.toFixed(2)} → $${(order.unitPrice + 3).toFixed(2)} per unit. The compatible style adds $${(roster.length * 3).toFixed(2)} to this ${roster.length}-unit order.`
        : `$${order.unitPrice.toFixed(2)} per unit comes from the recovered school order, not a newly guessed price.`,
      approval: alternativeAccepted
        ? approvalStatus === 'approved' ? `Approved by Dana Brooks · Athletic Director · PO ${order.po} updated.` : `Coach may approve increases up to $25.00 · this change adds $${(roster.length * 3).toFixed(2)}.`
        : `PO ${order.po} · Coach Ramirez is authorized for this prototype order.`,
    },
    artwork: {
      state: artChange ? 'attention' : 'ready',
      label: artChange ? 'New proof approval required' : 'Approved proof can be reused',
      detail: artChange ? 'Only the changed artwork is packaged with the approved design for comparison.' : 'Logo, colors, placement and garment match the approved production file.',
      owner: artChange ? `${order.artOwner} · art-team review` : `${order.artOwner} · no new art work`,
    },
    delivery: deliveryCommitment,
  };
}

function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string) {
  return Math.round((new Date(`${end}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime()) / 86400000);
}

function displayDate(date: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

function normalizeCommandLanguage(input: string) {
  const corrections: Record<string, string> = {
    ...SEARCH_CORRECTIONS,
    changew: 'change',
    chnage: 'change',
    chage: 'change',
    cahange: 'change',
    replacw: 'replace',
    replce: 'replace',
    remvoe: 'remove',
    udpate: 'update',
    siez: 'size',
    nmae: 'name',
    numbr: 'number',
    jersy: 'jersey',
    plyer: 'player',
    colur: 'color',
    logoo: 'logo',
  };
  return input.replace(/\b[a-z]+\b/gi, (word) => corrections[word.toLowerCase()] ?? word);
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function fuzzyTokenMatch(term: string, candidate: string) {
  if (candidate.includes(term) || term.includes(candidate)) return true;
  if (/\d/.test(term)) return false;
  const tolerance = term.length >= 8 ? 2 : term.length >= 5 ? 1 : 0;
  return tolerance > 0 && editDistance(term, candidate) <= tolerance;
}

function findMatchingOrders(query: string, records: ReorderRecord[]) {
  const normalized = normalizeCommandLanguage(query).toLowerCase().replace(/[’']/g, '');
  const terms = normalized
    .split(/[^a-z0-9#-]+/)
    .map((term) => SEARCH_CORRECTIONS[term] ?? term)
    .filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term));
  if (!terms.length) return records;

  return records.filter((record) => {
    const candidates = `${record.id} ${record.po} ${record.account} ${record.school} ${record.team} ${record.season}`
      .toLowerCase()
      .replace(/[’']/g, '')
      .split(/[^a-z0-9#-]+/)
      .filter(Boolean);
    return terms.every((term) => candidates.some((candidate) => fuzzyTokenMatch(term, candidate)));
  });
}

/**
 * Derive the sport when COMS did not supply one, so grouping still works on
 * the local fallback records. "Girls' Volleyball warm-ups" and "Girls'
 * Volleyball" must land on the same team, otherwise the kit splits apart.
 */
function deriveSport(record: ReorderRecord) {
  if (record.sport?.trim()) return record.sport.trim();
  return record.team
    .replace(/\b(?:warm[-\s]?ups?|jerseys?|shorts?|tops?|bags?|uniforms?)\b/gi, '')
    .replace(/\b(?:girls|boys|mens|womens|men|women|varsity|jv|junior|senior)\b/gi, '')
    .replace(/[’']s?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim() || record.team;
}

function buildTeamRecords(records: ReorderRecord[]): TeamRecord[] {
  const groups = new Map<string, TeamRecord>();
  for (const record of records) {
    const sport = deriveSport(record);
    const dealer = record.dealer ?? (record.school.toLowerCase().includes('oswego east') ? 'Cloud 9 Sports' : undefined);
    const key = `${record.school.toLowerCase()}::${sport.toLowerCase()}`;
    const existing = groups.get(key);
    const units = record.roster.length;
    if (existing) {
      existing.orders.push(record);
      existing.totalUnits += units;
      existing.totalValue += units * record.unitPrice;
      if (!existing.seasons.includes(record.season)) existing.seasons.push(record.season);
      if (!existing.dealer && dealer) existing.dealer = dealer;
    } else {
      groups.set(key, {
        key,
        school: record.school,
        sport,
        dealer,
        account: record.account,
        orders: [record],
        seasons: [record.season],
        totalUnits: units,
        totalValue: units * record.unitPrice,
      });
    }
  }
  return [...groups.values()];
}

function formatEnteredName(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== trimmed.toLowerCase()) return trimmed;
  return trimmed.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function JerseyPreview({ design, number, name, logoUrl, muted = false, changed = false }: {
  design: DesignSnapshot;
  number: string;
  name: string;
  logoUrl?: string | null;
  muted?: boolean;
  changed?: boolean;
}) {
  const jerseyStyle = {
    '--jersey-primary': design.primaryColor,
    '--jersey-secondary': design.secondaryColor,
  } as CSSProperties;

  return (
    <div className={`${styles.jerseyFrame} ${muted ? styles.jerseyMuted : ''} ${changed ? styles.jerseyChanged : ''}`}>
      <div className={styles.jersey} style={jerseyStyle}>
        <span className={styles.jerseyTeam}>{design.teamName}</span>
        {logoUrl ? <Image unoptimized width={38} height={30} className={styles.jerseyLogoImage} src={logoUrl} alt="Locally previewed replacement team logo" /> : <span className={styles.jerseyLogo}>{design.logoText}</span>}
        <strong>{number}</strong>
        <span className={styles.jerseyName}>{name}</span>
      </div>
    </div>
  );
}

function ReorderWorkspace({ viewer }: { viewer: CoachViewer }) {
  const coachName = viewer.name;
  const coachSchools = viewer.schools;
  const primarySchool = viewer.schools[0] ?? '';
  const [orders, setOrders] = useState<ReorderRecord[]>(ORDERS);
  const [matchedOrders, setMatchedOrders] = useState<ReorderRecord[]>(() => scopeOrdersForCoach(ORDERS, coachSchools));
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [dataSource, setDataSource] = useState<'mongodb' | 'snapshot' | 'fallback'>('fallback');
  const [phase, setPhase] = useState<Phase>('search');
  const [query, setQuery] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<ReorderRecord | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<TeamRecord | null>(null);
  const [kitSelection, setKitSelection] = useState<string[]>([]);
  const [selectedAreas, setSelectedAreas] = useState<ChangeArea[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>(cloneRoster(ORIGINAL_ROSTER));
  const [design, setDesign] = useState<DesignSnapshot>({ ...ORIGINAL_DESIGN });
  const [rosterHistory, setRosterHistory] = useState<RosterEntry[][]>([]);
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [command, setCommand] = useState('');
  const [messages, setMessages] = useState<AgentMessage[]>([
    { id: 'welcome', role: 'agent', text: `Welcome back, ${coachName}. Tell me what you want to reorder. I’ll search only your school’s approved orders and protect everything you do not want to change.` },
  ]);
  const [confirmed, setConfirmed] = useState(false);
  const [completionPath, setCompletionPath] = useState<CompletionPath | null>(null);
  const [statusMessage, setStatusMessage] = useState('Ready to find an approved order.');
  const [accessOpen, setAccessOpen] = useState(false);
  const [handoffPrepared, setHandoffPrepared] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([
    { id: 'access', label: 'Access verified', detail: `${coachName} · ${primarySchool}` },
  ]);
  const [analyticsEvents, setAnalyticsEvents] = useState<string[]>(['reorder_session_started']);
  const [unavailableScenario, setUnavailableScenario] = useState(false);
  const [alternativeAccepted, setAlternativeAccepted] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState<ApprovalStatus>('not-required');
  const [sizeReviewStatus, setSizeReviewStatus] = useState<SizeReviewStatus>('pending');
  const [firstGameDate, setFirstGameDate] = useState('2026-08-22');
  const [expeditedDelivery, setExpeditedDelivery] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const coachOrders = useMemo(() => scopeOrdersForCoach(orders, coachSchools), [orders, coachSchools]);
  const authorizedSchool = coachOrders[0]?.school ?? primarySchool;
  const order = selectedOrder ?? coachOrders[0] ?? ORDERS[0];
  const originalRoster = order.roster;
  const staleSizeEntries = roster.filter((entry) => originalRoster.some((original) => original.id === entry.id)).slice(0, 3);
  const originalDesign = order.design;
  const referenceDigits = order.id.replace(/\D/g, '').slice(-6) || '000001';
  const reorderReference = `JAX-R-${referenceDigits}-26`;
  const artworkReference = `ART-${referenceDigits}`;

  useEffect(() => {
    let active = true;
    const loadOrders = async () => {
      try {
        const endpoints = ['/api/reorder-orders'];
        let payload: { records?: ReorderRecord[]; source?: 'mongodb' | 'snapshot' } | null = null;
        let unauthorized = false;
        for (const endpoint of endpoints) {
          try {
            const response = await fetch(endpoint, { cache: 'no-store' });
            if (response.status === 401 || response.status === 403) { unauthorized = true; break; }
            if (!response.ok) continue;
            payload = await response.json() as { records?: ReorderRecord[]; source?: 'mongodb' | 'snapshot' };
            if (payload.records?.length) break;
          } catch {
            continue;
          }
        }
        // A 401/403 means "not authorized", not "transport failed". Falling
        // back to local sample data here is what made the access check
        // cosmetic — a signed-out visitor saw a full reorder screen.
        if (unauthorized) throw new Error('UNAUTHORIZED');
        if (!payload?.records?.length) throw new Error('No demo orders found');
        if (!active) return;
        const authorizedOrders = scopeOrdersForCoach(payload.records, coachSchools);
        setOrders(payload.records);
        setMatchedOrders(authorizedOrders);
        setDataSource(payload.source === 'mongodb' ? 'mongodb' : 'snapshot');
        setStatusMessage(`${authorizedOrders.length} authorized ${authorizedOrders.length === 1 ? 'order' : 'orders'} ready for ${authorizedOrders[0]?.school ?? primarySchool}.`);
      } catch (err) {
        if (!active) return;
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          // Show nothing rather than sample data. The gate below will have
          // sent them to /reorder/access already; this is the belt to that
          // pair of braces.
          setOrders([]);
          setMatchedOrders([]);
          setDataSource('fallback');
          setStatusMessage('Your access has expired. Open your private link again.');
          return;
        }
        const authorizedOrders = scopeOrdersForCoach(ORDERS, coachSchools);
        setOrders(ORDERS);
        setMatchedOrders(authorizedOrders);
        setDataSource('fallback');
        setStatusMessage('Using the local demonstration order history.');
      } finally {
        if (active) setOrdersLoading(false);
      }
    };
    void loadOrders();
    return () => { active = false; };
  }, [coachSchools, primarySchool]);
  const teamRecords = useMemo(() => buildTeamRecords(matchedOrders), [matchedOrders]);

  /** Kit items the coach kept ticked, other than the one being edited. */
  const kitCompanions = useMemo(() => {
    if (!selectedTeam || !selectedOrder) return [];
    return selectedTeam.orders.filter((item) => item.id !== selectedOrder.id && kitSelection.includes(item.id));
  }, [kitSelection, selectedOrder, selectedTeam]);

  const kitCompanionUnits = kitCompanions.reduce((sum, item) => sum + item.roster.length, 0);
  const kitCompanionValue = kitCompanions.reduce((sum, item) => sum + item.roster.length * item.unitPrice, 0);

  const artChange = selectedAreas.some((area) => ['logo', 'design', 'garment'].includes(area)) && (
    Boolean(logoUrl) ||
    design.teamName !== originalDesign.teamName ||
    design.primaryColor !== originalDesign.primaryColor ||
    design.secondaryColor !== originalDesign.secondaryColor ||
    design.logoPlacement !== originalDesign.logoPlacement ||
    design.treatment !== originalDesign.treatment ||
    design.garmentStyle !== originalDesign.garmentStyle
  );

  const matchingPromise = useMemo(() => {
    const garmentMatches = design.garmentStyle === originalDesign.garmentStyle;
    const colorsMatch = design.primaryColor === originalDesign.primaryColor && design.secondaryColor === originalDesign.secondaryColor;
    const artworkMatches = !logoUrl && design.teamName === originalDesign.teamName && design.logoPlacement === originalDesign.logoPlacement && design.treatment === originalDesign.treatment;
    const exact = garmentMatches && colorsMatch && artworkMatches;
    return {
      exact,
      title: exact ? 'These units will match the existing team uniforms.' : 'A match cannot be promised until the changed proof is approved.',
      detail: exact
        ? `Same ${originalDesign.garmentStyle.split(' · ')[0]} style, same approved colorway and same ${originalDesign.logoText} artwork as ${order.id}.`
        : 'JourneyAX identified a garment or artwork difference. The existing roster remains protected, but production must confirm the visual match.',
      checks: [
        { label: 'Garment style', value: garmentMatches ? originalDesign.garmentStyle.split(' · ')[0] : 'Changed', matches: garmentMatches },
        { label: 'Team colorway', value: colorsMatch ? 'Approved colors reused' : 'Changed', matches: colorsMatch },
        { label: 'Artwork & placement', value: artworkMatches ? `${originalDesign.logoText} · ${originalDesign.logoPlacement}` : 'Changed', matches: artworkMatches },
      ],
    };
  }, [design, logoUrl, order.id, originalDesign]);

  const validationResults = useMemo<ValidationResult[]>(() => {
    const numbers = roster.map((entry) => entry.number.trim()).filter(Boolean);
    const duplicateNumbers = numbers.filter((number, index) => numbers.indexOf(number) !== index);
    const incomplete = roster.filter((entry) => !entry.name.trim() || !entry.number.trim() || !entry.size);
    return [
      { id: 'style', label: unavailableScenario ? alternativeAccepted ? 'Compatible substitute accepted' : 'Previous style is discontinued' : 'Style available', detail: unavailableScenario ? alternativeAccepted ? 'Style 228326 matches the category, fabric family and fit while covering every required size.' : 'Accept the recommended substitute before continuing.' : `${design.garmentStyle.split(' · ')[0]} is current and reorderable.`, state: unavailableScenario ? alternativeAccepted ? 'pass' : 'fail' : 'pass' },
      { id: 'commercial', label: alternativeAccepted ? approvalStatus === 'approved' ? 'Price and school approval confirmed' : 'School approval required' : 'Price and PO confirmed', detail: alternativeAccepted ? approvalStatus === 'approved' ? `Dana Brooks approved the $${(roster.length * 3).toFixed(2)} increase and updated the PO.` : 'The compatible style exceeds the coach’s prototype approval limit.' : `Recovered contract price and PO ${order.po} match.`, state: alternativeAccepted ? approvalStatus === 'approved' ? 'pass' : 'fail' : 'pass' },
      { id: 'sizes-current', label: sizeReviewStatus === 'confirmed' ? 'Player sizes reconfirmed' : 'Old sizes need confirmation', detail: sizeReviewStatus === 'confirmed' ? 'Coach Ramirez confirmed the carried-forward sizes for this reorder.' : `${staleSizeEntries.length} player sizes have not been confirmed since last season.`, state: sizeReviewStatus === 'confirmed' ? 'pass' : 'fail' },
      { id: 'roster', label: 'Roster complete', detail: incomplete.length ? `${incomplete.length} player row${incomplete.length === 1 ? '' : 's'} need attention.` : `All ${roster.length} player rows are complete.`, state: incomplete.length ? 'fail' : 'pass' },
      { id: 'numbers', label: 'Jersey numbers unique', detail: duplicateNumbers.length ? `Duplicate number: ${duplicateNumbers[0]}.` : 'No duplicate jersey numbers found.', state: duplicateNumbers.length ? 'fail' : 'pass' },
      { id: 'art', label: artChange ? 'New proof required' : 'Approved proof reusable', detail: artChange ? 'JourneyAX will package the proposed design for artwork review.' : 'Logo, colors, garment and placement match the approved proof.', state: artChange ? 'attention' : 'pass' },
      { id: 'match', label: matchingPromise.exact ? 'Matching promise supported' : 'Matching promise requires proof', detail: matchingPromise.detail, state: matchingPromise.exact ? 'pass' : 'attention' },
      { id: 'preserved', label: 'Preserved fields protected', detail: 'Unselected order properties remain locked to the approved order.', state: 'pass' },
    ];
  }, [alternativeAccepted, approvalStatus, artChange, design.garmentStyle, matchingPromise, order.po, roster, sizeReviewStatus, staleSizeEntries.length, unavailableScenario]);

  const effectiveUnitPrice = order.unitPrice + (alternativeAccepted ? 3 : 0);
  const priceIncrease = alternativeAccepted ? roster.length * 3 : 0;
  const primaryTotal = roster.length * effectiveUnitPrice;
  const total = primaryTotal + kitCompanionValue;
  const deliveryCommitment = useMemo<BusinessReadiness['delivery']>(() => {
    const waitingForApproval = alternativeAccepted && approvalStatus !== 'approved';
    const productionDays = (alternativeAccepted ? 5 : artChange ? 4 : 0) - (expeditedDelivery ? 2 : 0);
    const shipDate = addCalendarDays('2026-08-15', Math.max(0, productionDays));
    const arrivalDate = addCalendarDays(shipDate, 3);
    const bufferDays = daysBetween(arrivalDate, firstGameDate);
    if (waitingForApproval) return {
      state: 'blocked',
      label: 'Delivery promise is waiting on approval',
      detail: 'JourneyAX will recalculate the committed date immediately after the school approves the price change.',
      promise: `Provisional arrival: ${displayDate(arrivalDate)} · first game: ${displayDate(firstGameDate)}`,
    };
    if (bufferDays < 0) return {
      state: 'blocked',
      label: `Current plan misses the first game by ${Math.abs(bufferDays)} day${Math.abs(bufferDays) === 1 ? '' : 's'}`,
      detail: `Simulated production rules produce a ${displayDate(shipDate)} ship date and ${displayDate(arrivalDate)} arrival.`,
      promise: `First game: ${displayDate(firstGameDate)} · choose expedited production or another product.`,
    };
    return {
      state: bufferDays < 2 ? 'attention' : 'ready',
      label: bufferDays === 0 ? 'Arrives on game day—no safety buffer' : `Arrives ${bufferDays} day${bufferDays === 1 ? '' : 's'} before the first game`,
      detail: `Commits to ship ${displayDate(shipDate)} and arrive ${displayDate(arrivalDate)} using the simulated stock, proof and production rules.`,
      promise: `First game: ${displayDate(firstGameDate)}${expeditedDelivery ? ' · expedited production selected' : ''}`,
    };
  }, [alternativeAccepted, approvalStatus, artChange, expeditedDelivery, firstGameDate]);
  const businessReadiness = useMemo(
    () => getBusinessReadiness(order, roster, artChange, unavailableScenario, alternativeAccepted, approvalStatus, deliveryCommitment),
    [alternativeAccepted, approvalStatus, artChange, deliveryCommitment, order, roster, unavailableScenario],
  );
  const hasBlockingErrors = validationResults.some((result) => result.state === 'fail') || deliveryCommitment.state === 'blocked' || roster.length === 0 || (alternativeAccepted && approvalStatus !== 'approved');

  const recordAudit = (label: string, detail: string) => {
    setAuditEvents((current) => [...current, { id: `${Date.now()}-${current.length}`, label, detail }]);
  };

  const track = (event: string) => {
    setAnalyticsEvents((current) => [...current, event]);
  };

  const confirmCarriedSizes = () => {
    setSizeReviewStatus('confirmed');
    setStatusMessage(`${staleSizeEntries.length} carried-forward sizes confirmed for this reorder.`);
    addMessage('agent', `Confirmed. I kept the existing sizes for ${staleSizeEntries.length} returning players and recorded that you reviewed them today.`);
    recordAudit('Stale sizes confirmed', `${staleSizeEntries.length} returning players · Coach Ramirez`);
    track('reorder_stale_sizes_confirmed');
    setPhase('edit');
  };

  const reviewStaleSizes = () => {
    setSelectedAreas((current) => current.includes('sizes') ? current : [...current, 'sizes']);
    setStatusMessage('Only player sizes are unlocked for review.');
    addMessage('agent', 'I unlocked the size column. Update anyone who grew, then confirm the reviewed sizes. Names, numbers and approved artwork remain protected.');
    track('reorder_stale_sizes_review_started');
    setPhase('edit');
  };

  const chooseExpeditedDelivery = () => {
    setExpeditedDelivery(true);
    setStatusMessage('Expedited production selected. Delivery promise recalculated.');
    addMessage('agent', `I applied the simulated expedited production rule and recalculated the ship and arrival dates against the ${displayDate(firstGameDate)} first game. No roster or artwork details were changed.`);
    recordAudit('Delivery option changed', `Expedited production · first game ${displayDate(firstGameDate)}`);
    track('reorder_expedited_delivery_selected');
  };

  const startUnavailableScenario = () => {
    setUnavailableScenario(true);
    setAlternativeAccepted(false);
    setStatusMessage('Discontinued style detected. A compatible alternative is available.');
    addMessage('agent', `${order.design.garmentStyle.split(' · ')[0]} was retired after last season. I compared the current catalog and found style 228326: the same jersey category, fabric family and athletic fit, with every roster size available.`);
    recordAudit('Discontinued style detected', `${order.design.garmentStyle.split(' · ')[0]} retired · replacement search started`);
    track('reorder_availability_exception_viewed');
  };

  const acceptAlternative = () => {
    setRosterHistory((current) => [...current, cloneRoster(roster)]);
    setAlternativeAccepted(true);
    setApprovalStatus('required');
    setSelectedAreas((current) => current.includes('garment') ? current : [...current, 'garment']);
    setDesign((current) => ({ ...current, garmentStyle: '228326 · Compatible performance jersey' }));
    setStatusMessage('Compatible style 228326 selected for the complete roster.');
    addMessage('agent', 'Style 228326 is selected. I preserved the roster, names, numbers, sizes, colors and logo. Because the garment changed, JourneyAX will request a focused proof confirmation.');
    recordAudit('Compatible alternative accepted', '228326 · full roster coverage');
    track('reorder_compatible_alternative_accepted');
  };

  const requestApproval = () => {
    setApprovalStatus('pending');
    setStatusMessage('Simulated approval request sent to the athletic director.');
    addMessage('agent', `The compatible style adds $${priceIncrease.toFixed(2)}. That exceeds your $25 price-adjustment authority, so I sent Dana Brooks the comparison, PO and reason for the substitution. Your reorder stays intact while we wait.`);
    recordAudit('School approval requested', `Dana Brooks · $${priceIncrease.toFixed(2)} increase · PO ${order.po}`);
    track('reorder_school_approval_requested');
  };

  const approvePriceChange = () => {
    setApprovalStatus('approved');
    setStatusMessage('Price increase approved. The reorder can continue.');
    addMessage('agent', `Dana Brooks approved the $${priceIncrease.toFixed(2)} increase and updated PO ${order.po}. You can continue this same reorder—nothing needs to be entered again.`);
    recordAudit('Price increase approved', `Dana Brooks · revised total $${total.toFixed(2)}`);
    track('reorder_school_approval_completed');
  };

  const changedItems = useMemo(() => {
    const changes: string[] = [];
    const originalById = new Map(originalRoster.map((entry) => [entry.id, entry]));
    roster.forEach((entry) => {
      const original = originalById.get(entry.id);
      if (!original) changes.push(`Added ${entry.name || 'new player'} · #${entry.number || '—'} · ${entry.size}`);
      else {
        const parts: string[] = [];
        if (entry.name !== original.name) parts.push(`${original.name} → ${entry.name}`);
        if (entry.number !== original.number) parts.push(`#${original.number} → #${entry.number}`);
        if (entry.size !== original.size) parts.push(`${original.size} → ${entry.size}`);
        if (parts.length) changes.push(parts.join(' · '));
      }
    });
    originalRoster.filter((entry) => !roster.some((current) => current.id === entry.id)).forEach((entry) => changes.push(`Removed ${entry.name} · #${entry.number}`));
    if (logoUrl) changes.push('Replacement logo added for artwork review');
    if (design.primaryColor !== originalDesign.primaryColor || design.secondaryColor !== originalDesign.secondaryColor) changes.push('Uniform colors updated');
    if (design.teamName !== originalDesign.teamName) changes.push(`Team wordmark: ${originalDesign.teamName} → ${design.teamName}`);
    if (design.logoPlacement !== originalDesign.logoPlacement) changes.push(`Logo placement: ${originalDesign.logoPlacement} → ${design.logoPlacement}`);
    if (design.treatment !== originalDesign.treatment) changes.push(`Name and number treatment: ${design.treatment}`);
    if (design.garmentStyle !== originalDesign.garmentStyle) changes.push(`Garment style changed to ${design.garmentStyle}`);
    if (deliveryNotes.trim()) changes.push(`Delivery note: ${deliveryNotes.trim()}`);
    return changes;
  }, [deliveryNotes, design, logoUrl, originalDesign, originalRoster, roster]);

  const preservedItems = useMemo(() => {
    const preserved: string[] = [];
    if (!selectedAreas.includes('logo') || !logoUrl) preserved.push(`Approved ${originalDesign.logoText} logo`);
    if (!selectedAreas.includes('design') || (design.primaryColor === originalDesign.primaryColor && design.secondaryColor === originalDesign.secondaryColor)) preserved.push('Approved uniform colorway');
    if (!selectedAreas.includes('garment') || design.garmentStyle === originalDesign.garmentStyle) preserved.push(originalDesign.garmentStyle);
    if (!selectedAreas.includes('sizes')) preserved.push('All approved player sizes');
    if (!selectedAreas.includes('delivery')) preserved.push('Account and delivery destination');
    preserved.push('Approved pricing basis', 'Production-ready artwork history');
    return preserved;
  }, [design, logoUrl, originalDesign, selectedAreas]);

  const addMessage = (role: AgentMessage['role'], text: string) => {
    setMessages((current) => [...current, { id: `${role}-${Date.now()}-${current.length}`, role, text }]);
  };

  const runSearch = (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    runCommand(query);
  };

  const chooseTeam = (team: TeamRecord) => {
    setSelectedTeam(team);
    setKitSelection(team.orders.map((item) => item.id));
    setPhase('team');
    const itemCount = team.orders.length;
    setStatusMessage(`${team.school} · ${team.sport} — ${itemCount} item${itemCount === 1 ? '' : 's'} in this team's kit.`);
    addMessage('agent', `I found ${team.school} ${team.sport}. This team has ${itemCount} approved item${itemCount === 1 ? '' : 's'} on file${team.dealer ? `, ordered through ${team.dealer}` : ''}. Untick anything you do not need this season.`);
    recordAudit('Team record opened', `${team.school} · ${team.sport} · ${itemCount} item${itemCount === 1 ? '' : 's'}`);
    track('reorder_team_selected');
  };

  const toggleKitItem = (id: string) => {
    setKitSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const chooseOrder = (record: ReorderRecord, companions: ReorderRecord[] = []) => {
    setSelectedOrder(record);
    setRoster(cloneRoster(record.roster));
    setDesign({ ...record.design });
    setSizeReviewStatus('pending');
    setFirstGameDate('2026-08-22');
    setExpeditedDelivery(false);
    setPhase('order');
    setStatusMessage(`${record.id} recovered with approved roster and artwork.`);
    const kitNote = companions.length
      ? ` I am carrying ${companions.length} more kit item${companions.length === 1 ? '' : 's'} (${companions.map((item) => item.id).join(', ')}) through the same reorder.`
      : '';
    addMessage('agent', `I found ${record.id}. The approved design, logo, colors and ${record.roster.length}-player roster are ready to reuse.${kitNote}`);
    recordAudit('Approved order recovered', `${record.id} · ${record.school}`);
    track('reorder_order_selected');
  };

  /** The ticked kit becomes the reorder; the first item drives the edit flow. */
  const startKitReorder = () => {
    if (!selectedTeam) return;
    const chosen = selectedTeam.orders.filter((item) => kitSelection.includes(item.id));
    if (!chosen.length) {
      setStatusMessage('Keep at least one item to reorder.');
      return;
    }
    const [primary, ...companions] = chosen;
    chooseOrder(primary, companions);
  };

  const toggleArea = (area: ChangeArea) => {
    setSelectedAreas((current) => current.includes(area) ? current.filter((item) => item !== area) : [...current, area]);
  };

  const setQuickScope = (areas: ChangeArea[], message: string) => {
    setSelectedAreas(areas);
    setStatusMessage(message);
  };

  const commitRoster = (next: RosterEntry[], message: string) => {
    setRosterHistory((current) => [...current, cloneRoster(roster)]);
    setRoster(next);
    setStatusMessage(message);
  };

  const updateRosterEntry = (id: string, key: 'name' | 'number' | 'size', value: string) => {
    setRoster((current) => current.map((entry) => entry.id === id ? { ...entry, [key]: value } as RosterEntry : entry));
  };

  const undoRoster = () => {
    const previous = rosterHistory.at(-1);
    if (!previous) return;
    setRoster(cloneRoster(previous));
    setRosterHistory((current) => current.slice(0, -1));
    setStatusMessage('Last roster change undone.');
  };

  const resetRoster = () => {
    commitRoster(cloneRoster(originalRoster), 'Approved roster restored.');
  };

  const addPlayer = () => {
    const next = [...roster, { id: `new-${Date.now()}`, number: '', name: '', size: 'M' as Size }];
    commitRoster(next, 'New roster row added.');
  };

  const removePlayer = (id: string) => {
    const player = roster.find((entry) => entry.id === id);
    commitRoster(roster.filter((entry) => entry.id !== id), `${player?.name ?? 'Player'} removed from the proposed roster.`);
  };

  const applyBulkRoster = () => {
    const parsed = bulkText.split(/\r?\n/).map((line, index) => {
      const [name = '', number = '', size = 'M'] = line.split(/[\t,]/).map((value) => value.trim());
      const safeSize = SIZES.includes(size as Size) ? size as Size : 'M';
      return { id: `paste-${Date.now()}-${index}`, name, number, size: safeSize };
    }).filter((entry) => entry.name || entry.number);
    if (!parsed.length) {
      setStatusMessage('Paste at least one player row using name, number, size.');
      return;
    }
    commitRoster([...roster, ...parsed], `${parsed.length} player${parsed.length === 1 ? '' : 's'} added from the pasted roster.`);
    setBulkText('');
    setBulkOpen(false);
  };

  const handleLogo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setStatusMessage('Choose an image file for the replacement logo.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setLogoUrl(typeof reader.result === 'string' ? reader.result : null);
      setSelectedAreas((current) => current.includes('logo') ? current : [...current, 'logo']);
      setStatusMessage(`${file.name} is previewed locally. Nothing has been uploaded.`);
      addMessage('agent', 'I placed the replacement logo on the proposed jersey. Because artwork changed, I’ll route this version for proof approval.');
    };
    reader.readAsDataURL(file);
  };

  const runCommand = (input: string) => {
    const originalInput = input.trim();
    if (!originalInput) return;
    const clean = normalizeCommandLanguage(originalInput);
    const normalized = clean.toLowerCase();
    addMessage('user', originalInput);
    setCommand('');

    if (phase === 'search' || phase === 'results' || phase === 'team') {
      const matches = findMatchingOrders(clean, coachOrders);
      setQuery(clean);
      if (matches.length) {
        setMatchedOrders(matches);
        setPhase('results');
        setStatusMessage(`${matches.length} approved order${matches.length === 1 ? '' : 's'} found.`);
        addMessage('agent', `I found ${matches.length} approved order${matches.length === 1 ? '' : 's'} matching “${clean}.” Choose the one you want to repeat.`);
      } else {
        setMatchedOrders([]);
        setStatusMessage('No matching approved order found.');
        addMessage('agent', `I understood that you want to find a previous order, but I could not confidently match it to this coach’s approved history. Describe the team or season in your own words—spelling does not have to be perfect.`);
      }
      return;
    }

    if (!selectedOrder) {
      addMessage('agent', 'First choose an approved order. Then I can safely apply changes to that exact roster and design.');
      return;
    }

    let nextRoster = cloneRoster(roster);
    let nextDesign = { ...design };
    let nextAreas = [...selectedAreas];
    let nextDeliveryNotes = deliveryNotes;
    let rosterChanged = false;
    let designChanged = false;
    let deliveryChanged = false;
    let recognized = false;
    let needsLogoFile = false;
    const confirmations: string[] = [];
    if (clean !== originalInput) confirmations.push('I corrected a likely typing error');
    const addArea = (area: ChangeArea) => {
      if (!nextAreas.includes(area)) nextAreas.push(area);
    };
    const removeArea = (area: ChangeArea) => {
      nextAreas = nextAreas.filter((item) => item !== area);
    };
    const sizeFrom = (value?: string) => {
      const candidate = value?.toUpperCase().replace(/\s+/g, '') as Size | undefined;
      return candidate && SIZES.includes(candidate) ? candidate : null;
    };
    const playerIndexByNumber = (number: string) => nextRoster.findIndex((entry) => entry.number === number);
    const playerIndexByName = (name: string) => {
      const target = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return nextRoster.findIndex((entry) => {
        const candidate = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return candidate === target || candidate.includes(target) || target.includes(candidate);
      });
    };

    if (/\b(?:same|keep|preserve|unchanged)\b/.test(normalized)) {
      if (/\bsizes?\b/.test(normalized)) {
        nextRoster = nextRoster.map((entry) => {
          const approved = originalRoster.find((item) => item.id === entry.id);
          return approved ? { ...entry, size: approved.size } : entry;
        });
        removeArea('sizes');
        rosterChanged = true;
        recognized = true;
        confirmations.push('approved sizes are locked');
      }
      if (/\b(?:logo|artwork)\b/.test(normalized)) {
        setLogoUrl(null);
        removeArea('logo');
        recognized = true;
        confirmations.push('the approved logo is preserved');
      }
      if (/\b(?:design|colors?|uniform)\b/.test(normalized)) {
        nextDesign = { ...nextDesign, primaryColor: originalDesign.primaryColor, secondaryColor: originalDesign.secondaryColor, logoPlacement: originalDesign.logoPlacement, treatment: originalDesign.treatment };
        removeArea('design');
        designChanged = true;
        recognized = true;
        confirmations.push('the approved colors and design are preserved');
      }
      if (/\b(?:garment|style)\b/.test(normalized)) {
        nextDesign.garmentStyle = originalDesign.garmentStyle;
        removeArea('garment');
        designChanged = true;
        recognized = true;
        confirmations.push('the approved garment is preserved');
      }
    }

    const sizePatterns = [
      /(?:change|set|update)\s+(?:(?:player|number)\s*)?#?(\d{1,3}).*?\bsize\s*(?:to|as|is)?\s*(YS|YM|YL|XS|S|M|L|XL|2XL|3XL)\b/i,
      /\bsize\s+(?:for\s+)?(?:(?:player|number)\s*)?#?(\d{1,3})\s*(?:to|as|is)\s*(YS|YM|YL|XS|S|M|L|XL|2XL|3XL)\b/i,
    ];
    const hasReplacementIntent = /\b(?:replace|swap|change)\s+(?:(?:player|number)\s*)?#?\d{1,3}\s+(?:with|to)\s+/i.test(clean);
    const sizeMatch = hasReplacementIntent ? undefined : sizePatterns.map((pattern) => clean.match(pattern)).find(Boolean);
    if (sizeMatch) {
      const index = playerIndexByNumber(sizeMatch[1]);
      const nextSize = sizeFrom(sizeMatch[2]);
      recognized = true;
      if (index >= 0 && nextSize) {
        nextRoster[index] = { ...nextRoster[index], size: nextSize };
        addArea('sizes');
        rosterChanged = true;
        confirmations.push(`#${sizeMatch[1]} is now size ${nextSize}`);
      } else {
        confirmations.push(`I could not find player #${sizeMatch[1]}`);
      }
    }

    const removeNumberMatch = clean.match(/\b(?:remove|delete|drop)\s+(?:(?:player|number)\s*)?#?(\d{1,3})\b/i);
    const removeNameMatch = !removeNumberMatch ? clean.match(/\b(?:remove|delete|drop)\s+(?:player\s+)?([a-z][a-z.'’-]*(?:\s+[a-z][a-z.'’-]*){0,2})/i) : null;
    if (removeNumberMatch || removeNameMatch) {
      const index = removeNumberMatch ? playerIndexByNumber(removeNumberMatch[1]) : playerIndexByName(removeNameMatch?.[1] ?? '');
      recognized = true;
      if (index >= 0) {
        const removed = nextRoster[index];
        nextRoster.splice(index, 1);
        addArea('roster');
        rosterChanged = true;
        confirmations.push(`${removed.name} · #${removed.number} is removed`);
      } else {
        confirmations.push(`I could not find ${removeNumberMatch ? `player #${removeNumberMatch[1]}` : removeNameMatch?.[1]}`);
      }
    }

    const addMatch = clean.match(/\b(?:add|include)\s+(?:player\s+)?(.+?)\s+(?:number\s*|#)(\d{1,3})(?:\s*[,;\-]?\s*(?:size\s*(?:to|as|is)?\s*)?(YS|YM|YL|XS|S|M|L|XL|2XL|3XL))?(?:[.,]|$)/i);
    if (addMatch) {
      const playerName = addMatch[1].trim().replace(/[,:;-]+$/, '');
      const playerSize = sizeFrom(addMatch[3]) ?? 'M';
      const idBase = `command-${addMatch[2]}-${playerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      let playerId = idBase;
      let idSuffix = 2;
      while (nextRoster.some((entry) => entry.id === playerId)) {
        playerId = `${idBase}-${idSuffix}`;
        idSuffix += 1;
      }
      nextRoster.push({ id: playerId, name: playerName, number: addMatch[2], size: playerSize });
      addArea('roster');
      if (addMatch[3]) addArea('sizes');
      rosterChanged = true;
      recognized = true;
      confirmations.push(`${playerName} · #${addMatch[2]} · ${playerSize} is added`);
    }

    const replaceByNumber = clean.match(/\b(?:replace|swap|change)\s+(?:(?:player|number)\s*)?#?(\d{1,3})\s+(?:with|to)\s+(.+?)(?:[.;]|$)/i);
    const replaceByName = !replaceByNumber ? clean.match(/\b(?:replace|swap)\s+([a-z][a-z.'’-]*(?:\s+[a-z][a-z.'’-]*){0,2})\s+with\s+(.+?)(?:[.;]|$)/i) : null;
    if (replaceByNumber || replaceByName) {
      const sourceNumber = replaceByNumber?.[1];
      const replacementText = (replaceByNumber?.[2] ?? replaceByName?.[2] ?? '').trim();
      const index = sourceNumber ? playerIndexByNumber(sourceNumber) : playerIndexByName(replaceByName?.[1] ?? '');
      recognized = true;
      if (index >= 0) {
        const previous = nextRoster[index];
        const newNumberMatch = replacementText.match(/(?:number\s*|#)(\d{1,3})/i) ?? replacementText.match(/^\s*(\d{1,3})\s*$/);
        const newSizeMatch = replacementText.match(/\bsize\s*(?:to|as|is)?\s*(YS|YM|YL|XS|S|M|L|XL|2XL|3XL)\b/i);
        const newNumber = newNumberMatch?.[1] ?? previous.number;
        const newSize = sizeFrom(newSizeMatch?.[1]) ?? previous.size;
        const enteredName = replacementText
          .replace(/(?:number\s*|#)\d{1,3}/i, '')
          .replace(/\bsize\s*(?:to|as|is)?\s*(?:YS|YM|YL|XS|S|M|L|XL|2XL|3XL)\b/i, '')
          .replace(/^(?:player|name)\s+/i, '')
          .replace(/\b(?:and|with)\b\s*$/i, '')
          .replace(/^[,\s]+|[,\s]+$/g, '');
        const newName = formatEnteredName(enteredName) || previous.name;
        nextRoster[index] = { ...previous, name: newName, number: newNumber, size: newSize };
        addArea('identity');
        if (newSize !== previous.size) addArea('sizes');
        rosterChanged = true;
        confirmations.push(`${previous.name} · #${previous.number} is now ${newName} · #${newNumber} · ${newSize}`);
      } else {
        confirmations.push(`I could not find ${sourceNumber ? `player #${sourceNumber}` : replaceByName?.[1]}`);
      }
    }

    const teamNameMatch = clean.match(/\b(?:team\s+name|wordmark)\s*(?:to|as|is)\s+([^,.;]+?)(?=\s+and\s+(?:change|make|set)|$)/i);
    if (teamNameMatch) {
      nextDesign.teamName = teamNameMatch[1].trim().toUpperCase();
      addArea('design');
      designChanged = true;
      recognized = true;
      confirmations.push(`the team name is now ${nextDesign.teamName}`);
    }

    const resolveColor = (value: string) => value.startsWith('#') ? value : COLOR_VALUES[value.toLowerCase()];
    const primaryMatch = clean.match(/\bprimary(?:\s+color)?\s*(?:(?:to|as|is)\s+)?(#[0-9a-f]{6}|[a-z]+)/i);
    const secondaryMatch = clean.match(/\bsecondary(?:\s+color)?\s*(?:(?:to|as|is)\s+)?(#[0-9a-f]{6}|[a-z]+)/i);
    const colorPairMatch = !primaryMatch && !secondaryMatch ? clean.match(/\bcolors?\s*(?:(?:to|as|are)\s+)?(#[0-9a-f]{6}|[a-z]+)\s+(?:and|with|,)\s*(#[0-9a-f]{6}|[a-z]+)/i) : null;
    const primaryColor = resolveColor(primaryMatch?.[1] ?? colorPairMatch?.[1] ?? '');
    const secondaryColor = resolveColor(secondaryMatch?.[1] ?? colorPairMatch?.[2] ?? '');
    if (primaryMatch || secondaryMatch || colorPairMatch) {
      recognized = true;
      if (primaryColor || secondaryColor) {
        if (primaryColor) nextDesign.primaryColor = primaryColor;
        if (secondaryColor) nextDesign.secondaryColor = secondaryColor;
        addArea('design');
        designChanged = true;
        confirmations.push(`the colorway is updated${primaryColor && secondaryColor ? ' in both regions' : ''}`);
      } else {
        confirmations.push('that color is not in this POC palette; try navy, blue, red, green, gold, purple, black, white or silver');
      }
    }

    const placementMatch = clean.match(/\b(?:logo\s+)?placement\s*(?:to|as|is)?\s*(left|right|center)(?:\s+chest)?/i) ?? clean.match(/\bmove\s+(?:the\s+)?logo\s+to\s+(?:the\s+)?(left|right|center)(?:\s+chest)?/i);
    if (placementMatch) {
      nextDesign.logoPlacement = `${placementMatch[1][0].toUpperCase()}${placementMatch[1].slice(1).toLowerCase()} chest` as DesignSnapshot['logoPlacement'];
      addArea('design');
      designChanged = true;
      recognized = true;
      confirmations.push(`logo placement is ${nextDesign.logoPlacement}`);
    }

    const garmentMatch = clean.match(/\b(?:garment|jersey)\s+(?:style\s*)?(?:to|as|is)\s+([^,.;]+)/i);
    if (garmentMatch) {
      nextDesign.garmentStyle = garmentMatch[1].trim();
      addArea('garment');
      designChanged = true;
      recognized = true;
      confirmations.push(`garment style is changed to ${nextDesign.garmentStyle}`);
    }

    if (/\b(?:new|change|replace|upload)\s+(?:the\s+)?(?:logo|artwork)\b/.test(normalized)) {
      addArea('logo');
      recognized = true;
      needsLogoFile = true;
      confirmations.push('a replacement logo is requested');
    }

    if (/\b(?:deliver|delivery|ship|shipping|arrive|arrival)\b/.test(normalized)) {
      nextDeliveryNotes = clean;
      addArea('delivery');
      deliveryChanged = true;
      recognized = true;
      confirmations.push('the delivery instruction is saved');
    }

    if (!recognized) {
      addMessage('agent', 'I understood that you want to update this order, but I need one more detail before changing approved information. Tell me which player or design detail changed—for example, the player’s current number or name—and I’ll interpret the rest. Spelling does not have to be perfect.');
      setStatusMessage('No changes made. JourneyAX needs one identifying detail before safely editing the approved order.');
      return;
    }

    if (rosterChanged) {
      setRosterHistory((current) => [...current, cloneRoster(roster)]);
      setRoster(nextRoster);
    }
    if (designChanged) setDesign(nextDesign);
    if (deliveryChanged) setDeliveryNotes(nextDeliveryNotes);
    setSelectedAreas(nextAreas);
    setPhase('edit');
    const summary = confirmations.join('; ');
    setStatusMessage(summary ? `JourneyAX understood: ${summary}.` : 'Requested changes applied.');
    addMessage('agent', `${summary ? `Understood—${summary}.` : 'The requested changes are applied.'} Everything you did not mention remains preserved from the approved order.${needsLogoFile ? ' Add the replacement image in Design proof to continue.' : ''}`);
    if (needsLogoFile) window.setTimeout(() => fileInputRef.current?.focus(), 80);
  };

  const applyCommand = (event?: FormEvent) => {
    event?.preventDefault();
    runCommand(command);
  };

  const startValidation = () => {
    setPhase('validation');
    setStatusMessage('JourneyAX is validating the proposed reorder.');
    recordAudit('Business checks started', 'Stock, pricing, approval, artwork and delivery');
    track('reorder_validation_started');
    window.setTimeout(() => {
      if (hasBlockingErrors) {
        setPhase('edit');
        setStatusMessage(sizeReviewStatus === 'pending' ? 'Confirm the returning-player sizes before review.' : deliveryCommitment.state === 'blocked' ? 'Resolve the delivery commitment before review.' : 'Fix the highlighted roster issues before review.');
      } else {
        setPhase('review');
        setStatusMessage(artChange ? 'Validation complete. Artwork review is required.' : 'Validation complete. This reorder can proceed without a new proof.');
      }
    }, 850);
  };

  const complete = () => {
    if (!confirmed) return;
    const path = artChange ? 'artwork-review' : 'direct-reorder';
    const reference = path === 'artwork-review' ? artworkReference : reorderReference;
    setCompletionPath(path);
    setPhase('completed');
    setStatusMessage(artChange ? `Mock artwork-review request ${artworkReference} prepared.` : `Mock reorder ${reorderReference} prepared.`);
    addMessage('agent', path === 'artwork-review'
      ? `The proposed artwork change is packaged with the approved order context. ${artworkReference} is ready for the art team—no unaffected fields were rebuilt.`
      : `The safe reorder is prepared as ${reorderReference}. The approved design, logo, sizes and garment remain intact.`);
    recordAudit(path === 'artwork-review' ? 'Artwork handoff prepared' : 'Reorder prepared', path === 'artwork-review' ? artworkReference : reorderReference);
    track(path === 'artwork-review' ? 'reorder_artwork_handoff_prepared' : 'reorder_submission_prepared');

    // Hand off to CSR. Fire-and-forget: this is a mock reorder either way,
    // and a coach must not be blocked from finishing their own flow by a
    // staff-side outage. Before this call existed, "prepared" meant nothing
    // was actually saved anywhere — the desk staff would open the next call
    // with no record this coach had ever submitted anything.
    fetch('/api/reorder/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference,
        completionPath: path,
        team: order.team,
        sport: order.sport,
        season: order.season,
        originalOrderId: order.id,
        changedAreas: selectedAreas.map(id => CHANGE_AREAS.find(a => a.id === id)?.title ?? id),
        roster,
        design,
        deliveryNotes,
        statusMessage,
      }),
    }).catch(() => {
      // Logged server-side if it fails; the coach's own flow already shows
      // "prepared" and must not be reopened over a network blip.
    });
  };

  const resetDemo = () => {
    setPhase('search');
    setQuery('');
    setSelectedOrder(null);
    setSelectedTeam(null);
    setKitSelection([]);
    setSelectedAreas([]);
    setRoster(cloneRoster(ORIGINAL_ROSTER));
    setDesign({ ...ORIGINAL_DESIGN });
    setRosterHistory([]);
    setDeliveryNotes('');
    setLogoUrl(null);
    setBulkOpen(false);
    setBulkText('');
    setCommand('');
    setConfirmed(false);
    setCompletionPath(null);
    setAccessOpen(false);
    setHandoffPrepared(false);
    setAuditEvents([{ id: 'access', label: 'Access verified', detail: `${coachName} · ${authorizedSchool}` }]);
    setAnalyticsEvents(['reorder_session_started']);
    setUnavailableScenario(false);
    setAlternativeAccepted(false);
    setApprovalStatus('not-required');
    setSizeReviewStatus('pending');
    setFirstGameDate('2026-08-22');
    setExpeditedDelivery(false);
    setMatchedOrders(coachOrders);
    setMessages([{ id: 'welcome-reset', role: 'agent', text: `Welcome back, ${coachName}. Tell me what you want to reorder. I’ll search only your school’s approved orders and protect everything you do not want to change.` }]);
    setStatusMessage('Demo reset. Ready to find an approved order.');
  };

  const renderSearch = () => (
    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        <span className={styles.eyebrow}>AI-GUIDED REORDERING FOR TEAM COMMERCE</span>
        <h1>Reorder without<br /><em>starting over.</em></h1>
        <p>JourneyAX recovers the approved uniform, roster and artwork. Tell us what changed—everything else stays exactly as approved.</p>
        <form className={styles.search} onSubmit={runSearch}>
          <label htmlFor="order-search">Find a previous order</label>
          <div className={styles.searchControl}>
            <span aria-hidden>⌕</span>
            <input id="order-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="For example: I want to reorder our volleyball uniforms" />
            <button type="submit" disabled={ordersLoading}>{ordersLoading ? 'Connecting…' : 'Find order'} <span>→</span></button>
          </div>
        </form>
        <div className={styles.promptRow} aria-label="Example searches">
          <span>Try</span>
          {['I want to reorder our volleyball uniforms', 'S710001', 'DEMO-01-TEAM-26'].map((prompt) => (
            <button key={prompt} onClick={() => { setQuery(prompt); runCommand(prompt); }}>{prompt}</button>
          ))}
        </div>
      </div>
      <div className={styles.heroEvidence}>
        <div className={styles.evidenceHeader}><span>JOURNEY LIVE</span><strong>Change only what changed</strong></div>
        <JerseyPreview design={ORIGINAL_DESIGN} number="7" name="NGUYEN" />
        <div className={styles.lockList}>
          <span><i>✓</i> Approved design recovered</span>
          <span><i>✓</i> Roster ready to edit</span>
          <span><i>✓</i> Business rules connected</span>
        </div>
      </div>
      <div className={styles.promiseStrip}>
        <div><span>01</span><strong>Recover</strong><small>The approved order and proof.</small></div>
        <div><span>02</span><strong>Change</strong><small>Only the fields you select.</small></div>
        <div><span>03</span><strong>Complete</strong><small>Reorder or route for art review.</small></div>
      </div>
    </section>
  );

  const renderResults = () => (
    <section className={styles.stage}>
      <button className={styles.backButton} onClick={() => setPhase('search')}>← New search</button>
      <div className={styles.sectionHeading}>
        <div><span className={styles.eyebrow}>{teamRecords.length} TEAM{teamRecords.length === 1 ? '' : 'S'} FOUND · {matchedOrders.length} APPROVED ITEM{matchedOrders.length === 1 ? '' : 'S'}</span><h1>Choose the team to repeat.</h1><p>Orders are grouped by school and sport, so the team is findable without an S number—and the whole kit stays together.</p></div>
        <span className={styles.connectionBadge}>● {dataSource === 'mongodb' ? 'SANITIZED COMS DATA CONNECTED' : dataSource === 'snapshot' ? 'SANITIZED COMS SNAPSHOT READY' : 'LOCAL DEMO FALLBACK'}</span>
      </div>
      <div className={styles.orderGrid}>
        {teamRecords.map((team, index) => (
          <button className={styles.orderCard} key={team.key} onClick={() => chooseTeam(team)}>
            <span className={styles.orderTopline}><strong>{team.sport.toUpperCase()}</strong><span>{team.orders.length} ITEM{team.orders.length === 1 ? '' : 'S'} · READY</span></span>
            <JerseyPreview design={team.orders[0].design} number={index === 0 ? '7' : '12'} name={index === 0 ? 'NGUYEN' : 'TEAM'} />
            <span className={styles.orderCopy}>
              <strong>{team.school}</strong>
              <small>{team.sport} · {team.seasons.join(' · ')}</small>
              <small className={styles.kitLine}>{team.orders.map((item) => item.team).join(' + ')}</small>
              {team.dealer
                ? <small className={styles.dealerLine}>Ordered through {team.dealer} · found under the school</small>
                : <small className={styles.dealerLine}>Account {team.account} · school-owned</small>}
            </span>
            <span className={styles.orderFooter}><span>{team.totalUnits} units across {team.orders.length} item{team.orders.length === 1 ? '' : 's'}</span><strong>${team.totalValue.toFixed(2)} →</strong></span>
          </button>
        ))}
      </div>
    </section>
  );

  const renderTeam = () => {
    if (!selectedTeam) return null;
    const chosen = selectedTeam.orders.filter((item) => kitSelection.includes(item.id));
    const chosenUnits = chosen.reduce((sum, item) => sum + item.roster.length, 0);
    const chosenValue = chosen.reduce((sum, item) => sum + item.roster.length * item.unitPrice, 0);
    return (
      <section className={styles.stage}>
        <button className={styles.backButton} onClick={() => setPhase('results')}>← Team results</button>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>TEAM RECORD</span>
            <h1>{selectedTeam.school}</h1>
            <p>{selectedTeam.sport} · {selectedTeam.seasons.join(' · ')} · every item this team has ordered, in one place.</p>
          </div>
          <button className={styles.primaryButton} onClick={startKitReorder} disabled={!chosen.length}>Reorder {chosen.length} item{chosen.length === 1 ? '' : 's'} →</button>
        </div>

        <article className={styles.teamOwnership}>
          <span>✓</span>
          <div>
            <strong>{selectedTeam.dealer ? `Purchased by ${selectedTeam.dealer}, owned by the team` : 'Owned by the school'}</strong>
            <p>
              {selectedTeam.dealer
                ? `The dealer is stored as a detail on this team, not as its owner—so the coach and ${selectedTeam.dealer} both find this same record.`
                : `This team is keyed on school and sport, not on the person who placed the order. Account ${selectedTeam.account} is a detail, not the identity.`}
            </p>
          </div>
        </article>

        <section className={styles.kitPanel} aria-label="Team kit">
          <div className={styles.kitHeading}>
            <div><span className={styles.eyebrow}>THE WHOLE KIT</span><h2>Untick anything you do not need this season.</h2></div>
            <span>{chosen.length} of {selectedTeam.orders.length} selected</span>
          </div>
          <div className={styles.kitList}>
            {selectedTeam.orders.map((item) => {
              const isOn = kitSelection.includes(item.id);
              return (
                <label key={item.id} className={`${styles.kitItem} ${isOn ? styles.kitItemOn : ''}`}>
                  <input type="checkbox" checked={isOn} onChange={() => toggleKitItem(item.id)} />
                  <span className={styles.kitItemBody}>
                    <strong>{item.team}</strong>
                    <small>{item.design.garmentStyle}</small>
                    <small>{item.id} · {item.season} · {item.proofCount}</small>
                  </span>
                  <span className={styles.kitItemPrice}>
                    <strong>${(item.roster.length * item.unitPrice).toFixed(2)}</strong>
                    <small>{item.roster.length} units</small>
                  </span>
                </label>
              );
            })}
          </div>
          <div className={styles.kitTotals}>
            <span>Kit total</span>
            <strong>{chosenUnits} units · ${chosenValue.toFixed(2)}</strong>
          </div>
        </section>
      </section>
    );
  };

  const renderOrder = () => (
    <section className={styles.stage}>
      <button className={styles.backButton} onClick={() => setPhase(selectedTeam ? 'team' : 'results')}>← {selectedTeam ? 'Team kit' : 'Search results'}</button>
      <div className={styles.sectionHeading}>
        <div><span className={styles.eyebrow}>APPROVED ORDER RECOVERED</span><h1>{order.school}</h1><p>{order.team} · {order.season} · PO {order.po}</p></div>
        <button className={styles.primaryButton} onClick={() => setPhase('change-selection')}>Change only what changed →</button>
      </div>
      <div className={styles.orderWorkspace}>
        <article className={styles.designSummary}>
          <div className={styles.cardHeading}><span>APPROVED DESIGN</span><b>Ready to repeat</b></div>
          <div className={styles.designSummaryBody}>
            <JerseyPreview design={order.design} number="7" name="NGUYEN" />
            <dl>
              <div><dt>Garment</dt><dd>{order.design.garmentStyle}</dd></div>
              <div><dt>Colorway</dt><dd>Approved team colorway</dd></div>
              <div><dt>Artwork</dt><dd>{order.design.logoText} · {order.design.logoPlacement}</dd></div>
              <div><dt>Proof</dt><dd>{order.proofCount}</dd></div>
            </dl>
          </div>
        </article>
        <article className={styles.orderFacts}>
          <div className={styles.cardHeading}><span>ORDER SNAPSHOT</span><b>{order.status}</b></div>
          <div className={styles.factGrid}>
            <div><span>S number</span><strong>{order.id}</strong></div>
            <div><span>PO</span><strong>{order.po}</strong></div>
            <div><span>Account</span><strong>{order.account}</strong></div>
            <div><span>Players</span><strong>{order.roster.length}</strong></div>
            <div><span>Unit price</span><strong>${order.unitPrice.toFixed(2)}</strong></div>
            <div><span>Art owner</span><strong>{order.artOwner}</strong></div>
          </div>
          <div className={styles.historyNote}><span>✓</span><div><strong>Production-ready history found</strong><p>{order.approvedAt} · Proof approved first pass. School colors matched to prior season.</p></div></div>
        </article>
      </div>
      {kitCompanions.length > 0 && <section className={styles.kitCarryPanel}><div><span>WHOLE KIT REORDER</span><strong>{order.team} plus {kitCompanions.length} companion item{kitCompanions.length === 1 ? '' : 's'}</strong><p>The primary item opens in the change editor. These selected items remain attached to the same team reorder.</p></div><ul>{kitCompanions.map((item) => <li key={item.id}><span>{item.team}</span><strong>{item.roster.length} units · ${(item.roster.length * item.unitPrice).toFixed(2)}</strong></li>)}</ul></section>}
      <section className={`${styles.matchPromise} ${matchingPromise.exact ? styles.matchPromiseExact : styles.matchPromiseConditional}`} aria-label="Uniform matching promise">
        <div className={styles.matchPromiseLead}><span>{matchingPromise.exact ? '✓' : '!'}</span><div><small>WRITTEN MATCHING COMMITMENT</small><h2>{matchingPromise.title}</h2><p>{matchingPromise.detail}</p></div></div>
        <dl>{matchingPromise.checks.map((check) => <div key={check.label}><dt>{check.label}</dt><dd><i>{check.matches ? '✓' : '!'}</i>{check.value}</dd></div>)}</dl>
        <footer><span>Evidence</span><strong>Approved proof · {order.approvedAt} · {order.proofCount}</strong></footer>
      </section>
      <section className={styles.readinessPanel} aria-label="JourneyAX business readiness">
        <div className={styles.readinessHeading}><div><span className={styles.eyebrow}>BEFORE THE COACH CHANGES ANYTHING</span><h2>JourneyAX already checked the business conditions.</h2></div><span>SIMULATED RULES</span></div>
        <div className={styles.readinessGrid}>
          <article className={unavailableScenario ? styles.readinessException : ''}><span className={styles.readinessIcon}>01</span><div><small>AVAILABILITY</small><strong>{businessReadiness.availability.label}</strong><p>{businessReadiness.availability.detail}</p><em>{businessReadiness.availability.alternative}</em>{unavailableScenario && <dl className={styles.alternativeCompare}><div><dt>Category</dt><dd>Team jersey <i>Same</i></dd></div><div><dt>Fabric</dt><dd>Moisture-wicking knit <i>Same family</i></dd></div><div><dt>Fit</dt><dd>Athletic regular <i>Same</i></dd></div><div><dt>Proof impact</dt><dd>Fresh confirmation <i>+5 days</i></dd></div></dl>}{unavailableScenario && !alternativeAccepted ? <button type="button" onClick={acceptAlternative}>Use compatible style 228326 →</button> : <button type="button" onClick={startUnavailableScenario}>{alternativeAccepted ? 'Replay discontinued-style scenario' : 'Try discontinued-product scenario'}</button>}</div></article>
          <article className={alternativeAccepted ? styles.commercialException : ''}><span className={styles.readinessIcon}>02</span><div><small>PRICE & APPROVAL</small><strong>{businessReadiness.commercial.label}</strong><p>{businessReadiness.commercial.detail}</p><em>{businessReadiness.commercial.approval}</em>{alternativeAccepted && approvalStatus === 'required' && <button type="button" onClick={requestApproval}>Request school approval →</button>}{alternativeAccepted && approvalStatus === 'pending' && <button type="button" onClick={approvePriceChange}>Simulate athletic director approval →</button>}{alternativeAccepted && approvalStatus === 'approved' && <span className={styles.approvalComplete}>✓ Approved · reorder unlocked</span>}</div></article>
          <article className={businessReadiness.delivery.state !== 'ready' ? styles.deliveryException : ''} aria-live="polite"><span className={styles.readinessIcon}>03</span><div><small>DELIVERY PROMISE</small><strong>{businessReadiness.delivery.label}</strong><p>{businessReadiness.delivery.detail}</p><em>{businessReadiness.delivery.promise}</em><label className={styles.gameDateLabel}>First game<input type="date" value={firstGameDate} min="2026-08-16" onChange={(event) => { if (!event.target.value) return; setFirstGameDate(event.target.value); setExpeditedDelivery(false); setStatusMessage(`Delivery promise recalculated for first game ${displayDate(event.target.value)}.`); track('reorder_first_game_date_changed'); }} /></label>{businessReadiness.delivery.state !== 'ready' && !expeditedDelivery && !(alternativeAccepted && approvalStatus !== 'approved') && <button type="button" onClick={chooseExpeditedDelivery}>Use expedited production →</button>}</div></article>
        </div>
      </section>
    </section>
  );

  const renderChangeSelection = () => (
    <section className={styles.stage}>
      <button className={styles.backButton} onClick={() => setPhase('order')}>← Approved order</button>
      <div className={styles.sectionHeading}>
        <div><span className={styles.eyebrow}>ONE QUESTION, NOT A NEW CONFIGURATOR</span><h1>What changed this season?</h1><p>Select only the areas you need. Everything else stays locked to {order.id}.</p></div>
        <span className={styles.selectionCount}>{selectedAreas.length} selected</span>
      </div>
      <div className={styles.quickScope}>
        <button onClick={() => setQuickScope(['identity'], 'Names and numbers selected. Sizes and design will stay locked.')}><span>FASTEST PATH</span><strong>Names & numbers only</strong><small>Keep design, logo, garment and every existing size.</small></button>
        <button onClick={() => setQuickScope(['logo'], 'Logo change selected. JourneyAX will prepare an art-review proof.')}><span>ARTWORK PATH</span><strong>We have a new logo</strong><small>Preview the logo while preserving the rest of the uniform.</small></button>
      </div>
      <div className={styles.changeGrid}>
        {CHANGE_AREAS.map((area) => {
          const active = selectedAreas.includes(area.id);
          return (
            <button key={area.id} className={`${styles.changeCard} ${active ? styles.changeCardActive : ''}`} aria-pressed={active} onClick={() => toggleArea(area.id)}>
              <span className={styles.changeIcon}>{area.icon}</span>
              <span><strong>{area.title}</strong><small>{area.detail}</small></span>
              <i>{active ? '✓' : '+'}</i>
            </button>
          );
        })}
      </div>
      <div className={styles.preservedBanner}><span>🔒</span><div><strong>JourneyAX preservation guarantee</strong><p>Unselected fields are locked to the approved order and cannot be silently reset.</p></div><button disabled={!selectedAreas.length} onClick={() => setPhase('size-confirmation')}>Continue to size check →</button></div>
    </section>
  );

  const renderSizeConfirmation = () => (
    <section className={styles.stage}>
      <button className={styles.backButton} onClick={() => setPhase('change-selection')}>← What changed</button>
      <div className={styles.sectionHeading}>
        <div><span className={styles.eyebrow}>PROACTIVE SIZE CHECK</span><h1>Players grow. Last season’s sizes may not.</h1><p>These sizes have not been confirmed since March 2025. JourneyAX asks now so an easy repeat does not become an expensive remake.</p></div>
        <span className={styles.selectionCount}>{staleSizeEntries.length} need confirmation</span>
      </div>
      <div className={styles.sizeReviewGrid}>
        {staleSizeEntries.map((entry) => <article key={entry.id}><span>17 MONTHS AGO</span><div><strong>{entry.name}</strong><small>Jersey #{entry.number}</small></div><b>{entry.size}</b><em>Needs confirmation</em></article>)}
      </div>
      <div className={styles.sizeDecisionPanel}>
        <div><span>WHY JOURNEYAX ASKED</span><h2>No silent assumptions about growing players.</h2><p>Confirm the existing sizes in one click, or unlock only the size column to make corrections. Names, numbers, design and artwork remain protected.</p></div>
        <div><button type="button" className={styles.secondaryButton} onClick={reviewStaleSizes}>Review or change sizes</button><button type="button" className={styles.primaryButton} onClick={confirmCarriedSizes}>All three sizes are still correct →</button></div>
      </div>
      <p className={styles.prototypeRule}>Prototype rule: the first three returning players are treated as having sizes older than 12 months. Production will use the actual last-confirmed date.</p>
    </section>
  );

  const renderRosterEditor = () => {
    const canEditIdentity = selectedAreas.includes('identity') || selectedAreas.includes('roster');
    const canEditSizes = selectedAreas.includes('sizes');
    const canChangeRoster = selectedAreas.includes('roster');
    return (
      <section className={styles.editorSection}>
        <div className={`${styles.sizeReviewBanner} ${sizeReviewStatus === 'confirmed' ? styles.sizeReviewBannerDone : ''}`} role="status">
          <span>{sizeReviewStatus === 'confirmed' ? '✓' : '!'}</span><div><strong>{sizeReviewStatus === 'confirmed' ? 'Returning-player sizes confirmed' : `${staleSizeEntries.length} old sizes still need confirmation`}</strong><p>{sizeReviewStatus === 'confirmed' ? 'Coach Ramirez reviewed the carried-forward sizes for this reorder.' : 'Update anyone who grew, then confirm before validation.'}</p></div>{sizeReviewStatus === 'pending' && <button type="button" onClick={confirmCarriedSizes}>Confirm reviewed sizes</button>}
        </div>
        <div className={styles.editorHeading}>
          <div><span className={styles.eyebrow}>PROPOSED ROSTER</span><h2>Change the people, not the whole uniform.</h2><p>Locked values remain identical to the approved order.</p></div>
          <div className={styles.tableActions}>
            <button onClick={undoRoster} disabled={!rosterHistory.length}>↶ Undo</button>
            <button onClick={resetRoster}>Reset roster</button>
            {canChangeRoster && <button onClick={() => setBulkOpen((current) => !current)}>Paste from sheet</button>}
            {canChangeRoster && <button className={styles.smallPrimary} onClick={addPlayer}>+ Add player</button>}
          </div>
        </div>
        {bulkOpen && (
          <div className={styles.bulkPanel}>
            <label htmlFor="bulk-roster">Paste one player per line: name, number, size</label>
            <textarea id="bulk-roster" value={bulkText} onChange={(event) => setBulkText(event.target.value)} placeholder={'Jordan Lee, 24, L\nSam Rivera, 31, M'} />
            <div><button onClick={() => setBulkOpen(false)}>Cancel</button><button className={styles.smallPrimary} onClick={applyBulkRoster}>Add roster rows</button></div>
          </div>
        )}
        <div className={styles.tableWrap}>
          <table className={styles.rosterTable}>
            <caption className={styles.srOnly}>Proposed player roster for the reorder</caption>
            <thead><tr><th scope="col">#</th><th scope="col">Player name</th><th scope="col">Size</th><th scope="col">Status</th><th scope="col"><span className={styles.srOnly}>Remove</span></th></tr></thead>
            <tbody>
              {roster.map((entry) => {
                const original = originalRoster.find((item) => item.id === entry.id);
                const identityChanged = !original || original.name !== entry.name || original.number !== entry.number;
                const sizeChanged = !original || original.size !== entry.size;
                return (
                  <tr key={entry.id} className={identityChanged || sizeChanged ? styles.changedRow : ''}>
                    <td><input aria-label={`Jersey number for ${entry.name || 'new player'}`} value={entry.number} disabled={!canEditIdentity} onChange={(event) => updateRosterEntry(entry.id, 'number', event.target.value)} /></td>
                    <td><input aria-label={`Player name for jersey ${entry.number || 'new row'}`} value={entry.name} disabled={!canEditIdentity} onChange={(event) => updateRosterEntry(entry.id, 'name', event.target.value)} /></td>
                    <td><select aria-label={`Size for ${entry.name || 'new player'}`} value={entry.size} disabled={!canEditSizes && Boolean(original)} onChange={(event) => updateRosterEntry(entry.id, 'size', event.target.value)}>{SIZES.map((size) => <option value={size} key={size}>{size}</option>)}</select></td>
                    <td>{identityChanged || sizeChanged ? <span className={styles.changedPill}>Changed</span> : <span className={styles.lockedPill}>🔒 Preserved</span>}</td>
                    <td>{canChangeRoster && <button className={styles.removeButton} aria-label={`Remove ${entry.name || 'new player'}`} onClick={() => removePlayer(entry.id)}>×</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  const renderDesignEditor = () => {
    const canLogo = selectedAreas.includes('logo');
    const canDesign = selectedAreas.includes('design');
    const canGarment = selectedAreas.includes('garment');
    const designTouched = canLogo || canDesign || canGarment;
    return (
      <section className={styles.editorSection}>
        <div className={styles.editorHeading}>
          <div><span className={styles.eyebrow}>GUIDED DESIGN PROOF</span><h2>{designTouched ? 'See the change before art sees it.' : 'Your approved design stays protected.'}</h2><p>{designTouched ? 'JourneyAX highlights the proposed difference and prepares the right approval path.' : 'Select a design-related change only if this season’s uniform really needs it.'}</p></div>
          {!designTouched && <span className={styles.protectedBadge}>🔒 APPROVED PROOF REUSED</span>}
        </div>
        <div className={`${styles.matchEditorNotice} ${matchingPromise.exact ? styles.matchEditorNoticeExact : ''}`}><span>{matchingPromise.exact ? '✓' : '!'}</span><div><strong>{matchingPromise.title}</strong><p>{matchingPromise.detail}</p></div></div>
        <div className={styles.proofGrid}>
          <article className={styles.proofCard}><header><span>APPROVED DESIGN</span><b>Current</b></header><JerseyPreview design={originalDesign} number="24" name="LEE" muted={designTouched} /><footer>{originalDesign.garmentStyle}<br />{originalDesign.logoPlacement} · {originalDesign.treatment}</footer></article>
          <div className={styles.proofArrow}>→</div>
          <article className={`${styles.proofCard} ${designTouched ? styles.proofCardProposed : ''}`}><header><span>PROPOSED DESIGN</span><b>{designTouched ? 'Review needed' : 'No change'}</b></header><JerseyPreview design={design} number="24" name="LEE" logoUrl={logoUrl} changed={designTouched} /><footer>{design.garmentStyle}<br />{design.logoPlacement} · {design.treatment}</footer></article>
        </div>
        <div className={styles.designControls}>
          <div className={styles.controlGroup}>
            <label>Logo or artwork</label>
            <input ref={fileInputRef} className={styles.fileInput} type="file" accept="image/*" onChange={handleLogo} disabled={!canLogo} aria-describedby="logo-help" />
            <button disabled={!canLogo} onClick={() => fileInputRef.current?.click()}>{logoUrl ? 'Replace preview logo' : 'Choose replacement logo'}</button>
            <small id="logo-help">Local preview only · nothing is uploaded</small>
          </div>
          <div className={styles.controlGroup}><label htmlFor="team-name">Team wordmark</label><input id="team-name" value={design.teamName} disabled={!canDesign} onChange={(event) => setDesign((current) => ({ ...current, teamName: event.target.value.toUpperCase() }))} /><small>{canDesign ? 'Appears above the front number' : 'Preserved from approved proof'}</small></div>
          <div className={styles.controlGroup}><label>Uniform colors</label><div className={styles.colorRow}><label>Primary<input type="color" value={design.primaryColor} disabled={!canDesign} onChange={(event) => setDesign((current) => ({ ...current, primaryColor: event.target.value }))} /></label><label>Accent<input type="color" value={design.secondaryColor} disabled={!canDesign} onChange={(event) => setDesign((current) => ({ ...current, secondaryColor: event.target.value }))} /></label></div><small>{canDesign ? 'Preview updates instantly' : 'Approved team colors preserved'}</small></div>
          <div className={styles.controlGroup}><label htmlFor="logo-placement">Logo placement</label><select id="logo-placement" value={design.logoPlacement} disabled={!canDesign} onChange={(event) => setDesign((current) => ({ ...current, logoPlacement: event.target.value as DesignSnapshot['logoPlacement'] }))}><option>Center chest</option><option>Left chest</option><option>Right chest</option></select><small>{canDesign ? 'Artwork review will verify placement' : 'Preserved from approved proof'}</small></div>
          <div className={styles.controlGroup}><label htmlFor="number-treatment">Name & number treatment</label><select id="number-treatment" value={design.treatment} disabled={!canDesign} onChange={(event) => setDesign((current) => ({ ...current, treatment: event.target.value as DesignSnapshot['treatment'] }))}><option>Classic block</option><option>Athletic outline</option><option>Modern condensed</option></select><small>{canDesign ? 'Applied to the proposed proof' : 'Classic block preserved'}</small></div>
          <div className={styles.controlGroup}><label htmlFor="garment-style">Garment style</label><select id="garment-style" value={design.garmentStyle} disabled={!canGarment} onChange={(event) => setDesign((current) => ({ ...current, garmentStyle: event.target.value }))}><option>228325 · Lightweight reversible jersey</option><option>228450 · Elite sleeveless jersey</option><option>229110 · Performance match jersey</option></select><small>{canGarment ? 'Availability will be revalidated' : 'Approved style preserved'}</small></div>
        </div>
      </section>
    );
  };

  const renderEdit = () => (
    <section className={styles.editStage}>
      <div className={styles.editHeader}>
        <div><button className={styles.backButton} onClick={() => setPhase('change-selection')}>← Change selection</button><span className={styles.eyebrow}>SMART REORDER · {order.id}</span><h1>Only selected fields are editable.</h1></div>
        <button className={styles.primaryButton} onClick={startValidation}>Validate my changes →</button>
      </div>
      <div className={styles.scopeBar}>
        <span>Editing</span>{selectedAreas.map((area) => <b key={area}>{CHANGE_AREAS.find((item) => item.id === area)?.title}</b>)}
        <i>🔒 Everything else preserved</i>
      </div>
      {renderRosterEditor()}
      {renderDesignEditor()}
      {selectedAreas.includes('delivery') && <section className={styles.editorSection}><div className={styles.editorHeading}><div><span className={styles.eyebrow}>DELIVERY NOTES</span><h2>Add an instruction without changing the order.</h2></div></div><label className={styles.notesLabel} htmlFor="delivery-notes">Coach’s delivery note<textarea id="delivery-notes" value={deliveryNotes} onChange={(event) => setDeliveryNotes(event.target.value)} placeholder="Need the team order before the first tournament on August 22…" /></label></section>}
    </section>
  );

  const renderValidation = () => (
    <section className={styles.validationStage} aria-live="assertive">
      <div className={styles.validationOrb}><span>J</span><i /></div>
      <span className={styles.eyebrow}>JOURNEYAX VALIDATION</span>
      <h1>Checking only what changed.</h1>
      <p>Protecting the approved design, validating the roster and choosing the safest completion path.</p>
      <div className={styles.validationProgress}><span /></div>
    </section>
  );

  const renderReview = () => (
    <section className={styles.stage}>
      <button className={styles.backButton} onClick={() => setPhase('edit')}>← Continue editing</button>
      <div className={styles.sectionHeading}>
        <div><span className={styles.eyebrow}>VALIDATED REORDER</span><h1>Review the difference—not the whole build.</h1><p>{artChange ? 'Artwork changed, so JourneyAX prepared a controlled proof-review path.' : 'The approved art is reusable. No design rebuild or new proof is needed.'}</p></div>
        <span className={`${styles.routeBadge} ${artChange ? styles.routeBadgeArt : ''}`}>{unavailableScenario && alternativeAccepted ? 'SUBSTITUTE + PROOF' : artChange ? 'ARTWORK REVIEW' : 'DIRECT REORDER'}</span>
      </div>
      <section className={`${styles.reviewMatchPromise} ${matchingPromise.exact ? styles.reviewMatchPromiseExact : ''}`}><span>{matchingPromise.exact ? '✓ MATCH GUARANTEE' : '! PROOF CONFIRMATION REQUIRED'}</span><strong>{matchingPromise.title}</strong><p>{matchingPromise.detail}</p></section>
      <div className={styles.reviewGrid}>
        <article className={styles.reviewCard}><header><span className={styles.reviewIcon}>✦</span><div><span>CHANGED THIS REORDER</span><h2>{changedItems.length || 0} intentional change{changedItems.length === 1 ? '' : 's'}</h2></div></header><ul>{(changedItems.length ? changedItems : ['No order details changed']).map((item) => <li key={item}><span>→</span>{item}</li>)}</ul></article>
        <article className={`${styles.reviewCard} ${styles.reviewCardPreserved}`}><header><span className={styles.reviewIcon}>✓</span><div><span>PRESERVED FROM {order.id}</span><h2>{preservedItems.length} approved elements</h2></div></header><ul>{preservedItems.map((item) => <li key={item}><span>🔒</span>{item}</li>)}</ul></article>
      </div>
      {kitCompanions.length > 0 && <section className={styles.reviewKitPanel}><span>SELECTED TEAM KIT</span><strong>{kitCompanions.length + 1} items remain in this reorder</strong><ul><li><span>{order.team}</span><b>{roster.length} units · ${primaryTotal.toFixed(2)}</b></li>{kitCompanions.map((item) => <li key={item.id}><span>{item.team}</span><b>{item.roster.length} units · ${(item.roster.length * item.unitPrice).toFixed(2)}</b></li>)}</ul></section>}
      <section className={styles.decisionGrid} aria-label="Operational decisions">
        {Object.entries(businessReadiness).map(([key, item]) => <article key={key} className={styles[`decision-${item.state}`]}><div><span>{item.state === 'ready' ? '✓' : item.state === 'attention' ? '!' : '×'}</span><small>{key.toUpperCase()}</small></div><strong>{item.label}</strong><p>{item.detail}</p><em>{'alternative' in item ? item.alternative : 'approval' in item ? item.approval : 'owner' in item ? item.owner : item.promise}</em></article>)}
      </section>
      <div className={styles.reviewBottom}>
        <article className={styles.checksCard}><div className={styles.cardHeading}><span>JOURNEYAX CHECKS</span><b>{validationResults.filter((item) => item.state === 'pass').length} passed</b></div><ul>{validationResults.map((result) => <li key={result.id} className={styles[`check-${result.state}`]}><span>{result.state === 'pass' ? '✓' : result.state === 'attention' ? '!' : '×'}</span><div><strong>{result.label}</strong><small>{result.detail}</small></div></li>)}</ul></article>
        <article className={styles.totalCard}><span>REORDER SUMMARY</span><dl><div><dt>Kit items</dt><dd>{kitCompanions.length + 1}</dd></div><div><dt>Total units</dt><dd>{roster.length + kitCompanionUnits}</dd></div><div><dt>Primary unit price</dt><dd>${effectiveUnitPrice.toFixed(2)}</dd></div>{alternativeAccepted && <div><dt>Price difference</dt><dd>+${priceIncrease.toFixed(2)}</dd></div>}<div><dt>Estimated value</dt><dd>${total.toFixed(2)}</dd></div><div><dt>School approval</dt><dd>{alternativeAccepted ? approvalStatus === 'approved' ? 'Approved' : 'Required' : 'Not required'}</dd></div><div><dt>Delivery</dt><dd>{businessReadiness.delivery.label}</dd></div><div><dt>Proof</dt><dd>{artChange ? 'Required' : 'Reuse approved'}</dd></div></dl><label className={styles.confirmLabel}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I reviewed the proposed changes and preserved items.</span></label><button className={styles.primaryButton} disabled={!confirmed || hasBlockingErrors} onClick={complete}>{artChange ? 'Send to artwork review' : 'Submit safe reorder'} →</button><small>POC only · no real order or artwork request will be created.</small></article>
      </div>
    </section>
  );

  const renderCompleted = () => {
    const isArt = completionPath === 'artwork-review';
    return (
      <section className={styles.completedStage}>
        <div className={styles.successMark}>{isArt ? 'A' : '✓'}</div>
        <span className={styles.eyebrow}>{isArt ? 'ARTWORK PATH PREPARED' : 'REORDER PATH COMPLETE'}</span>
        <h1>{isArt ? 'The change is with the right team.' : 'Reorder prepared—without rebuilding.'}</h1>
        <p>{isArt ? 'JourneyAX packaged the approved order, proposed logo and exact design delta for artwork review.' : 'JourneyAX reused the approved design and changed only the requested player personalization.'}</p>
        <div className={styles.successCard}>
          <div><span>DEMO REFERENCE</span><strong>{isArt ? artworkReference : reorderReference}</strong></div>
          <div><span>STATUS</span><strong>{isArt ? 'Awaiting art proof' : 'Ready for order submission'}</strong></div>
          <div><span>PRESERVED</span><strong>{isArt ? 'Roster · sizes · pricing' : 'Design · logo · sizes · garment'}</strong></div>
          <div><span>NEXT STEP</span><strong>{isArt ? 'Coach receives proof notification' : 'Commerce API creates the reorder'}</strong></div>
        </div>
        <div className={styles.afterOrderGrid}>
          <article className={styles.timelineCard}><span>WHAT THE COACH SEES NEXT</span><ol><li className={styles.timelineDone}><i />Request prepared</li><li><i />{isArt ? 'Artwork proof review' : 'Order accepted by commerce'}</li><li><i />Production scheduled</li><li><i />Shipment and delivery updates</li></ol></article>
          <article className={styles.handoffCard}><span>NEED HUMAN HELP?</span><h2>JourneyAX carries the context forward.</h2><p>The CSR receives the order, exact changes, validation results, PO, promised date and conversation summary. The coach does not repeat the story.</p><button type="button" disabled={handoffPrepared} onClick={() => { setHandoffPrepared(true); recordAudit('CSR handoff prepared', `${order.id} context package`); track('reorder_csr_handoff_prepared'); }}>{handoffPrepared ? 'Context package prepared ✓' : 'Prepare CSR handoff'}</button></article>
        </div>
        <details className={styles.auditCard}><summary>View prototype audit history ({auditEvents.length} actions)</summary><ul>{auditEvents.map((event) => <li key={event.id}><strong>{event.label}</strong><span>{event.detail}</span></li>)}</ul><small>{analyticsEvents.length} anonymous journey events captured · no coach or roster details in analytics</small></details>
        <div className={styles.prototypeNotice}><strong>Working POC · sanitized COMS-derived data</strong><span>No real order, file upload or external handoff occurred.</span></div>
        <button className={styles.primaryButton} onClick={resetDemo}>Restart stakeholder demo ↺</button>
      </section>
    );
  };

  const renderMain = () => {
    if (phase === 'search') return renderSearch();
    if (phase === 'results') return renderResults();
    if (phase === 'team') return renderTeam();
    if (phase === 'order') return renderOrder();
    if (phase === 'change-selection') return renderChangeSelection();
    if (phase === 'size-confirmation') return renderSizeConfirmation();
    if (phase === 'edit') return renderEdit();
    if (phase === 'validation') return renderValidation();
    if (phase === 'review') return renderReview();
    return renderCompleted();
  };

  const agentSuggestions = phase === 'search' || phase === 'results' || phase === 'team'
    ? ['I want to reorder our volleyball uniforms', authorizedSchool.split(' ').slice(0, 2).join(' '), coachOrders[0]?.id ?? 'S710001']
    : phase === 'order' || phase === 'change-selection' || phase === 'size-confirmation'
      ? ['Replace #7 with Maya Chen #18 size M.', 'Add Priya Shah #30 size L.', 'Change team name to Panthers.']
      : phase === 'completed'
        ? ['Show me exactly what stayed the same.', 'Start another team reorder.', 'What happens next?']
        : ['Change #4 size to XL.', 'Remove player #12.', 'Make primary color red.'];

  return (
    <main className={styles.shell}>
      <div className={`${styles.pageBody} ${phase === 'search' || phase === 'completed' ? styles.pageBodyNoProgress : ''}`}>
        <aside className={styles.agentRail} aria-label="JourneyAX reorder agent">
            <div className={styles.agentHeader}>
              <Link className={styles.agentBrand} href="/" aria-label="JourneyAX Caroma configurator home">MOMENTEC</Link>
              <span className={styles.agentHeaderDivider} />
              <div><strong>Team Reorder</strong><small>Change-only order journey</small></div>
              <span className={styles.agentHeaderBadge} title={`Prototype state: ${coachName} has verified access only to ${authorizedSchool}`}><i />Verified coach</span>
              <button className={styles.accessButton} type="button" onClick={() => setAccessOpen((current) => !current)} aria-expanded={accessOpen}>Access</button>
              <button className={styles.agentReset} type="button" onClick={resetDemo} aria-label="Reset reorder demo">↺</button>
            </div>
            <div className={styles.agentJourneyContext}>
              <span>{selectedOrder ? selectedOrder.id : 'NEW REORDER'}</span>
              <strong>{selectedOrder ? selectedOrder.team : 'Coach self-service'}</strong>
              <small>{selectedOrder ? `${selectedOrder.school} · ${selectedOrder.season}` : 'Find an approved order without rebuilding it'}</small>
            </div>
            {accessOpen && <div className={styles.accessCard}><div><span>✓</span><strong>{coachName}</strong></div><p>Verified school access limits this journey to {authorizedSchool} team orders.</p><dl><div><dt>School</dt><dd>{authorizedSchool}</dd></div><div><dt>Role</dt><dd>{viewer.role}</dd></div><div><dt>Permission</dt><dd>Reorder teamwear</dd></div><div><dt>Verified by</dt><dd>Emailed link + six-digit code</dd></div></dl><small>Scope enforced server-side · this panel only reports it.</small></div>}
            <div className={styles.agentMessages} aria-live="polite">{messages.slice(-8).map((message) => <div key={message.id} className={message.role === 'agent' ? styles.agentMessage : styles.userMessage}>{message.role === 'agent' && <div className={styles.agentMessageHeader}><span><i /></span><small>Consultant</small></div>}<p>{message.text}</p></div>)}</div>
            <div className={styles.agentSuggestions}>
              {agentSuggestions.slice(0, 2).map((suggestion) => <button type="button" key={suggestion} onClick={() => runCommand(suggestion)}><span>→</span>{suggestion}</button>)}
            </div>
            <form className={styles.agentInput} onSubmit={applyCommand}><label className={styles.srOnly} htmlFor="agent-command">Tell JourneyAX what changed</label><input id="agent-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Describe only what changed…" /><button type="submit" aria-label="Apply command">→</button></form>
            <div className={styles.agentProtection}><span>✦</span><div><strong>Preservation is on</strong><small>Unselected fields stay exactly as approved.</small></div></div>
        </aside>
        <div className={styles.mainContent} aria-label="Live reorder canvas">{renderMain()}</div>
      </div>

      <div className={styles.srOnly} role="status" aria-live="polite">{statusMessage}</div>
    </main>
  );
}


/**
 * Access gate.
 *
 * The reorder screen only ever mounts for a coach who arrived through their
 * private link and confirmed the six-digit code. This is a *convenience*
 * boundary — it decides what to render, not what may be read. The real check
 * is `resolveReorderViewer` inside /api/reorder-orders, which is what a
 * direct request to the API hits.
 *
 * Mounting the workspace only after the viewer resolves also means its state
 * initialisers see the real coach, rather than a placeholder name that would
 * flash on screen and then change.
 */
export default function ReorderPage() {
  const [viewer, setViewer] = useState<CoachViewer | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/coach/me', { cache: 'no-store' });
        const body = await res.json();
        if (!active) return;
        if (body?.authenticated) {
          setViewer({ name: body.name, role: body.role, schools: body.schools ?? [] });
        }
      } catch {
        // Treated as signed out — failing closed is the only safe direction.
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => { active = false; };
  }, []);

  if (checking) return null;

  if (!viewer) {
    return (
      <main style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, background: '#0F1115', color: '#E8EAED',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      }}>
        <div style={{
          maxWidth: 420, padding: '34px 32px', background: '#171A20',
          border: '1px solid #262B33', borderRadius: 12,
        }}>
          <p style={{ margin: 0, fontSize: 10, letterSpacing: '.22em', color: '#8A93A0' }}>MOMENTEC</p>
          <h1 style={{ margin: '14px 0 10px', fontSize: 22, fontWeight: 600 }}>
            Open your private link
          </h1>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: '#A8B0BC' }}>
            Reorder history is personal to your school. Momentec emails you a private
            link; opening it and confirming the six-digit code brings you straight here.
          </p>
          <p style={{ margin: '18px 0 0', fontSize: 12, lineHeight: 1.6, color: '#8A93A0' }}>
            Cannot find the email? Ask your Momentec contact to send a new link —
            they expire, and each one only works for the address it was sent to.
          </p>
        </div>
      </main>
    );
  }

  return <ReorderWorkspace viewer={viewer} />;
}
