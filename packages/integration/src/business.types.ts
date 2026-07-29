/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BUSINESS LAYER — "who is this business, and who does it serve?"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The sixth box in the Integration Layer, alongside Commerce, Project Config,
 * Order Fulfilment and Customer CRM/Support.
 *
 * WHY IT EXISTS: every other port answers "how do I DO something" (search, price,
 * fulfil). None answers "what KIND of business am I serving, and what is my
 * customer actually buying for?" Without that the agent has to be told, per
 * vertical, in code — which is how vertical assumptions leak into a supposedly
 * generic platform.
 *
 * THE KEY ABSTRACTION is `BusinessEntityModel`. Every business's customer buys
 * ON BEHALF OF something:
 *
 *   teamwear   → a TEAM     (school, club, college programme)
 *   bathroom   → a ROOM     (ensuite, powder room) within a project
 *   workwear   → a CREW     (site, shift, trade)
 *   uniforms   → a LOCATION (store, franchise, department)
 *
 * That entity is what the agent must identify before it can recommend anything.
 * Modelling it once here means "find the team" and "find the site" are the same
 * capability with different vocabulary — configured, not coded.
 */

/** Who the business is. */
export interface BusinessIdentity {
  name: string;
  /** Sub-brands actually sold (a house may carry many). */
  brands?: { name: string; productCount?: number }[];
  regions?: string[];
  currencies?: string[];
  summary?: string;
}

/** How the business sells — shapes tone, quantities and the whole journey. */
export interface BusinessModel {
  /** e.g. 'wholesale' | 'retail' | 'd2c' | 'decorator' | 'b2b-trade' | 'services' */
  type?: string;
  /** Who it sells to in plain words: "coaches, athletic directors, dealers". */
  sellsTo?: string;
  /** Typical order shape — one item, or a bulk roster? Drives quantity questions. */
  orderPattern?: 'single-item' | 'bulk-roster' | 'project-bundle' | 'replenishment';
  /** True when goods are customised/decorated per order (adds artwork + approval). */
  customised?: boolean;
  /** True when an order needs artwork/spec sign-off before production. */
  approvalRequired?: boolean;
}

/** A role that buys, so the agent can pitch at the right level of authority. */
export interface BusinessAudience {
  role: string;                 // "coach", "athletic director", "homeowner", "site manager"
  buysFor?: string;             // "their team", "their home", "their crew"
  authority?: 'decides' | 'recommends' | 'researches';
  notes?: string;
}

/**
 * What the customer is buying ON BEHALF OF — the entity the agent must pin down
 * before recommending. Generic by design: only the vocabulary differs per vertical.
 */
export interface BusinessEntityModel {
  /** Machine key: 'team' | 'room' | 'crew' | 'location'. */
  key: string;
  /** What to call it to a customer: "team", "room", "site". */
  label: string;
  labelPlural?: string;
  /** The question to ask when it isn't known yet. */
  askPrompt?: string;
  /** True when a directory of these exists to search (schools, sites…). */
  hasDirectory?: boolean;
  /** True when customers may name one that isn't on file, so it gets captured. */
  allowCreate?: boolean;
  /** Fields worth capturing about the entity, in asking order. */
  captureFields?: { key: string; label: string; required?: boolean; hint?: string }[];
  /** Attributes that must be CONFIRMED with the customer, never asserted
   *  (team colours, brand marks) — the provenance rule, expressed as config. */
  confirmWithCustomer?: string[];
}

/** The domain language: what this business's world is made of. */
export interface BusinessVocabulary {
  /** Primary way the catalogue is divided ("sport", "room", "trade"). */
  primaryDimension?: string;
  /** Observed values for it, derived from the catalogue rather than assumed. */
  primaryValues?: { value: string; productCount?: number }[];
  /** Secondary grouping ("garment type", "fixture type"). */
  secondaryDimension?: string;
  secondaryValues?: { value: string; productCount?: number }[];
  /** Audience split, where the catalogue has one (Adult/Youth/Ladies). */
  audienceDimension?: string;
  audienceValues?: string[];
}

/** How the business operates — the facts a rep would know. */
export interface BusinessOperating {
  /** Help/policy topics that EXIST and are retrievable. Pointers, not answers:
   *  specifics go stale, so the agent retrieves them rather than reciting. */
  knownTopics?: string[];
  priceBand?: { low?: number; median?: number; high?: number; currency?: string };
  catalogueSize?: number;
}

/** The complete answer to "what business am I working for?" */
export interface BusinessProfile {
  identity: BusinessIdentity;
  model: BusinessModel;
  audience: BusinessAudience[];
  entityModel?: BusinessEntityModel;
  vocabulary: BusinessVocabulary;
  operating: BusinessOperating;
  /** Where each part came from, so nothing unverified is presented as fact. */
  provenance?: Record<string, string>;
}

/** One entity the customer buys for (a team, a site, a room). */
export interface BusinessEntity {
  key: string;                  // stable slug
  name: string;
  kind?: string;                // 'school' | 'college' | 'club' | 'site' …
  location?: { city?: string; state?: string; country?: string };
  attributes?: Record<string, unknown>;
  /** 'authoritative-directory' | 'customer-stated' | 'unverified-public-source' */
  confidence?: string;
  source?: string;
}

export interface BusinessEntityLookup {
  query: string;
  matches: BusinessEntity[];
  totalMatches?: number;
  /** Names repeat across regions — true when the customer must be asked where. */
  needsLocation?: boolean;
  availableRegions?: string[];
  /** What the agent must do before acting on any of this. */
  guidance: string;
}
