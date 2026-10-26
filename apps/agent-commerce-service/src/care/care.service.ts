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
 * Changing Zendesk, commercetools or Salesforce is a separate switch (the write-back), not on here.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ADMIN_GROUP } from '@journeyax/shared-types';
import { connectToDatabase } from '@journeyax/database';
import type { Db } from 'mongodb';
import { CareDesk } from './care.desk';
import { CareEvents } from './care.events';
import { CareIntake } from './care.intake';
import { LlmCareModel } from './care.model';
import { teamFromEnv, type CareTeam } from './care.playbook';
import { CareProcessor } from './care.processor';
import { MemoryCareStore, MongoCareStore, type CareStore } from './care.store';
import { UnavailableWriteBack, type CareActor, type CareWriteBack } from './care.writeback';
import { httpConnectorCaller } from './connector-rpc';
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
    const log = (m: string) => this.log.log(m);
    const processor = new CareProcessor({
      store, events: this.events, connectors, model: new LlmCareModel(log), team: this.team,
      refundLimit: Number(env.CARE_REFUND_LIMIT) > 0 ? Number(env.CARE_REFUND_LIMIT) : 500, minStageMs: Number(env.CARE_MIN_STAGE_MS) || 0,
    });
    const intake = connectors ? new CareIntake({ store, events: this.events, connectors }) : null;
    this.deskInstance = new CareDesk({ store, events: this.events, processor, intake, writeBack: this.writeBack, team: this.team, log });
    return this.deskInstance;
  }

  onModuleInit(): void {
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

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  /** Who the desk should treat the signed-in person as, or null when they are not care staff. An admin acts as the team lead. */
  actorFor(identity: VerifiedIdentity | undefined): CareActor | null {
    if (!identity) return null;
    if (identity.role === 'admin' || identity.groups.includes(ADMIN_GROUP)) return { name: this.team.lead.name, id: this.team.lead.id, isLead: true };
    if (!CARE_GROUPS.some((group) => identity.groups.includes(group))) return null;
    const rep = this.team.reps.find((r) => r.email && r.email.toLowerCase() === String(identity.sub).toLowerCase()) ?? this.team.reps[0];
    return { name: rep.name, id: rep.id, isLead: false };
  }
}
