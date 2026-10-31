/**
 * Claude's newer models refuse a temperature setting (HTTP 400 "`temperature` is deprecated for this model"); earlier ones still take it.
 */
import assert from 'node:assert/strict';
import { anthropicTemperature } from '../src/kernel/model.gateway';

for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'Claude-Sonnet-5']) {
  assert.deepEqual(anthropicTemperature(model, 0.4), {}, `${model} is sent no temperature`);
}
for (const model of ['claude-haiku-4-5', 'claude-3-5-sonnet', 'claude-sonnet-4-5', 'claude-opus-4-1']) {
  assert.deepEqual(anthropicTemperature(model, 0.4), { temperature: 0.4 }, `${model} keeps the pack's temperature`);
}
assert.deepEqual(anthropicTemperature('claude-haiku-4-5', undefined), { temperature: 0.2 }, 'the gateway default applies when the pack gives none');
console.log('✅ anthropic temperature: newer Claude models get none, earlier ones keep the pack value');
