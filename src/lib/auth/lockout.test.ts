import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLock, recordFailure, recordSuccess, clearLock, __resetLockouts,
  MAX_ATTEMPTS, LOCK_MS, ATTEMPT_WINDOW_MS,
} from './lockout';

describe('lockout', () => {
  beforeEach(() => __resetLockouts());

  test('an unknown account is not locked', () => {
    const s = checkLock('nobody');
    assert.equal(s.locked, false);
    assert.equal(s.remaining, MAX_ATTEMPTS);
  });

  test('counts down remaining attempts', () => {
    assert.equal(recordFailure('alice').remaining, MAX_ATTEMPTS - 1);
    assert.equal(recordFailure('alice').remaining, MAX_ATTEMPTS - 2);
  });

  test('locks on the configured attempt', () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      assert.equal(recordFailure('alice').locked, false, `attempt ${i + 1}`);
    }
    const final = recordFailure('alice');
    assert.equal(final.locked, true);
    assert.ok(final.retryAfter > 0);
  });

  test('locks per account, not globally', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure('alice');
    assert.equal(checkLock('alice').locked, true);
    assert.equal(checkLock('bob').locked, false, 'one account must not lock another');
  });

  test('is case-insensitive, so casing cannot dodge the lock', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure('alice');
    assert.equal(checkLock('ALICE').locked, true);
  });

  test('a successful sign-in clears the record', () => {
    recordFailure('alice');
    recordFailure('alice');
    recordSuccess('alice');
    assert.equal(checkLock('alice').remaining, MAX_ATTEMPTS);
  });

  test('the lock expires', () => {
    const t0 = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure('alice', t0);
    assert.equal(checkLock('alice', t0).locked, true);
    assert.equal(checkLock('alice', t0 + LOCK_MS + 1000).locked, false, 'must not lock permanently');
  });

  test('old failures fall out of the window', () => {
    const t0 = Date.now();
    // Four failures long ago, then one now — should not lock.
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) recordFailure('alice', t0);
    const later = t0 + ATTEMPT_WINDOW_MS + 1000;
    assert.equal(recordFailure('alice', later).locked, false);
  });

  test('an administrator can clear a lock', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailure('alice');
    clearLock('alice');
    assert.equal(checkLock('alice').locked, false);
  });
});
