/**
 * The desks that run on the care desk's machinery besides customer care itself. Each is one entry here: what switches it on, which sign-ins work it,
 * who is on its team, the labels a person may correct, and the worker and intake that fit its source. The commerce service builds every desk it finds
 * here the same way (see `CareService`), so a new desk is a new entry and its own worker, not a copy of the service.
 *
 * Every desk is OFF unless its own setting asks for it, and approved changes are carried out only when its own write-back switch is on.
 */
import type { CaseIntake, CaseProcessor } from './care.desk';
import type { CareEvents } from './care.events';
import type { CareModel } from './care.processor';
import type { CareTeam } from './care.playbook';
import type { CareStore } from './care.store';
import type { ConnectorCaller } from './connector-rpc';
import { QuotesIntake } from './quotes/quotes.intake';
import { QUOTE_TOPICS, QUOTE_URGENCY, QUOTES_GROUPS, QUOTES_LEAD_GROUPS, quotesTeamFromEnv } from './quotes/quotes.playbook';
import { QuotesProcessor } from './quotes/quotes.processor';
import { StockIntake } from './stock/stock.intake';
import { STOCK_GROUPS, STOCK_TOPICS, STOCK_URGENCY, stockTeamFromEnv } from './stock/stock.playbook';
import { StockProcessor } from './stock/stock.processor';
import type { DeskKind } from './care.types';

export type ExtraDeskKind = Exclude<DeskKind, 'care'>;

export interface WorkerParts { store: CareStore; events: CareEvents; connectors: ConnectorCaller | null; model: CareModel | null; team: CareTeam; env: Record<string, string | undefined> }

export interface ExtraDeskSpec {
  kind: ExtraDeskKind;
  /** The prefix of its settings: `<ENV>_INTAKE`, `<ENV>_STORE`, `<ENV>_WRITEBACK`, `<ENV>_POLL_MS`, `<ENV>_TENANTS`, `<ENV>_TEAM`. */
  env: string;
  /** What `<ENV>_INTAKE` has to say to switch the desk on. */
  intakeValue: string;
  /** What the desk looks at, for the log. */
  source: string;
  /** The staff groups that work it, and the groups that decide what a person may not. */
  groups: string[];
  leadGroups: string[];
  team: (env: Record<string, string | undefined>) => CareTeam;
  labels: { topics: readonly string[]; moods: readonly string[] };
  processor: (p: WorkerParts) => CaseProcessor;
  intake: (p: Omit<WorkerParts, 'model' | 'team' | 'env'>) => CaseIntake;
}

const stageMs = (env: Record<string, string | undefined>) => Number(env.CARE_MIN_STAGE_MS) || 0;

export const EXTRA_DESKS: ExtraDeskSpec[] = [
  {
    kind: 'stock', env: 'STOCK', intakeValue: 'erp', source: 'the ERP for stock exceptions', groups: STOCK_GROUPS, leadGroups: [],
    team: stockTeamFromEnv, labels: { topics: STOCK_TOPICS, moods: STOCK_URGENCY },
    processor: (p) => new StockProcessor({ store: p.store, events: p.events, connectors: p.connectors, model: p.model, team: p.team, minStageMs: stageMs(p.env) }),
    intake: (p) => new StockIntake({ store: p.store, events: p.events, connectors: p.connectors! }),
  },
  {
    kind: 'quotes', env: 'QUOTES', intakeValue: 'salesforce', source: 'Salesforce for quote requests', groups: QUOTES_GROUPS, leadGroups: QUOTES_LEAD_GROUPS,
    team: quotesTeamFromEnv, labels: { topics: QUOTE_TOPICS, moods: QUOTE_URGENCY },
    processor: (p) => new QuotesProcessor({ store: p.store, events: p.events, connectors: p.connectors, model: p.model, team: p.team, managerLimit: Number(p.env.QUOTES_MANAGER_LIMIT) > 0 ? Number(p.env.QUOTES_MANAGER_LIMIT) : undefined, minStageMs: stageMs(p.env) }),
    intake: (p) => new QuotesIntake({ store: p.store, events: p.events, connectors: p.connectors! }),
  },
];

export const extraSpec = (kind: string): ExtraDeskSpec | undefined => EXTRA_DESKS.find((s) => s.kind === kind);
