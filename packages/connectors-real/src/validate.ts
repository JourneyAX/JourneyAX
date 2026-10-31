import type { Rec } from './types';

/** Checks arguments against the small part of JSON Schema the tools use: type, required, enum, minimum, maximum, maxLength, pattern. Returns the problems. */
export function validateArguments(schema: Rec, args: unknown): string[] {
  const problems: string[] = [];
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object'];
  const input = args as Rec;
  for (const name of schema.required ?? []) {
    if (input[name] === undefined || input[name] === null || input[name] === '') problems.push(`${name} is required`);
  }
  for (const [name, spec] of Object.entries<Rec>(schema.properties ?? {})) {
    const value = input[name];
    if (value === undefined || value === null) continue;
    switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') problems.push(`${name} must be text`);
        else {
          if (spec.maxLength && value.length > spec.maxLength) problems.push(`${name} is too long`);
          if (spec.pattern && !new RegExp(spec.pattern).test(value)) problems.push(`${name} is not in the expected form`);
        }
        break;
      case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${name} must be a number`); break;
      case 'integer': if (!Number.isInteger(value)) problems.push(`${name} must be a whole number`); break;
      case 'boolean': if (typeof value !== 'boolean') problems.push(`${name} must be true or false`); break;
    }
    if (spec.enum && !spec.enum.includes(value)) problems.push(`${name} must be one of ${spec.enum.join(', ')}`);
    if (typeof value === 'number') {
      if (spec.minimum !== undefined && value < spec.minimum) problems.push(`${name} must be at least ${spec.minimum}`);
      if (spec.maximum !== undefined && value > spec.maximum) problems.push(`${name} must be at most ${spec.maximum}`);
    }
  }
  return problems;
}
