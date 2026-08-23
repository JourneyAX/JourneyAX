import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode, base32Decode, generateSecret, codeForStep, currentCode,
  verifyCode, stepFor, otpauthUri, generateRecoveryCodes, normalizeRecoveryCode,
  TOTP_STEP_SECONDS,
} from './totp';

describe('base32', () => {
  test('round-trips', () => {
    const buf = Buffer.from('hello totp world');
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  });

  test('tolerates spaces, dashes and lowercase from a phone screen', () => {
    const secret = generateSecret();
    const messy = secret.toLowerCase().replace(/(.{4})/g, '$1 ').trim();
    assert.deepEqual(base32Decode(messy), base32Decode(secret));
  });

  test('rejects characters outside the alphabet', () => {
    assert.throws(() => base32Decode('ABC!DEF'));
  });
});

describe('RFC 6238 vectors', () => {
  // The RFC's SHA1 test key is the ASCII string "12345678901234567890".
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  test('matches the published codes', () => {
    // Published 8-digit values; we generate 6, so compare the last six.
    const cases: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ];
    for (const [unixTime, expected] of cases) {
      const step = Math.floor(unixTime / TOTP_STEP_SECONDS);
      assert.equal(codeForStep(secret, step), expected, `at t=${unixTime}`);
    }
  });
});

describe('verifyCode', () => {
  const secret = generateSecret();

  test('accepts the current code', () => {
    assert.equal(verifyCode(secret, currentCode(secret)).valid, true);
  });

  test('accepts a code one step late (clock drift)', () => {
    const at = new Date();
    const previous = codeForStep(secret, stepFor(at) - 1);
    assert.equal(verifyCode(secret, previous, { at }).valid, true);
  });

  test('rejects a code far outside the window', () => {
    const at = new Date();
    const stale = codeForStep(secret, stepFor(at) - 5);
    assert.equal(verifyCode(secret, stale, { at }).valid, false);
  });

  test('rejects a wrong code', () => {
    assert.equal(verifyCode(secret, '000000').valid === true && currentCode(secret) !== '000000', false);
  });

  test('rejects non-numeric and wrong-length input', () => {
    for (const bad of ['', 'abcdef', '12345', '1234567', '12 34 56 78']) {
      assert.equal(verifyCode(secret, bad).valid, false, `should reject ${bad}`);
    }
  });

  test('strips spaces and dashes people paste in', () => {
    const code = currentCode(secret);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    assert.equal(verifyCode(secret, spaced).valid, true);
  });

  test('reports the step that matched', () => {
    const at = new Date();
    assert.equal(verifyCode(secret, currentCode(secret, at), { at }).step, stepFor(at));
  });

  test('refuses to replay a spent code', () => {
    // The attack this blocks: a code stays valid for its whole window, so
    // anyone who observes one can reuse it seconds later.
    const at = new Date();
    const code = currentCode(secret, at);
    const first = verifyCode(secret, code, { at });
    assert.equal(first.valid, true);

    const replay = verifyCode(secret, code, { at, lastUsedStep: first.step });
    assert.equal(replay.valid, false, 'the same code must not work twice');
  });
});

describe('secrets and URIs', () => {
  test('generates distinct 160-bit secrets', () => {
    const a = generateSecret();
    const b = generateSecret();
    assert.notEqual(a, b);
    assert.equal(base32Decode(a).length, 20);
  });

  test('builds a scannable otpauth URI', () => {
    const secret = generateSecret();
    const uri = otpauthUri(secret, 'alice');
    assert.ok(uri.startsWith('otpauth://totp/JourneyAX%3Aalice?'));
    assert.ok(uri.includes(`secret=${secret}`));
    assert.ok(uri.includes('digits=6'));
    assert.ok(uri.includes('period=30'));
  });
});

describe('recovery codes', () => {
  test('generates ten distinct formatted codes', () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const c of codes) assert.match(c, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });

  test('normalises for comparison', () => {
    assert.equal(normalizeRecoveryCode('ab cde-fghij'), 'ABCDEFGHIJ');
  });
});
