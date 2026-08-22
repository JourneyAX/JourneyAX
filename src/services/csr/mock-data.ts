// ═══════════════════════════════════════════════════════════════════════
// Mock COMS data.
//
// Augusta/Momentec data is not in our MongoDB yet, so the spine runs on
// this. Everything is shaped like the real COMS export, so replacing this
// file with a live feed should not touch any component.
//
// Accounts and tag values (Cloud 9, EPIC, Fox Factory, Proof Rejected,
// PMS Colors …) are taken from the real export.
// ═══════════════════════════════════════════════════════════════════════

import { Account, ComsOrder, RosterEntry, SearchHit } from '@/lib/csr-types';

// ── Accounts ───────────────────────────────────────────────────────────
export const ACCOUNTS: Account[] = [
  {
    acctNumber: '777753',
    accountName: 'Cloud 9 Team Sports',
    accountType: 'Dealer',
    salesRepName: 'Josh Nacman',
    paymentTerms: '001',
    contactName: 'Dana Whitfield',
    contactEmail: 'dana@cloud9teamsports.com',
    city: 'Naperville',
    state: 'IL',
  },
  {
    acctNumber: '133826',
    accountName: 'EPIC Sports Group',
    accountType: 'Dealer',
    salesRepName: 'Alex Daniels',
    paymentTerms: '001',
    contactName: 'Marcus Reed',
    contactEmail: 'marcus@epicsg.com',
    city: 'Columbus',
    state: 'OH',
  },
  {
    acctNumber: '904188',
    accountName: 'Oswego East High School',
    accountType: 'School',
    salesRepName: 'Josh Nacman',
    paymentTerms: 'C30',
    contactName: 'Coach Ramirez',
    contactEmail: 'jramirez@oswego308.org',
    city: 'Oswego',
    state: 'IL',
  },
  {
    acctNumber: '551204',
    accountName: 'Fox Factory Athletics',
    accountType: 'Dealer',
    salesRepName: 'Alex Daniels',
    paymentTerms: '001',
    contactName: 'Tricia Nolan',
    contactEmail: 'tricia@foxfactoryath.com',
    city: 'Scottsdale',
    state: 'AZ',
  },
];

// ── Roster helper ──────────────────────────────────────────────────────
// The optional fourth column is US grade. COMS does not carry it today —
// it is here so the fit engine has something to read, and so the shape of
// the ask ("add grade to the roster line") is concrete.
const roster = (rows: [string, string, string, number?][]): RosterEntry[] =>
  rows.map(([name, number, size, gradeLevel], i) => ({
    id: `r${i + 1}`, name, number, size,
    ...(gradeLevel !== undefined ? { gradeLevel } : {}),
  }));

// ── Orders ─────────────────────────────────────────────────────────────
export const ORDERS: ComsOrder[] = [
  // 1 ── The clean reorder. Roster changes only, artwork already approved.
  {
    comsId: 4471,
    sNumber: 'S482913',
    onlineNumber: '55086946174453',
    orderNumber: '8841203',
    poNumber: 'OE-VB-2025',
    acctNumber: '904188',
    accountName: 'Oswego East High School',
    salesRepName: 'Josh Nacman',
    orderType: 'SUBLIMATION',
    orderSubType: 'FULL_ORDER',
    stage: 'COMPLETED',
    subState: 'READY',
    artTypes: ['Freestyle Art'],
    tags: [],
    proofsRequested: 1,
    proofsReady: 1,
    revisionCount: 0,
    hold: false,
    rush: false,
    receivedDate: '03/14/2025',
    requestedShipDate: '04/02/2025',
    assignee: 'Gabriel Martin',
    sport: "Girls' Volleyball",
    season: 'Spring 2025',
    product: {
      styleId: '228325',
      styleName: 'Ladies FreeStyle Sublimated Lightweight Reversible Basketball Jersey',
      colorway: 'Navy / Silver',
      unitPrice: 70.5,
      stillAvailable: true,
      cut: 'athletic',
      runs: 0,
    },
    roster: (() => {
      const rows = roster([
        ['A. Whitmore', '2', 'M', 12], ['J. Castellanos', '4', 'S', 9], ['R. Patel', '5', 'M', 11],
        ['K. Nguyen', '7', 'L', 12], ['M. Okafor', '8', 'M', 9], ['T. Bergstrom', '10', 'S', 10],
        ['S. Delacroix', '11', 'M', 12], ['L. Ferreira', '12', 'L', 11], ['D. Kaminski', '14', 'M', 9],
        ['B. Osei', '15', 'S', 9], ['C. Lindqvist', '18', 'M', 10], ['H. Yamamoto', '21', 'L', 12],
      ]);
      // One player with a real prior season on file, so the engine has an
      // individual trend to read rather than only an age-band average.
      const osei = rows.find(r => r.name === 'B. Osei');
      if (osei) {
        osei.sizeHistory = [
          { at: '03/12/2023', size: 'XS', styleId: '228325' },
          { at: '03/14/2025', size: 'S', styleId: '228325' },
        ];
      }
      return rows;
    })(),
    designTotal: 1,
    unitTotal: 12,
    notes: [
      { at: '03/18/2025', who: 'Gabriel Martin', text: 'Proof approved first pass. School colours matched to prior season.' },
    ],
  },

  // 2 ── Style retired since last season. The exception that forces a call.
  {
    comsId: 4193,
    sNumber: 'S471088',
    onlineNumber: '55138372762912',
    orderNumber: '8792144',
    poNumber: 'C9-BB-24',
    acctNumber: '777753',
    accountName: 'Cloud 9 Team Sports',
    salesRepName: 'Josh Nacman',
    orderType: 'SUBLIMATION',
    orderSubType: 'FULL_ORDER',
    stage: 'COMPLETED',
    subState: 'READY',
    artTypes: ['Standard Builder', 'Vector Art'],
    tags: ['Cloud 9'],
    proofsRequested: 2,
    proofsReady: 2,
    revisionCount: 1,
    hold: false,
    rush: false,
    receivedDate: '01/22/2025',
    requestedShipDate: '02/28/2025',
    assignee: 'Chaitanya Gotike',
    sport: 'Baseball',
    season: 'Spring 2025',
    product: {
      styleId: '329X3B',
      styleName: 'Youth FreeStyle Sublimated Baseline Two-Button Baseball Jersey',
      colorway: 'Royal / White',
      unitPrice: 85.0,
      stillAvailable: false,
      discontinuedNote: 'Style retired end of 2025 season.',
      cut: 'standard',
      runs: 0,
      suggestedReplacement: {
        styleId: '329X3M',
        styleName: 'FreeStyle Sublimated Baseline Covered Placket Baseball Jersey',
        unitPrice: 85.0,
        cut: 'athletic',
        // The replacement is cut closer than the style it replaces. Carrying
        // that here is what stops a substitution becoming a silent size change.
        runs: -1,
      },
    },
    // Grades are known for five of the eight. The other three are left blank
    // on purpose — real COMS data is patchy, and the engine has to be honest
    // about who it could not assess rather than guessing.
    roster: roster([
      ['E. Brannigan', '1', 'YL', 8], ['P. Okonkwo', '3', 'YM', 7], ['N. Sorenson', '6', 'YL'],
      ['V. Ramirez', '9', 'YM', 8], ['G. Thibault', '11', 'YS', 6], ['A. Kowalczyk', '13', 'YL'],
      ['I. Mwangi', '17', 'YM', 7], ['F. Andersson', '22', 'YL'],
    ]),
    designTotal: 1,
    unitTotal: 8,
    notes: [
      { at: '02/03/2025', who: 'Chaitanya Gotike', text: 'Second proof requested — number font changed at customer request.' },
    ],
  },

  // 3 ── Colour problem. Matches the PMS/Neon tag cluster in the export.
  {
    comsId: 5120,
    sNumber: 'S499204',
    onlineNumber: '55218013591163',
    poNumber: 'EPIC-SOC-26',
    acctNumber: '133826',
    accountName: 'EPIC Sports Group',
    salesRepName: 'Alex Daniels',
    orderType: 'SUBLIMATION',
    orderSubType: 'FULL_ORDER',
    stage: 'APPROVAL',
    subState: 'ACTION_REQUIRED',
    artTypes: ['Vector Art', 'Raster Art'],
    tags: ['EPIC', 'PMS Colors', 'Proof Rejected'],
    proofsRequested: 3,
    proofsReady: 2,
    revisionCount: 2,
    hold: false,
    rush: true,
    receivedDate: '01/09/2026',
    requestedShipDate: '02/20/2026',
    assignee: 'Manisha Aemula',
    sport: 'Soccer',
    season: 'Spring 2026',
    product: {
      styleId: '228187',
      styleName: 'FreeStyle Sublimated Turbo Flag Football Lightweight Reversible Jersey',
      colorway: 'PMS 348C Green / Black',
      unitPrice: 68.0,
      stillAvailable: true,
    },
    roster: roster([
      ['Q. Adeyemi', '2', 'M'], ['W. Bianchi', '5', 'L'], ['Y. Novak', '7', 'M'],
      ['Z. Haddad', '8', 'S'], ['X. Petrov', '10', 'L'], ['U. Salinas', '14', 'M'],
    ]),
    designTotal: 1,
    unitTotal: 6,
    notes: [
      { at: '01/28/2026', who: 'Manisha Aemula', text: 'Proof rejected — customer says green reads too dark vs PMS 348C. Awaiting artist colour remap.' },
    ],
  },

  // 4 ── A mock that never converted. 65% of COMS volume looks like this.
  {
    comsId: 5388,
    sNumber: 'S503771',
    acctNumber: '551204',
    accountName: 'Fox Factory Athletics',
    salesRepName: 'Alex Daniels',
    orderType: 'SUBLIMATION',
    orderSubType: 'MOCK_ONLY',
    stage: 'APPROVAL',
    subState: 'WAITING_FOR_CUSTOMER',
    artTypes: ['CDL Art'],
    tags: ['Fox Factory', 'CS_Unresponsive'],
    proofsRequested: 2,
    proofsReady: 2,
    revisionCount: 0,
    hold: false,
    rush: false,
    receivedDate: '11/04/2025',
    assignee: 'Hari Srujan Goppu',
    sport: 'Wrestling',
    season: 'Winter 2026',
    product: {
      styleId: '228146',
      styleName: 'FreeStyle Sublimated Polo',
      colorway: 'Charcoal / Orange',
      unitPrice: 69.8,
      stillAvailable: true,
    },
    roster: [],
    designTotal: 1,
    unitTotal: 0,
    notes: [
      { at: '11/26/2025', who: 'Hari Srujan Goppu', text: 'Second mock sent. No response from customer in 3 weeks.' },
      { at: '12/15/2025', who: 'Hari Srujan Goppu', text: 'Follow-up email sent. Still no reply.' },
    ],
  },

  // 5 ── Same school, different sport. Proves the kit/cross-sell gap.
  {
    comsId: 4472,
    sNumber: 'S482915',
    orderNumber: '8841204',
    poNumber: 'OE-VB-2025',
    acctNumber: '904188',
    accountName: 'Oswego East High School',
    salesRepName: 'Josh Nacman',
    orderType: 'SUBLIMATION',
    orderSubType: 'FULL_ORDER',
    stage: 'COMPLETED',
    subState: 'READY',
    artTypes: ['Freestyle Art'],
    tags: [],
    proofsRequested: 1,
    proofsReady: 1,
    revisionCount: 0,
    hold: false,
    rush: false,
    receivedDate: '03/14/2025',
    assignee: 'Gabriel Martin',
    sport: "Girls' Volleyball",
    season: 'Spring 2025',
    product: {
      styleId: 'R20CSM',
      styleName: 'FreeStyle Sublimated 7v7 Compression Shorts',
      colorway: 'Navy / Silver',
      unitPrice: 50.0,
      stillAvailable: true,
    },
    roster: roster([
      ['A. Whitmore', '2', 'M'], ['J. Castellanos', '4', 'S'], ['R. Patel', '5', 'M'],
      ['K. Nguyen', '7', 'L'], ['M. Okafor', '8', 'M'], ['T. Bergstrom', '10', 'S'],
      ['S. Delacroix', '11', 'M'], ['L. Ferreira', '12', 'L'], ['D. Kaminski', '14', 'M'],
      ['B. Osei', '15', 'S'], ['C. Lindqvist', '18', 'M'], ['H. Yamamoto', '21', 'L'],
    ]),
    designTotal: 1,
    unitTotal: 12,
  },
];

// ── Lookup ─────────────────────────────────────────────────────────────
export function getAccount(acctNumber: string): Account | undefined {
  return ACCOUNTS.find(a => a.acctNumber === acctNumber);
}

export function getOrder(sNumber: string): ComsOrder | undefined {
  return ORDERS.find(o => o.sNumber.toLowerCase() === sNumber.toLowerCase());
}

/**
 * One box, any input.
 *
 * The live Design Lookup accepts a reference number and nothing else — which
 * is the point where a customer who has lost their number has to phone in.
 * This matches on anything a CSR is likely to be told over the phone.
 */
export function searchOrders(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const terms = q.split(/\s+/).filter(t => t.length > 1);
  const hits: SearchHit[] = [];

  for (const order of ORDERS) {
    const acct = getAccount(order.acctNumber);
    const fields: [string, string, number][] = [
      ['S number', order.sNumber, 100],
      ['order number', order.orderNumber || '', 90],
      ['online number', order.onlineNumber || '', 90],
      ['PO number', order.poNumber || '', 85],
      ['account number', order.acctNumber, 80],
      ['account', order.accountName, 60],
      ['sport', order.sport, 40],
      ['season', order.season, 30],
      ['style', order.product.styleName, 25],
      ['style number', order.product.styleId, 70],
      ['colour', order.product.colorway, 20],
      ['contact', acct?.contactName || '', 35],
      ['sales rep', order.salesRepName, 15],
      ['player', order.roster.map(r => r.name).join(' '), 10],
    ];

    let score = 0;
    const matched: string[] = [];

    for (const term of terms) {
      for (const [label, value, weight] of fields) {
        if (value && value.toLowerCase().includes(term)) {
          score += weight;
          if (!matched.includes(label)) matched.push(label);
          break;
        }
      }
    }

    if (score > 0) {
      hits.push({ order, score, matchedOn: matched.join(', ') });
    }
  }

  return hits.sort((a, b) => b.score - a.score);
}
