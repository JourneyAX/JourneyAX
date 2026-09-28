import assert from 'node:assert/strict';
import { JourneyEngine } from '../src/journey/journey-engine';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { WorkspaceState } from '@journeyax/journey-core';

console.log('🧪 Running Agent Commerce JourneyEngine Negative & Multi-Journey Suite...');

const journeyEngine = new JourneyEngine();

// Multi-journey release fixture
const multiJourneyRelease: BusinessPackRelease = {
  manifest: {
    packId: 'pack_multi_journey_commerce',
    version: '1.0.0',
    title: 'Multi Journey Commerce Fixture',
    description: 'Fixture with multiple distinct journeys to prove no positional fallbacks',
    domain: 'commerce',
  },
  journeys: [
    {
      journeyId: 'journey_alpha_pos0',
      title: 'Journey Alpha (Position 0)',
      description: 'The first journey at index 0',
      initialStage: 'alpha_stage_intake',
      stages: {
        alpha_stage_intake: {
          title: 'Alpha Intake',
          description: 'Alpha Intake Stage',
          requiredFacts: ['alpha_fact_one'],
          allowedCapabilities: ['cap_alpha_action'],
        },
      },
    },
    {
      journeyId: 'journey_beta_pos1',
      title: 'Journey Beta (Position 1)',
      description: 'The second journey at index 1',
      initialStage: 'beta_stage_intake',
      stages: {
        beta_stage_intake: {
          title: 'Beta Intake',
          description: 'Beta Intake Stage',
          requiredFacts: ['beta_fact_one'],
          allowedCapabilities: ['cap_beta_action'],
        },
      },
    },
    {
      journeyId: 'journey_gamma_pos2',
      title: 'Journey Gamma (Position 2)',
      description: 'The third journey at index 2',
      initialStage: 'gamma_stage_intake',
      stages: {
        gamma_stage_intake: {
          title: 'Gamma Intake',
          description: 'Gamma Intake Stage',
          requiredFacts: ['gamma_fact_one'],
          allowedCapabilities: ['cap_gamma_action'],
        },
      },
    },
  ],
  capabilities: {
    toolDefinitions: [],
    toolBindings: [],
    stageBindings: [],
  },
};

// 1. Negative Test: Missing workspace.journeyId returns typed handoff (never selects journeys[0])
console.log('1. Testing missing workspace.journeyId on multi-journey pack...');
const wsMissingJourney: WorkspaceState = {
  workspaceId: 'ws-missing-journey',
  sessionId: 'sess-missing-journey',
  tenantId: 'tenant-commerce-01',
  environmentId: 'production',
  facts: {},
  appliedEvents: [],
  openQuestions: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const decisionMissing = journeyEngine.decide(multiJourneyRelease, wsMissingJourney);
assert.equal(decisionMissing.type, 'handoff', 'Missing journeyId must return typed handoff');
assert.equal((decisionMissing.payload as any).error, 'Missing journeyId', 'Must return error: Missing journeyId');
console.log('   ✅ PASS: Missing journeyId fails closed without selecting journeys[0].');

// 2. Negative Test: Unknown workspace.journeyId returns typed handoff (never selects journeys[0])
console.log('2. Testing unknown workspace.journeyId on multi-journey pack...');
const wsUnknownJourney: WorkspaceState = {
  ...wsMissingJourney,
  workspaceId: 'ws-unknown-journey',
  journeyId: 'journey_nonexistent_xyz',
};

const decisionUnknown = journeyEngine.decide(multiJourneyRelease, wsUnknownJourney);
assert.equal(decisionUnknown.type, 'handoff', 'Unknown journeyId must return typed handoff');
assert.equal((decisionUnknown.payload as any).error, 'Unknown journeyId', 'Must return error: Unknown journeyId');
assert.ok(decisionUnknown.reason?.includes('journey_nonexistent_xyz'), 'Reason must mention unknown journey ID');
console.log('   ✅ PASS: Unknown journeyId fails closed without selecting journeys[0].');

// 3. Positive Test: Explicit journeyId selects exact matching journey and never defaults to position 0
console.log('3. Testing explicit selection in multi-journey pack (proving non-positional routing)...');

// Select position 1 (Beta)
const wsBeta: WorkspaceState = {
  ...wsMissingJourney,
  workspaceId: 'ws-beta',
  journeyId: 'journey_beta_pos1',
};
const decisionBeta = journeyEngine.decide(multiJourneyRelease, wsBeta);
assert.equal(decisionBeta.type, 'ask_fact', 'Journey Beta should ask required fact');
assert.deepEqual(
  (decisionBeta.payload as any).missingFacts,
  ['beta_fact_one'],
  'Must require beta_fact_one from journey_beta_pos1, NEVER alpha_fact_one from journeys[0]'
);
assert.equal((decisionBeta.payload as any).stage, 'beta_stage_intake');
console.log('   ✅ PASS: journey_beta_pos1 evaluated correctly (NOT journeys[0]).');

// Select position 2 (Gamma)
const wsGamma: WorkspaceState = {
  ...wsMissingJourney,
  workspaceId: 'ws-gamma',
  journeyId: 'journey_gamma_pos2',
};
const decisionGamma = journeyEngine.decide(multiJourneyRelease, wsGamma);
assert.equal(decisionGamma.type, 'ask_fact', 'Journey Gamma should ask required fact');
assert.deepEqual(
  (decisionGamma.payload as any).missingFacts,
  ['gamma_fact_one'],
  'Must require gamma_fact_one from journey_gamma_pos2, NEVER alpha_fact_one from journeys[0]'
);
assert.equal((decisionGamma.payload as any).stage, 'gamma_stage_intake');
console.log('   ✅ PASS: journey_gamma_pos2 evaluated correctly (NOT journeys[0]).');

// 4. Negative Test: Unknown stage in journey returns typed handoff
console.log('4. Testing unknown stage in valid journey...');
const wsInvalidStage: WorkspaceState = {
  ...wsBeta,
  currentStage: 'stage_that_does_not_exist',
};
const decisionInvalidStage = journeyEngine.decide(multiJourneyRelease, wsInvalidStage);
assert.equal(decisionInvalidStage.type, 'handoff', 'Invalid stage must return handoff');
assert.equal((decisionInvalidStage.payload as any).error, 'Unknown stage');
console.log('   ✅ PASS: Unknown stage in valid journey fails closed.');

console.log('\n🎉 ALL AGENT COMMERCE JOURNEY ENGINE TESTS PASSED!');
