/**
 * The care desk as the commerce service runs it: builds the desk from the environment, optionally starts looking at Zendesk on a timer, and
 * says who a signed-in person is to the desk.
 *
 * Everything is OFF unless asked for, like the order mirror:
 *   CARE_INTAKE=zendesk        start looking at Zendesk every CARE_POLL_MS (default 10000) for the tenants in CARE_TENANTS (default placemakers)
 *   CARE_STORE=memory          keep case files in memory (default: the database)
 *   CARE_MODEL                 the model to use (default: the project's own)
 *   CARE_REFUND_LIMIT          a refund or cancellation over this is the team lead's (default 500)
 *   CARE_MIN_STAGE_MS          keep each AI stage on screen at least this long (default 0; 1500 for a recording)
 *   CARE_TEAM                  the care people, as JSON (default: the care screens' team)
 *   CARE_ORDER_FORMATS         how an order number looks in a customer's words, as JSON: [{"name":..., "pattern":..., "example":...}] (default: the checkout number and the prefixed number)
 *   CARE_WRITEBACK=connectors  carry out an approved ticket's changes through the connector server (default: off, nothing is changed)
 * Changing Zendesk, commercetools or Salesforce is that separate switch (the write-back); it is off unless named.
 *
 * The other desks (stock exceptions, quotes) are described in `desk-specs.ts` and are each off unless asked for, with switches of their own:
 *   <ENV>_INTAKE=<source>      start looking at the desk's source every <ENV>_POLL_MS (default 10000) for the tenants in <ENV>_TENANTS (default placemakers)
 *   <ENV>_STORE=memory         keep its case files in memory (default: the database, in its own collections)
 *   <ENV>_WRITEBACK=connectors carry out an approved case's changes through the connector server (default: off, nothing is changed)
 *   <ENV>_TEAM                 the desk's people, as JSON (default: the desk screens' team)
 * where <ENV> is STOCK (STOCK_INTAKE=erp), QUOTES (QUOTES_INTAKE=salesforce; QUOTES_MANAGER_LIMIT is the quote size over which only the sales
 * manager decides) or INVOICES (INVOICES_INTAKE=erp; INVOICES_CREDIT_LIMIT is the credit, with GST, over which only the finance manager decides).
 * With a desk's intake unset its routes answer "not switched on" and nobody is offered its screens.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ADMIN_GROUP } from '@journeyax/shared-types';
import { connectToDatabase } from '@journeyax/database';
import type { Db } from 'mongodb';
import { CareDesk } from './care.desk';
import { CareEvents } from './care.events';
import { CareIntake } from './care.intake';
import { LlmCareModel } from './care.model';
import { orderFormatsFromEnv, teamFromEnv, type CareTeam } from './care.playbook';
import { CareProcessor } from './care.processor';
import { MemoryCareStore, MongoCareStore, type CareStore } from './care.store';
import { ConnectorWriteBack, UnavailableWriteBack, type CareActor, type CareWriteBack } from './care.writeback';
import { httpConnectorCaller } from './connector-rpc';
import { EXTRA_DESKS, extraSpec, type ExtraDeskKind, type ExtraDeskSpec } from './desk-specs';
import type { VerifiedIdentity } from '../identity';

/** The staff groups that are customer care: the project's "Customer Service" team as the gateway signs it (lower case, dashes), and `csr` as an alias. */
export const CARE_GROUPS = ['customer-service', 'csr'];

@Injectable()
export class CareService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('care');
  readonly events = new CareEvents();
  readonly team: CareTeam = teamFromEnv();
  private store: CareStore | null = null;
  private deskInstance: CareDesk | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The other desks: each with its own events, team, desk once built, and timer once looking. */
  private readonly extras = new Map<ExtraDeskKind, { events: CareEvents; team: CareTeam; desk: CareDesk | null; timer: NodeJS.Timeout | null }>(
    EXTRA_DESKS.map((spec) => [spec.kind, { events: new CareEvents(), team: spec.team(process.env), desk: null, timer: null }]),
  );
  /** Replaced by the write-back that carries out approved changes, when that is switched on. */
  writeBack: CareWriteBack = new UnavailableWriteBack();

  get desk(): CareDesk {
    if (this.deskInstance) return this.deskInstance;
    const env = process.env;
    const store: CareStore = env.CARE_STORE === 'memory' || !env.MONGODB_URI
      ? new MemoryCareStore()
      : new MongoCareStore(async (): Promise<Db | null> => (await connectToDatabase(env.MONGODB_URI!, 'journeyx')).db);
    this.store = store;
    const connectors = httpConnectorCaller();
    if (connectors && (env.CARE_WRITEBACK || '').trim().toLowerCase() === 'connectors') this.writeBack = new ConnectorWriteBack(connectors);
    const log = (m: string) => this.log.log(m);
    const orders = orderFormatsFromEnv(env);
    for (const problem of orders.problems) this.log.warn(problem);
    const processor = new CareProcessor({
      store, events: this.events, connectors, model: new LlmCareModel(log), team: this.team, orderFormats: orders.formats,
      refundLimit: Number(env.CARE_REFUND_LIMIT) > 0 ? Number(env.CARE_REFUND_LIMIT) : 500, minStageMs: Number(env.CARE_MIN_STAGE_MS) || 0,
    });
    const intake = connectors ? new CareIntake({ store, events: this.events, connectors }) : null;
    this.deskInstance = new CareDesk({ store, events: this.events, processor, intake, writeBack: this.writeBack, team: this.team, log });
    return this.deskInstance;
  }

  /** Whether a desk is switched on (its `<ENV>_INTAKE` names its source). */
  deskEnabled(kind: string): boolean {
    const spec = extraSpec(kind);
    return !!spec && (process.env[`${spec.env}_INTAKE`] || '').trim().toLowerCase() === spec.intakeValue;
  }

  /** The team of a desk. */
  teamOf(kind: ExtraDeskKind): CareTeam { return this.extras.get(kind)!.team; }

  /** A desk besides customer care, or null when it is not switched on. Built the way the care desk is, with its own case files, worker and write-back. */
  extraDesk(kind: string): CareDesk | null {
    const spec = extraSpec(kind);
    if (!spec || !this.deskEnabled(kind)) return null;
    const slot = this.extras.get(spec.kind)!;
    if (slot.desk) return slot.desk;
    const env = process.env;
    const store: CareStore = env[`${spec.env}_STORE`] === 'memory' || !env.MONGODB_URI
      ? new MemoryCareStore()
      : new MongoCareStore(async (): Promise<Db | null> => (await connectToDatabase(env.MONGODB_URI!, 'journeyx')).db, spec.kind);
    const connectors = httpConnectorCaller();
    const writeBack = connectors && (env[`${spec.env}_WRITEBACK`] || '').trim().toLowerCase() === 'connectors' ? new ConnectorWriteBack(connectors) : new UnavailableWriteBack();
    const log = (m: string) => this.log.log(m);
    const processor = spec.processor({ store, events: slot.events, connectors, model: new LlmCareModel(log), team: slot.team, env });
    const intake = connectors ? spec.intake({ store, events: slot.events, connectors }) : null;
    slot.desk = new CareDesk({ store, events: slot.events, processor, intake, writeBack, team: slot.team, labels: spec.labels, log });
    return slot.desk;
  }

  onModuleInit(): void {
    for (const spec of EXTRA_DESKS) this.startTimer(spec);
    if ((process.env.CARE_INTAKE || '').trim().toLowerCase() !== 'zendesk') return;
    if (!httpConnectorCaller()) { this.log.warn('CARE_INTAKE is on but there is no connector key (CONNECTOR_SECRET_REAL_CONNECTORS_KEY), so nothing will be looked at.'); return; }
    const tenants = (process.env.CARE_TENANTS || 'placemakers').split(',').map((t) => t.trim()).filter(Boolean);
    const every = Math.max(3000, Number(process.env.CARE_POLL_MS) || 10_000);
    let busy = false;
    this.log.log(`Looking at Zendesk every ${every / 1000}s for ${tenants.join(', ')}.`);
    this.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { for (const tenant of tenants) await this.desk.pollOnce(tenant); } catch (error: any) { this.log.warn(`Looking at Zendesk failed: ${String(error?.message || error).slice(0, 160)}`); } finally { busy = false; }
    }, every);
  }

  private startTimer(spec: ExtraDeskSpec): void {
    if (!this.deskEnabled(spec.kind)) return;
    if (!httpConnectorCaller()) { this.log.warn(`${spec.env}_INTAKE is on but there is no connector key (CONNECTOR_SECRET_REAL_CONNECTORS_KEY), so nothing will be looked at.`); return; }
    const tenants = (process.env[`${spec.env}_TENANTS`] || 'placemakers').split(',').map((t) => t.trim()).filter(Boolean);
    const every = Math.max(3000, Number(process.env[`${spec.env}_POLL_MS`]) || 10_000);
    let busy = false;
    this.log.log(`Looking at ${spec.source} every ${every / 1000}s for ${tenants.join(', ')}.`);
    this.extras.get(spec.kind)!.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { for (const tenant of tenants) await this.extraDesk(spec.kind)?.pollOnce(tenant); } catch (error: any) { this.log.warn(`Looking at ${spec.source} failed: ${String(error?.message || error).slice(0, 160)}`); } finally { busy = false; }
    }, every);
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); for (const slot of this.extras.values()) if (slot.timer) clearInterval(slot.timer); }

  /** Who the desk should treat the signed-in person as, or null when they are not care staff. An admin acts as the team lead. */
  actorFor(identity: VerifiedIdentity | undefined): CareActor | null {
    if (!identity) return null;
    if (identity.role === 'admin' || identity.groups.includes(ADMIN_GROUP)) return { name: this.team.lead.name, id: this.team.lead.id, isLead: true };
    if (!CARE_GROUPS.some((group) => identity.groups.includes(group))) return null;
    const rep = this.team.reps.find((r) => r.email && r.email.toLowerCase() === String(identity.sub).toLowerCase()) ?? this.team.reps[0];
    return { name: rep.name, id: rep.id, isLead: false };
  }

  /**
   * Who a desk besides customer care should treat the signed-in person as, or null when they do not work it (or it is off). An admin, and anyone in
   * the desk's lead groups, acts as the team lead.
   */
  actorForDesk(kind: string, identity: VerifiedIdentity | undefined): CareActor | null {
    const spec = extraSpec(kind);
    if (!identity || !spec || !this.deskEnabled(kind)) return null;
    const team = this.teamOf(spec.kind);
    if (identity.role === 'admin' || identity.groups.includes(ADMIN_GROUP) || spec.leadGroups.some((group) => identity.groups.includes(group))) return { name: team.lead.name, id: team.lead.id, isLead: true };
    if (!spec.groups.some((group) => identity.groups.includes(group))) return null;
    const rep = team.reps.find((r) => r.email && r.email.toLowerCase() === String(identity.sub).toLowerCase()) ?? team.reps[0];
    return { name: rep.name, id: rep.id, isLead: false };
  }
}
