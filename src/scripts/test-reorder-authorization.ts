import assert from 'node:assert/strict';
import { filterOrdersForViewer, resolveReorderViewer } from '../lib/reorder-authorization';

const localRequest = new Request('http://localhost/api/reorder-orders');
const signedOutViewer = resolveReorderViewer(localRequest, { nodeEnv: 'development' });
assert.equal(signedOutViewer, null, 'Development must stay signed out unless demo mode is explicitly enabled.');

const localViewer = resolveReorderViewer(localRequest, { nodeEnv: 'development', demoMode: 'true' });
assert(localViewer, 'Explicit demo mode should receive the deterministic demo viewer.');
assert.deepEqual(localViewer.schools, ['Lakeshore Central High School']);

const records = [
  { id: 'S1', school: 'Lakeshore Central High School' },
  { id: 'S2', school: 'Oswego East High School' },
];
assert.deepEqual(filterOrdersForViewer(records, localViewer).map((record) => record.id), ['S1']);

const productionAnonymous = resolveReorderViewer(localRequest, { nodeEnv: 'production', demoMode: 'false' });
assert.equal(productionAnonymous, null, 'Production must fail closed without an authenticated and authorized viewer.');

const configuredUsers = JSON.stringify([{
  id: 'user-1',
  email: 'coach@lakeshore.example',
  name: 'Coach Rivera',
  role: 'coach',
  schools: ['Lakeshore Central High School'],
}]);
const authenticatedRequest = new Request('https://journeyax.example/api/reorder-orders', {
  headers: {
    'oai-authenticated-user-id': 'user-1',
    'oai-authenticated-user-email': 'coach@lakeshore.example',
  },
});
const authenticatedViewer = resolveReorderViewer(authenticatedRequest, {
  nodeEnv: 'production',
  authorizedUsersJson: configuredUsers,
});
assert.equal(authenticatedViewer?.source, 'authenticated-header');
assert.equal(authenticatedViewer?.name, 'Coach Rivera');

const unknownRequest = new Request('https://journeyax.example/api/reorder-orders', {
  headers: {
    'oai-authenticated-user-id': 'unknown',
    'oai-authenticated-user-email': 'unknown@example.com',
  },
});
assert.equal(resolveReorderViewer(unknownRequest, {
  nodeEnv: 'production',
  authorizedUsersJson: configuredUsers,
}), null, 'An authenticated but unauthorized viewer must not receive school data.');

console.log('Reorder authorization checks passed.');
