import assert from 'node:assert/strict';
import { buildOkfContent } from './fixtures';
import { buildServerOwnedOkfContent, computeKnowledgeEntityHash, evaluateOkfDraft } from '../src';

const fixture = buildOkfContent();
const { index: _clientIndex, evaluation: _clientEvaluation, ...draft } = fixture;
const scope = { tenantId: 'placemakers', environmentId: 'test', releaseId: 'okf-test', evaluatedAt: '2026-10-01T00:00:00.000Z' };
const built = buildServerOwnedOkfContent(draft, scope);
assert.notEqual(built.index.indexChecksum, fixture.index.indexChecksum);
assert.notEqual(built.evaluation.reportId, fixture.evaluation.reportId);
assert.equal(built.evaluation.passed, true);
assert.equal(built.evaluation.scenarioCount, evaluateOkfDraft(draft, scope.tenantId, scope.environmentId, scope.releaseId, scope.evaluatedAt).length);
assert.deepEqual(buildServerOwnedOkfContent(draft, scope), built, 'same draft and timestamp must be retry-stable');

const unsafe = structuredClone(draft);
const screws = unsafe.concepts.find((concept) => concept.conceptId.endsWith('/fastenings/screws'))!;
screws.safety.blocksProducts = true;
screws.contentHash = computeKnowledgeEntityHash(screws);
assert.throws(() => buildServerOwnedOkfContent(unsafe, scope), /publication evaluation failed.*safety/);
console.log('✅ OKF server evaluation: 3 passed, 0 failed');
