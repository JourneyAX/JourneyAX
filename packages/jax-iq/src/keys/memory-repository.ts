import type { ConnectorId, Environment, KeyKind, ThingName } from '../model';
import { compareIds, isKeyedUnder } from './normalise';
import { canonicalKeyId, checkKeyRow, checkKeyUniqueness, systemKeyId } from './repository';
import type { KeyProblem, KeyRepository, KeyWriteResult } from './repository';
import type { KeyRow, KeyScope } from './types';

const byIdentity = (a: KeyRow, b: KeyRow): number => compareIds(`${a.system}\u0000${a.keyKind}\u0000${a.systemKey}`, `${b.system}\u0000${b.keyKind}\u0000${b.systemKey}`);

/**
 * A key table in memory, for tests and local runs. It enforces the same rules the database adapter must: the row shape, U1 and U2 (as
 * `checkKeyUniqueness`), tenant and environment on every call, and all-or-nothing batches. Rows go in and come out as copies.
 */
export class MemoryKeyRepository implements KeyRepository {
  private readonly bySystemKey = new Map<string, KeyRow>();
  private readonly byCanonical = new Map<string, Map<string, KeyRow>>();

  async findBySystemKey(scope: KeyScope, system: ConnectorId, keyKind: KeyKind, systemKey: string): Promise<KeyRow | undefined> {
    const row = this.bySystemKey.get(systemKeyId({ ...scope, system, keyKind, systemKey }));
    return row ? structuredClone(row) : undefined;
  }

  async findByCanonicalId(scope: KeyScope, canonicalId: string): Promise<KeyRow[]> {
    const rows = [...(this.byCanonical.get(canonicalKeyId({ ...scope, canonicalId }))?.values() ?? [])];
    return rows.sort(byIdentity).map((row) => structuredClone(row));
  }

  async upsertMany(rows: KeyRow[]): Promise<KeyWriteResult> {
    for (const [index, row] of rows.entries()) {
      const shape = checkKeyRow(row);
      if (shape.length > 0) return { ok: false, problem: { rule: 'shape', index, message: shape.join(' ') } };
    }
    const undo: Array<() => void> = [];
    let inserted = 0;
    let updated = 0;
    for (const [index, row] of rows.entries()) {
      const same = this.bySystemKey.get(systemKeyId(row));
      const neighbours = [...(this.byCanonical.get(canonicalKeyId(row))?.values() ?? [])];
      const problem: KeyProblem | undefined = checkKeyUniqueness(row, same ? [same, ...neighbours] : neighbours);
      if (problem) {
        for (const step of undo.reverse()) step();
        return { ok: false, problem: { ...problem, index } };
      }
      const next = structuredClone(row);
      if (same && same.status !== 'retired' && same.canonicalId === row.canonicalId) {
        next.firstSeenAt = Date.parse(same.firstSeenAt) <= Date.parse(row.firstSeenAt) ? same.firstSeenAt : row.firstSeenAt;
        updated++;
      } else if (same) updated++;
      else inserted++;
      this.put(next);
      undo.push(() => (same ? this.put(same) : this.remove(next)));
    }
    return { ok: true, inserted, updated };
  }

  async retireRun(tenantId: string, environmentId: Environment, runId: string): Promise<number> {
    let count = 0;
    for (const row of [...this.bySystemKey.values()]) {
      if (row.tenantId !== tenantId || row.environmentId !== environmentId || row.builtBy.runId !== runId || row.status === 'retired') continue;
      this.put({ ...row, status: 'retired' });
      count++;
    }
    return count;
  }

  async deleteByAccount(scope: KeyScope, accountCanonicalId: string, keyedUnder: ThingName[] = []): Promise<number> {
    let count = 0;
    for (const row of [...this.bySystemKey.values()]) {
      if (row.tenantId !== scope.tenantId || row.environmentId !== scope.environmentId) continue;
      const own = row.thing === scope.thing && row.canonicalId === accountCanonicalId;
      const under = keyedUnder.includes(row.thing) && isKeyedUnder(row.canonicalId, accountCanonicalId);
      if (!own && !under) continue;
      this.remove(row);
      count++;
    }
    return count;
  }

  private put(row: KeyRow): void {
    const key = systemKeyId(row);
    const previous = this.bySystemKey.get(key);
    if (previous) this.byCanonical.get(canonicalKeyId(previous))?.delete(key);
    this.bySystemKey.set(key, row);
    const group = canonicalKeyId(row);
    if (!this.byCanonical.has(group)) this.byCanonical.set(group, new Map());
    this.byCanonical.get(group)!.set(key, row);
  }

  private remove(row: KeyRow): void {
    const key = systemKeyId(row);
    this.bySystemKey.delete(key);
    const group = this.byCanonical.get(canonicalKeyId(row));
    group?.delete(key);
    if (group && group.size === 0) this.byCanonical.delete(canonicalKeyId(row));
  }
}
