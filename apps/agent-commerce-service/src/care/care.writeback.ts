/**
 * What happens after a named person approves: each step of the approved list is carried out in the system it names. This is the only place in the
 * care module that changes anything outside our own case files, and it runs only from an approval.
 *
 * `UnavailableWriteBack` is what runs until the write tools are switched on: it changes nothing and says so, so an approval never looks as if it
 * had done something it had not.
 */
import type { CareCase, CareStep } from './care.types';
import type { ConnectorCaller } from './connector-rpc';

export interface CareActor { name: string; id: string; isLead: boolean }
export interface WriteResult { ok: boolean; message?: string }

export interface CareWriteBack {
  run(tenantId: string, doc: CareCase, step: CareStep, ctx: { draft: string; actor: CareActor }): Promise<WriteResult>;
}

export class UnavailableWriteBack implements CareWriteBack {
  async run(_tenantId: string, _doc: CareCase, step: CareStep): Promise<WriteResult> {
    return { ok: false, message: `Changing ${step.system} from here is not switched on yet. Nothing was changed.` };
  }
}

const CONNECTOR_OF: Record<string, string> = { Zendesk: 'zendesk', commercetools: 'commercetools', Salesforce: 'salesforce' };

/**
 * The only changes the write-back will ever make: the ones the playbook proposes (`stepsFor`), each in the one system it names. Anything else a
 * step might carry is refused, so a step can never reach a tool the care desk was not built to use.
 */
const ALLOWED_TOOLS = new Set([
  'zendesk.reply_to_ticket', 'zendesk.update_ticket',
  'commercetools.cancel_order', 'commercetools.add_order_note',
  'salesforce.create_case', 'salesforce.create_task',
]);

const done = (step: CareStep, args: Record<string, unknown>): string => {
  switch (step.action?.tool) {
    case 'reply_to_ticket': return `Reply sent to the customer. Ticket ${args.ticketId} is now ${String(args.status ?? 'updated')}.`;
    case 'update_ticket': return `Ticket ${args.ticketId} handed to the team lead with a note.`;
    case 'cancel_order': return `Order ${args.orderNumber} cancelled.`;
    case 'add_order_note': return `Note added on order ${args.orderNumber}.`;
    case 'create_case': return 'Case logged in Salesforce.';
    case 'create_task': return 'Task created for the account manager.';
    default: return 'Done.';
  }
};

/**
 * Carries out each approved step through the connector server (the same door the care desk reads through). It is only switched on with
 * `CARE_WRITEBACK=connectors`, and only does something when that connector server has the write tools; against a server without them every step
 * fails with the server's own answer and nothing is changed. The reply text is exactly the draft the person approved.
 */
export class ConnectorWriteBack implements CareWriteBack {
  constructor(private readonly connectors: ConnectorCaller) {}

  async run(tenantId: string, doc: CareCase, step: CareStep, ctx: { draft: string; actor: CareActor }): Promise<WriteResult> {
    const connector = CONNECTOR_OF[step.system];
    const action = step.action;
    if (!connector || !action || !ALLOWED_TOOLS.has(`${connector}.${action.tool}`)) return { ok: false, message: `${step.system} cannot be changed that way from here. Nothing was changed.` };
    const args: Record<string, unknown> = { ...action.args };
    if (action.tool === 'reply_to_ticket') {
      if (!ctx.draft.trim()) return { ok: false, message: 'There is no reply to send. Nothing was changed.' };
      args.body = ctx.draft;
      args.author = ctx.actor.name;
    }
    if (action.tool === 'create_case' || action.tool === 'create_task') args.ticketId = doc.zendeskId;
    try {
      await this.connectors.call(connector, action.tool, args, tenantId);
      return { ok: true, message: done(step, args) };
    } catch (error: any) {
      return { ok: false, message: `${step.system} did not accept it: ${String(error?.message || error).slice(0, 160)}` };
    }
  }
}
