/**
 * Try again and edit name the earlier message a new one continues from. That name has to survive every hop between the browser and the
 * runtime (each service passes on only the fields it knows), and the runtime has to accept it.
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CanonicalRuntimeAdapter } from '../src/runtime/canonical-runtime.adapter';
import { JourneyCoordinator } from '../src/orchestration/journey-coordinator';
import { LegacyJourneyAdapter } from '../src/legacy/legacy-journey-adapter';
import { ConfigLoader } from '../src/pipeline/config-loader';
import { TurnCommandRequestSchema } from '../../journey-runtime-service/src/dto/turn.dto';

async function main() {
  const seen: Array<{ url: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url || '', body: JSON.parse(raw || '{}') });
      if ((req.url || '').endsWith('/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('event: done\ndata: {"messageIds":{"customer":"t2:customer","assistant":"t2:assistant"},"response":"ok"}\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ assistantMessage: 'ok' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.JOURNEY_RUNTIME_SERVICE_URL = `http://127.0.0.1:${port}`;

  try {
    const adapter = new CanonicalRuntimeAdapter();
    const command: any = {
      tenantId: 'placemakers', environmentId: 'production', workspaceId: 'ws1', sessionId: 's1', turnId: 't2', correlationId: 'c1',
      principalId: 'anonymous', principalRole: 'customer', message: 'actually a corded one', parentMessageId: 't1:assistant',
    };

    const events: Array<{ event: string; data: any }> = [];
    await adapter.streamTurn(command, (event, data) => events.push({ event, data }));
    assert.equal(seen[0].body.parentMessageId, 't1:assistant', 'the streamed turn names the message it continues from');
    const done = events.find((e) => e.event === 'done');
    assert.deepEqual(done?.data.messageIds, { customer: 't2:customer', assistant: 't2:assistant' }, 'the ids the runtime reports are passed back');

    await adapter.runTurn(command);
    assert.equal(seen[1].body.parentMessageId, 't1:assistant', 'and so does the buffered turn');

    await adapter.streamTurn({ ...command, parentMessageId: undefined }, () => {});
    assert.ok(!('parentMessageId' in seen[2].body), 'a turn that continues from the newest message names nothing');

    // The runtime accepts what the adapter sends, including "start over from the first message".
    for (const parentMessageId of ['t1:assistant', 'root']) {
      const parsed = TurnCommandRequestSchema.safeParse({ ...seen[0].body, parentMessageId });
      assert.equal(parsed.success, true, `the runtime accepts parentMessageId "${parentMessageId}"`);
      assert.equal((parsed as any).data.parentMessageId, parentMessageId);
    }

    // The coordinator, which builds the command from the request, keeps it too (both the streamed and the buffered turn).
    const commands: any[] = [];
    const canonical: any = {
      runTurn: async (cmd: any) => { commands.push(cmd); return { assistantMessage: 'ok', trace: {} }; },
      streamTurn: async (cmd: any, emit: any) => { commands.push(cmd); emit('done', { sessionId: cmd.sessionId }); },
    };
    const coordinator = new JourneyCoordinator({ resolveActivation: async () => ({ action: 'CANONICAL' }) } as any, canonical, new LegacyJourneyAdapter(), new ConfigLoader(), undefined as any);
    await coordinator.executeChat({ tenantId: 'placemakers', message: 'hi', parentMessageId: 'root' } as any);
    await coordinator.executeChatStream({ tenantId: 'placemakers', message: 'hi', parentMessageId: 't1:assistant' } as any, () => {});
    assert.deepEqual(commands.map((c) => c.parentMessageId), ['root', 't1:assistant']);
  } finally {
    server.close();
  }
  console.log('✅ commerce service: the message a turn continues from reaches the runtime, and the new ids come back');
}

main().catch((error) => { console.error(error); process.exit(1); });
