import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { trimConversation, DEFAULT_BUDGET_CHARS, type TrimmableMessage } from './conversation';

const msg = (role: string, content: string): TrimmableMessage => ({ role, content });
const big = (role: string, n: number) => msg(role, 'x'.repeat(n));

describe('trimConversation', () => {
  test('leaves a short conversation untouched', () => {
    const input = [msg('system', 'rules'), msg('user', 'hello'), msg('assistant', 'hi')];
    const out = trimConversation(input);
    assert.equal(out.dropped, 0);
    assert.deepEqual(out.messages, input);
  });

  test('drops from the middle when over budget', () => {
    const input = [msg('system', 'rules'), ...Array.from({ length: 40 }, () => big('user', 3000))];
    const out = trimConversation(input);
    assert.ok(out.dropped > 0, 'should have dropped something');
    assert.ok(out.messages.length < input.length);
  });

  test('never drops a system message', () => {
    const input = [
      msg('system', 'rules'),
      msg('system', 'state'),
      ...Array.from({ length: 40 }, () => big('user', 3000)),
    ];
    const out = trimConversation(input);
    const systems = out.messages.filter(m => m.role === 'system' && m.content !== undefined);
    // Two originals plus the omission marker.
    assert.ok(systems.length >= 2);
    assert.ok(out.messages.some(m => m.content === 'rules'));
    assert.ok(out.messages.some(m => m.content === 'state'));
  });

  test('keeps the opening brief', () => {
    // Losing this is how the assistant forgets it is designing a bathroom.
    const input = [
      msg('system', 'rules'),
      msg('user', 'I am renovating a small ensuite in matte black'),
      ...Array.from({ length: 40 }, () => big('assistant', 3000)),
    ];
    const out = trimConversation(input);
    assert.ok(
      out.messages.some(m => m.content === 'I am renovating a small ensuite in matte black'),
      'the first user message must survive',
    );
  });

  test('keeps the most recent turn', () => {
    const input = [
      msg('system', 'rules'),
      ...Array.from({ length: 40 }, () => big('assistant', 3000)),
      msg('user', 'the newest question'),
    ];
    const out = trimConversation(input);
    assert.equal(out.messages[out.messages.length - 1].content, 'the newest question');
  });

  test('tells the model its history was abridged', () => {
    const input = [msg('system', 'rules'), ...Array.from({ length: 40 }, () => big('user', 3000))];
    const out = trimConversation(input);
    const marker = out.messages.find(m => typeof m.content === 'string' && m.content.includes('omitted'));
    assert.ok(marker, 'without this the model treats the gap as "nothing happened"');
    assert.equal(marker?.role, 'system');
  });

  test('preserves ordering', () => {
    const input = [
      msg('system', 'rules'),
      msg('user', 'first'),
      ...Array.from({ length: 30 }, () => big('assistant', 3000)),
      msg('user', 'last'),
    ];
    const out = trimConversation(input);
    const firstIdx = out.messages.findIndex(m => m.content === 'first');
    const lastIdx = out.messages.findIndex(m => m.content === 'last');
    assert.ok(firstIdx < lastIdx, 'the brief must still precede the newest turn');
  });

  test('stays within the budget', () => {
    const input = Array.from({ length: 100 }, () => big('user', 2000));
    const out = trimConversation(input, 20_000);
    const size = out.messages.reduce(
      (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0,
    );
    // Allow the omission marker's own length on top.
    assert.ok(size <= 20_000 + 400, `size ${size} should be within budget`);
  });

  test('measures array content rather than assuming a string', () => {
    // OpenAI allows content parts; counting these as zero would let a large
    // conversation slip past the budget entirely.
    const parts: TrimmableMessage = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] };
    const out = trimConversation([parts, parts, parts, parts], 4000);
    assert.ok(out.dropped > 0, 'array content must count toward the budget');
  });

  test('counts tool_calls toward the budget', () => {
    const withTools: TrimmableMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: '1', function: { name: 'search', arguments: 'y'.repeat(5000) } }],
    };
    const out = trimConversation([withTools, withTools, withTools], 4000);
    assert.ok(out.dropped > 0);
  });

  test('handles an empty conversation', () => {
    const out = trimConversation([]);
    assert.deepEqual(out.messages, []);
    assert.equal(out.dropped, 0);
  });

  test('reports an approximate token count', () => {
    const out = trimConversation([msg('user', 'x'.repeat(400))]);
    assert.ok(out.approxTokens > 0 && out.approxTokens < 400);
  });

  test('keeps system messages even when they alone exceed the budget', () => {
    // Nothing this function can do about an oversized prompt — but silently
    // dropping the rules would be far worse than sending a large request.
    const out = trimConversation([big('system', 60_000), msg('user', 'hi')], DEFAULT_BUDGET_CHARS);
    assert.ok(out.messages.some(m => m.role === 'system'));
  });
});
