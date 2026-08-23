/**
 * What counts as an acceptable password.
 *
 * Deliberately length-first and composition-light, following NIST SP 800-63B:
 * forcing a digit and a symbol reliably produces `Password1!` and nothing
 * safer. Length and a blocklist of obvious choices do more real work.
 */

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 200;

/**
 * Substrings that make a password guessable regardless of what surrounds
 * them. Not a substitute for a real breached-password list — if this ever
 * guards something valuable, check candidates against Have I Been Pwned's
 * k-anonymity API instead of this array.
 */
const BANNED = [
  'password', 'passw0rd', '123456', 'qwerty', 'letmein', 'welcome',
  'admin', 'iloveyou', 'monkey', 'dragon', 'abc123', 'journeyax',
  'caroma', 'augusta', 'momentec', 'changeme',
];

export interface PolicyResult {
  ok: boolean;
  problems: string[];
}

export function checkPassword(password: string, username?: string): PolicyResult {
  const problems: string[] = [];

  if (password.length < MIN_LENGTH) {
    problems.push(`Use at least ${MIN_LENGTH} characters.`);
  }
  if (password.length > MAX_LENGTH) {
    problems.push(`Use at most ${MAX_LENGTH} characters.`);
  }

  const lower = password.toLowerCase();

  for (const banned of BANNED) {
    if (lower.includes(banned)) {
      problems.push('That contains a word attackers try first. Pick something less predictable.');
      break;
    }
  }

  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) {
    problems.push('Do not include your username.');
  }

  // A single repeated character reaches any length requirement without adding
  // any entropy at all.
  if (/^(.)\1*$/.test(password)) {
    problems.push('Do not use a single repeated character.');
  }

  if (new Set(password).size < 5) {
    problems.push('Use a wider variety of characters.');
  }

  return { ok: problems.length === 0, problems };
}
