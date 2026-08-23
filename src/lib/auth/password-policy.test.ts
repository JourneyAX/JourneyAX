import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkPassword, MIN_LENGTH } from './password-policy';

describe('checkPassword', () => {
  test('accepts a decent passphrase', () => {
    assert.equal(checkPassword('thistle-marble-ocean-71').ok, true);
  });

  test('rejects anything too short', () => {
    assert.equal(checkPassword('short1!').ok, false);
    assert.equal(checkPassword('a'.repeat(MIN_LENGTH - 1)).ok, false);
  });

  test('rejects obvious choices regardless of decoration', () => {
    for (const bad of ['Password123456', 'letmein-please-now', 'qwertyqwerty12']) {
      assert.equal(checkPassword(bad).ok, false, `should reject ${bad}`);
    }
  });

  test('rejects product names, which people reach for first', () => {
    assert.equal(checkPassword('journeyax-rocks-2026').ok, false);
    assert.equal(checkPassword('augusta-sports-wear').ok, false);
  });

  test('rejects a password containing the username', () => {
    assert.equal(checkPassword('alice-in-wonderland', 'alice').ok, false);
  });

  test('a short username is not matched, to avoid false positives', () => {
    assert.equal(checkPassword('thistle-marble-ocean-71', 'al').ok, true);
  });

  test('rejects a single repeated character however long', () => {
    assert.equal(checkPassword('aaaaaaaaaaaaaaaaaaaa').ok, false);
  });

  test('rejects a tiny character set', () => {
    assert.equal(checkPassword('abababababababab').ok, false);
  });

  test('reports every problem, not just the first', () => {
    assert.ok(checkPassword('pass', 'pass').problems.length >= 2);
  });
});
