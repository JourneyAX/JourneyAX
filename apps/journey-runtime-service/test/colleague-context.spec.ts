import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { principalFrom } from '@journeyax/shared-types';
import { buildAgentSystemPrompt, formatCustomerContextMessage, formatWhoYouAreTalkingTo } from '../src/agent/agent-loop';
import { AgentRouter } from '../src/kernel/agent.router';
import { connectorPack, workspace } from './helpers/connector-pack';

delete process.env.MONGODB_URI;

const release = connectorPack(undefined);
(release as any).extensions.dashboard = { timeZone: 'Pacific/Auckland', entries: [] };
const router = new AgentRouter();
const resolve = (role?: string, groups: string[] = []) => {
  const principal = principalFrom({ userId: role ? `${role}@example.test` : 'guest', tenantId: 'test-tenant', role, groups });
  return { principal, resolvedAgent: router.resolveAgent(release, workspace(), 'front_desk', principal) };
};
const command = (role?: string, groups: string[] = []) => ({
  tenantId: 'test-tenant', environmentId: 'test', workspaceId: 'ws-1', sessionId: 'sess-1', correlationId: 'corr-1', message: 'What do they owe?',
  principalId: role ? `${role}@example.test` : undefined, principalRole: role, principalGroups: groups,
}) as any;
// 10 am on 30 October in Auckland, which is still 29 October in UTC: "today" must be the shop's day.
const NOW = new Date('2026-10-30T10:00:00+13:00');

describe('The assistant is told who it is talking to', () => {
  test('a member of staff gets a "Who you are talking to" block naming their team, placed after the agent\'s own instructions', () => {
    const { principal, resolvedAgent } = resolve('cs', ['customer-service']);
    const prompt = buildAgentSystemPrompt({ resolvedAgent, release, person: { audience: principal.audience, groups: principal.groups } });
    assert.match(prompt, /# Who you are talking to/);
    assert.match(prompt, /a colleague on the customer service team, not a customer/);
    assert.match(prompt, /This changes none of the hand-off conditions above/, 'the carve-out is for lookups only');
    assert.match(prompt, /damaged or missing freight, a safety fault or dangerous product, a refund, return or credit note on a dispatched order/, 'the situations a condition names are still handed off');
    assert.match(prompt, /A colleague who asks for a person gets one\./);
    assert.doesNotMatch(prompt, /do not apply to the colleague themselves|never hand a colleague's own question off/, 'the broad wording that could switch off real hand-offs is gone');
    assert.ok(prompt.indexOf('You help people.') < prompt.indexOf('# Who you are talking to'), 'the block follows the agent block, where the hand-off conditions are');
  });

  test('a shopper or a guest gets no such block, and the customer context keeps its shape', () => {
    const { principal, resolvedAgent } = resolve(undefined);
    const prompt = buildAgentSystemPrompt({ resolvedAgent, release, person: { audience: principal.audience, groups: principal.groups } });
    assert.doesNotMatch(prompt, /Who you are talking to/);
    assert.equal(formatWhoYouAreTalkingTo({ audience: 'shopper', groups: [] }), '');
    assert.equal(formatWhoYouAreTalkingTo(undefined), '');
    const context = formatCustomerContextMessage({ command: command(undefined), release, person: { audience: 'shopper', groups: [] }, now: NOW });
    assert.match(context, /^<customer_context>/);
    assert.match(context, /Customer Type: General/);
    assert.match(context, /Today: 2026-10-30 \(Pacific\/Auckland\)/);
    assert.match(context, /Cart Summary: Empty/);
    assert.match(context, /<\/customer_context>$/);
  });

  test('several teams are written as words, from the group ids, with no business word of the platform\'s own', () => {
    const block = formatWhoYouAreTalkingTo({ audience: 'staff', groups: ['sales-managers', 'finance'] });
    assert.match(block, /a colleague on the sales managers, finance team/);
    assert.doesNotMatch(block, /sales-managers/);
  });

  test('the per-turn context for staff is a colleague context: who they are, their team, the role code and today, and no "Customer Type"', () => {
    const context = formatCustomerContextMessage({ command: command('cs', ['customer-service']), release, person: { audience: 'staff', groups: ['customer-service'] }, now: NOW });
    assert.match(context, /^<colleague_context>/);
    assert.match(context, /Signed-in: Signed In \(cs@example\.test\)/);
    assert.match(context, /Colleague: a member of staff on the customer service team \(role code: cs\)/);
    assert.match(context, /Today: 2026-10-30 \(Pacific\/Auckland\)/);
    assert.match(context, /Cart Summary: Empty/, 'staff keep the cart and quote lines');
    assert.match(context, /Quote Summary: None/);
    assert.doesNotMatch(context, /Customer Type/);
    assert.doesNotMatch(context, /customer_context/);
    assert.match(context, /<\/colleague_context>$/);
  });

  test('without a time zone in the pack, or with one that is not a zone, today is written in UTC and says so', () => {
    const bare = connectorPack(undefined);
    assert.match(formatCustomerContextMessage({ command: command(undefined), release: bare, now: NOW }), /Today: 2026-10-29 \(UTC\)\n/, '10 am on the 30th in Auckland is still the 29th in UTC');
    const odd: any = connectorPack(undefined);
    odd.extensions.dashboard = { timeZone: 'Mars/Olympus' };
    assert.match(formatCustomerContextMessage({ command: command(undefined), release: odd, now: NOW }), /Today: 2026-10-29 \(UTC\)\n/, 'a name that is not a zone is not claimed');
  });

  test('the role code is the signed role only, never a customer type written into the facts, and a long list of teams is cut', () => {
    const withFacts = { ...command('cs', ['customer-service']), inputFacts: { customerType: 'finance' } };
    const context = formatCustomerContextMessage({ command: withFacts, release, person: { audience: 'staff', groups: ['customer-service'] }, now: NOW });
    assert.match(context, /\(role code: cs\)/);
    assert.doesNotMatch(context, /role code: finance/);
    const many = formatWhoYouAreTalkingTo({ audience: 'staff', groups: Array.from({ length: 20 }, (_, i) => `team-${i}`) });
    assert.match(many, /team 0, team 1, team 2, team 3, team 4, team 5 team/);
    assert.doesNotMatch(many, /team 6/);
  });
});
