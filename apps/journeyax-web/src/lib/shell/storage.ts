/**
 * localStorage that never throws. Storage can be missing (server render, tests), blocked (private windows, embedded
 * frames) or full; the shell must render and behave correctly without it, so every read and write goes through here.
 */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* best effort */
  }
}

export function readStoredJson<T>(key: string, fallback: T): T {
  const raw = readStored(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStoredJson(key: string, value: unknown): boolean {
  try {
    return writeStored(key, JSON.stringify(value));
  } catch {
    return false;
  }
}
