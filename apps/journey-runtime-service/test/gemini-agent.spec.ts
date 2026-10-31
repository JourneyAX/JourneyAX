/**
 * Gemini as the model that answers with tools: the request it is sent, the stream it sends back, and a full round trip through the
 * gateway against a stand-in Gemini server (no network, no key).
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelGateway, type AgentMessage } from '../src/kernel/model.gateway';
import { buildGeminiAgentBody, geminiContents, geminiStreamEndpoint, geminiThinkingConfig, newGeminiStreamState, readGeminiChunk } from '../src/kernel/gemini-agent';

// ── 1. The conversation as Gemini contents ───────────────────────────────────────────────────────────────────────────────────────────────
{
  const messages: AgentMessage[] = [
    { role: 'user', content: '[Previous Conversation History]\nCustomer: hello' },
    { role: 'user', content: 'cordless drill for concrete' },
    { role: 'assistant', content: 'Let me look.', tool_calls: [
      { id: 'c1', name: 'search_products', arguments: { query: 'drill' }, thoughtSignature: 'SIG-1' },
      { id: 'c2', name: 'get_warranty', arguments: { sku: '5009059' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ count: 2, items: ['a', 'b'] }) },
    { role: 'tool', tool_call_id: 'c2', content: 'plain text result' },
  ];
  const contents = geminiContents(messages);
  assert.deepEqual(contents.map((c) => c.role), ['user', 'model', 'user'], 'roles alternate; the two opening user messages are one');
  assert.equal(contents[0].parts.length, 2);
  const call = contents[1].parts.find((p) => p.functionCall?.name === 'search_products');
  assert.equal(call.thoughtSignature, 'SIG-1', 'the signature goes back with its call');
  assert.equal(contents[1].parts.find((p) => p.functionCall?.name === 'get_warranty').thoughtSignature, undefined, 'a call without one gets none');
  assert.equal(contents[2].parts.length, 2, 'both results go back together');
  assert.deepEqual(contents[2].parts[0].functionResponse, { name: 'search_products', response: { count: 2, items: ['a', 'b'] } }, 'a JSON object result stays an object');
  assert.deepEqual(contents[2].parts[1].functionResponse, { name: 'get_warranty', response: { result: 'plain text result' } }, 'text is wrapped in an object');
}

// ── 2. The request ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const tools = [
    { name: 'search_products', description: 'Find products', parameters: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'review_cart', description: 'Show the cart', parameters: { type: 'object' as const, properties: {} } },
  ];
  const body = buildGeminiAgentBody({ systemPrompt: 'You are the team.', messages: [{ role: 'user', content: 'hi' }], tools }, { model: 'gemini-2.5-flash', temperature: 0.4, maxOutputTokens: 2000, reasoningEffort: 'none' });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'You are the team.' }] });
  assert.equal(body.generationConfig.temperature, 0.4);
  assert.equal(body.generationConfig.maxOutputTokens, 2000);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 }, '"none" turns 2.5 Flash thinking off');
  assert.equal(body.tools[0].functionDeclarations[0].parametersJsonSchema.required[0], 'query');
  assert.equal('parametersJsonSchema' in body.tools[0].functionDeclarations[1], false, 'a tool with no parameters sends none');
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
  const three = buildGeminiAgentBody({ messages: [{ role: 'user', content: 'hi' }] }, { model: 'gemini-3.8-flash', temperature: 0.4, reasoningEffort: 'none' });
  assert.equal('temperature' in three.generationConfig, false, 'Gemini 3 keeps its own temperature');
  assert.deepEqual(three.generationConfig.thinkingConfig, { thinkingLevel: 'low' }, 'Gemini 3.8 Flash refuses "minimal", so "none" becomes the lowest level every Gemini 3 model takes');
  assert.equal(geminiThinkingConfig('gemini-3.8-flash', 'high'), undefined, 'higher efforts leave the model\'s own default');
  assert.equal('tools' in three, false);
  assert.equal(geminiThinkingConfig('gemini-2.5-pro', 'none'), undefined, 'a model that cannot switch thinking off is left alone');
  assert.equal(geminiStreamEndpoint('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
}

// ── 3. Reading the stream ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const state = newGeminiStreamState();
  const deltas: string[] = [];
  readGeminiChunk({ candidates: [{ content: { parts: [{ text: 'Looking ' }, { text: 'now.', thought: false }] } }] }, state, (t) => deltas.push(t));
  readGeminiChunk({ candidates: [{ content: { parts: [{ text: 'private reasoning', thought: true }] } }] }, state, (t) => deltas.push(t));
  readGeminiChunk({ candidates: [{ content: { parts: [{ functionCall: { name: 'search_products', args: { query: 'drill' } }, thoughtSignature: 'SIG-9' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 30, thoughtsTokenCount: 70, totalTokenCount: 1300 } }, state, (t) => deltas.push(t));
  assert.equal(state.content, 'Looking now.');
  assert.deepEqual(deltas, ['Looking ', 'now.'], 'thought summaries are not shown');
  assert.equal(state.toolCalls.length, 1);
  assert.deepEqual({ name: state.toolCalls[0].name, args: state.toolCalls[0].args, sig: state.toolCalls[0].thoughtSignature }, { name: 'search_products', args: { query: 'drill' }, sig: 'SIG-9' });
  assert.deepEqual(state.usage, { promptTokens: 1200, completionTokens: 100, totalTokens: 1300 }, 'thinking tokens count as output');
  assert.equal(state.finishReason, 'STOP');
}

// ── 4. A full round trip through the gateway against a stand-in server ──────────────────────────────────────────────────────────────────
(async () => {
  const seen: Array<{ url: string; key: string | undefined; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url || '', key: req.headers['x-goog-api-key'] as string | undefined, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const last = body.contents[body.contents.length - 1];
      const answered = last.parts.some((p: any) => p.functionResponse);
      const chunks = answered
        ? [{ candidates: [{ content: { role: 'model', parts: [{ text: 'The Makita kit suits concrete.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8 } }]
        : [{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_products', args: { query: 'drill' } }, thoughtSignature: 'SIG-RT' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5 } }];
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.GOOGLE_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
  process.env.GEMINI_API_KEY = 'test-key';

  const release: any = {
    manifest: { packId: 'p', tenantId: 't', environmentId: 'test', version: '1', name: 'p', status: 'active', publishedAt: new Date().toISOString(), publishedBy: 'test', checksum: 'x' },
    modelPolicy: {
      version: '1.0.0', defaultPolicy: 'agent_turn',
      policies: [{ policyId: 'agent_turn', description: 'agent', candidates: [{ provider: 'google', model: 'gemini-2.5-flash', priority: 1, temperature: 0.3 }], dataResidency: 'au', acceptedResidencies: ['au'], maxInputTokens: 100000, maxOutputTokens: 2000, fallbackAllowed: false, timeoutMs: 15000 }],
    },
  };
  const tools = [{ name: 'search_products', description: 'Find products', parameters: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] } }];
  const gateway = new ModelGateway();
  try {
    const first = await gateway.executeAgentStream(release, { taskType: 'agent_turn', systemPrompt: 'Be helpful.', messages: [{ role: 'user', content: 'drill for concrete' }], tools }, () => {});
    assert.equal(first.route.provider, 'google');
    assert.equal(seen[0].url, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    assert.equal(seen[0].key, 'test-key', 'the key is sent as a header, never in the address');
    assert.equal(first.toolCalls.length, 1);
    assert.equal(first.toolCalls[0].name, 'search_products');
    assert.deepEqual(first.toolCalls[0].arguments, { query: 'drill' });
    assert.equal(first.toolCalls[0].thoughtSignature, 'SIG-RT');
    assert.deepEqual(first.usage, { promptTokens: 40, completionTokens: 5, totalTokens: 45 });

    const deltas: string[] = [];
    const second = await gateway.executeAgentStream(release, {
      taskType: 'agent_turn', systemPrompt: 'Be helpful.', tools,
      messages: [
        { role: 'user', content: 'drill for concrete' },
        { role: 'assistant', tool_calls: first.toolCalls },
        { role: 'tool', tool_call_id: first.toolCalls[0].id, content: JSON.stringify({ count: 1 }) },
      ],
    }, (t) => deltas.push(t));
    assert.equal(second.content, 'The Makita kit suits concrete.');
    assert.deepEqual(deltas, ['The Makita kit suits concrete.']);
    const sent = seen[1].body.contents;
    assert.deepEqual(sent.map((c: any) => c.role), ['user', 'model', 'user']);
    assert.equal(sent[1].parts[0].thoughtSignature, 'SIG-RT', 'the signature came back with the call');
    assert.deepEqual(sent[2].parts[0].functionResponse, { name: 'search_products', response: { count: 1 } });
  } finally {
    server.close();
  }
  console.log('✅ gemini agent: contents, request, stream reading and a round trip through the gateway');
})().catch((error) => { console.error(error); process.exit(1); });
