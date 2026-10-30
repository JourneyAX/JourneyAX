/**
 * Remembers the `jti` of every scope a verifier has accepted on `tools/call`, so the same signed scope cannot be used for a second call.
 * `seen` checks and records in one step: it returns true when the id was already recorded, and otherwise records it until `expEpochSeconds`
 * and returns false. The memory store is per process; more than one instance of a service needs a shared store with the same method.
 */
export interface JtiStore {
  seen(jti: string, expEpochSeconds: number): boolean;
}

export class MemoryJtiStore implements JtiStore {
  private readonly expiries = new Map<string, number>();

  /** `clock` says when a recorded id may be forgotten; it defaults to the system clock. */
  constructor(private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  seen(jti: string, expEpochSeconds: number): boolean {
    const nowSeconds = this.clock.now().getTime() / 1000;
    for (const [id, exp] of this.expiries) if (exp <= nowSeconds) this.expiries.delete(id);
    if (this.expiries.has(jti)) return true;
    this.expiries.set(jti, expEpochSeconds);
    return false;
  }

  /** How many ids are held now, for tests. */
  get size(): number {
    return this.expiries.size;
  }
}
