import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { ConnectorWriteBack, type CareActor } from '../src/care/care.writeback';
import { ConnectorCallError, type ConnectorCaller } from '../src/care/connector-rpc';
import type { CareCase, CareStep } from '../src/care/care.types';

/**
 * The write-back that carries out an approved ticket through the connector server: exactly the steps the playbook proposes, the reply is the
 * draft the person approved, nothing outside that list can run, and a refusal from the system is said plainly and stops that step.
 */
const suite = createSuite('care: the write-back carries out only the approved steps, through the connector server');
const TENANT = 'placemakers';
const aroha: CareActor = { name: 'Aroha Ngata', id: 'CSR-1041', isLead: false };
const doc = { zendeskId: 4322 } as unknown as CareCase;
const step = (over: Partial<CareStep>): CareStep => ({ id: 's1', system: 'Zendesk', kind: 'customer', what: 'x', action: { tool: 'reply_to_ticket', args: { ticketId: 4322, status: 'pending' } }, ...over });

const recorder = (refuse?: string) => {
  const calls: Array<{ connector: string; tool: string; args: Record<string, unknown>; tenantId: string }> = [];
  const caller: ConnectorCaller = {
    async call(connector, tool, args, tenantId) {
      calls.push({ connector, tool, args, tenantId });
      if (refuse === `${connector}.${tool}`) throw new ConnectorCallError('Zendesk is not available.', 'unavailable');
      return { ok: true };
    },
  };
  return { calls, writeBack: new ConnectorWriteBack(caller) };
};

async function main() {
  await suite.test('the reply goes out as the approved draft, signed as the person who approved, and the ticket moves to the proposed status', async () => {
    const { calls, writeBack } = recorder();
    const result = await writeBack.run(TENANT, doc, step({}), { draft: 'Kia ora Ruth, your order is on its way.', actor: aroha });
    assert.equal(result.ok, true);
    assert.equal(result.message, 'Reply sent to the customer. Ticket 4322 is now pending.');
    assert.deepEqual(calls, [{ connector: 'zendesk', tool: 'reply_to_ticket', tenantId: TENANT, args: { ticketId: 4322, status: 'pending', body: 'Kia ora Ruth, your order is on its way.', author: 'Aroha Ngata' } }]);
  });

  await suite.test('an empty reply is never sent', async () => {
    const { calls, writeBack } = recorder();
    const result = await writeBack.run(TENANT, doc, step({}), { draft: '   ', actor: aroha });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });

  await suite.test('the order note and the case are made in their own systems, and the case is tied to the ticket', async () => {
    const { calls, writeBack } = recorder();
    const note = await writeBack.run(TENANT, doc, step({ id: 's2', system: 'commercetools', kind: 'internal', action: { tool: 'add_order_note', args: { orderNumber: 'OPP-0007', note: 'Delivery reported in ticket 4322.' } } }), { draft: 'x', actor: aroha });
    const made = await writeBack.run(TENANT, doc, step({ id: 's3', system: 'Salesforce', kind: 'record', action: { tool: 'create_case', args: { subject: 'Delivery: Where is my order?' } } }), { draft: 'x', actor: aroha });
    assert.equal(note.ok && made.ok, true);
    assert.deepEqual(calls.map((c) => `${c.connector}.${c.tool}`), ['commercetools.add_order_note', 'salesforce.create_case']);
    assert.equal(calls[1].args.ticketId, 4322);
  });

  await suite.test('a tool the playbook never proposes, or one in the wrong system, is refused without any call', async () => {
    const { calls, writeBack } = recorder();
    const wrongTool = await writeBack.run(TENANT, doc, step({ action: { tool: 'delete_ticket', args: { ticketId: 4322 } } }), { draft: 'x', actor: aroha });
    const wrongSystem = await writeBack.run(TENANT, doc, step({ system: 'Salesforce' }), { draft: 'x', actor: aroha });
    const noAction = await writeBack.run(TENANT, doc, step({ action: undefined }), { draft: 'x', actor: aroha });
    assert.deepEqual([wrongTool.ok, wrongSystem.ok, noAction.ok], [false, false, false]);
    assert.match(String(wrongTool.message), /Nothing was changed/);
    assert.equal(calls.length, 0);
  });

  await suite.test('when the system refuses, the step fails with its answer so the person can retry from it', async () => {
    const { writeBack } = recorder('zendesk.reply_to_ticket');
    const result = await writeBack.run(TENANT, doc, step({}), { draft: 'Hello', actor: aroha });
    assert.equal(result.ok, false);
    assert.equal(result.message, 'Zendesk did not accept it: Zendesk is not available.');
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
