import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRouter } from '../src/kernel/agent.router';

test('legacy stage and handoff labels cannot reroute a person away from the configured agent', () => {
  const release: any = { manifest: { packId: 'pack' }, defaultAgentId: 'sales', agents: [{ agentId: 'sales', name: 'Sales', purpose: 'Help the customer', allowedTools: [], modelPolicyRef: 'configured' }, { agentId: 'force_finance', name: 'Finance', purpose: 'Finance', allowedTools: [], modelPolicyRef: 'configured' }], journeys: [{ journeyId: 'old', initialStage: 'force_finance', stages: { force_finance: { handoffPolicy: { targetRole: 'Finance' } } } }] };
  const workspace: any = { journeyId: 'old', currentStage: 'force_finance' };
  const router = new AgentRouter();
  assert.equal(router.resolveAgent(release, workspace).agent.agentId, 'sales');
  delete release.journeys;
  assert.equal(router.resolveAgent(release, workspace).agent.agentId, 'sales');
  assert.equal(router.resolveAgent(release, workspace, 'force_finance').agent.agentId, 'force_finance');
});
