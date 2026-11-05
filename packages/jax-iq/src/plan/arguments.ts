import type { Binding } from '../model';
import type { KeyRow } from '../keys';

/** A source receives its own verified key, never another vendor's ID or a caller-supplied key override. */
export function planBindingArguments(binding: Binding, keys: readonly KeyRow[], filters: Record<string, unknown> = {}, principal?: { id: string }): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = Object.create(null);
  for (const [name, source] of Object.entries(binding.args)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) return undefined;
    if (source.from === 'literal') args[name] = source.value;
    else if (source.from === 'principal') {
      if (!principal?.id || principal.id === 'anonymous') return undefined;
      args[name] = principal.id;
    } else if (source.from === 'request') {
      if (!Object.prototype.hasOwnProperty.call(filters, source.param)) {
        if (source.optional) continue;
        return undefined;
      }
      args[name] = filters[source.param];
    } else {
      const matches = keys.filter(key => key.system === binding.system && key.keyKind === source.kind && key.status === 'matched' && key.role !== 'division');
      const values = [...new Set(matches.map(key => key.systemKey))];
      if (values.length !== 1) return undefined;
      if (source.valueType === 'integer') {
        if (!/^(0|[1-9][0-9]*)$/.test(values[0]) || !Number.isSafeInteger(Number(values[0]))) return undefined;
        args[name] = Number(values[0]);
      } else args[name] = values[0];
    }
  }
  return args;
}
