type Schema = Record<string, any>;

/** The JSON Schema subset used by connector tools, shared by proposal review and the source boundary. */
export function validateToolArguments(schema: Schema, args: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object'];
  const problems: string[] = [];
  const object = (spec: Schema, input: Schema, prefix = '') => {
    const known = Object.keys(spec.properties ?? {});
    // Existing connector roots are closed by convention. A nested free-form
    // object (for example a paid snapshot) remains open unless it declares fields.
    if (spec.additionalProperties !== true && (!prefix || spec.properties || spec.additionalProperties === false)) {
      const unknown = Object.keys(input).filter(name => !known.includes(name));
      if (unknown.length) problems.push(`${unknown.map(name => prefix + name).join(', ')} ${unknown.length === 1 ? 'is not an input' : 'are not inputs'} of this tool; its inputs are ${known.length ? known.map(name => prefix + name).join(', ') : 'none'}`);
    }
    for (const name of spec.required ?? []) if (input[name] === undefined || input[name] === null || input[name] === '') problems.push(`${prefix}${name} is required`);
    for (const [name, field] of Object.entries<Schema>(spec.properties ?? {})) {
      if (input[name] !== undefined && input[name] !== null) value(field, input[name], prefix + name);
    }
  };
  const value = (spec: Schema, input: any, name: string) => {
    switch (spec.type) {
      case 'string':
        if (typeof input !== 'string') problems.push(`${name} must be text`);
        else {
          if (spec.minLength !== undefined && input.length < spec.minLength) problems.push(`${name} is too short`);
          if (spec.maxLength !== undefined && input.length > spec.maxLength) problems.push(`${name} is too long`);
          if (spec.pattern) {
            try { if (!new RegExp(spec.pattern).test(input)) problems.push(`${name} is not in the expected form`); }
            catch { problems.push(`${name} has an invalid validation pattern`); }
          }
        }
        break;
      case 'number': if (typeof input !== 'number' || !Number.isFinite(input)) problems.push(`${name} must be a number`); break;
      case 'integer': if (!Number.isInteger(input)) problems.push(`${name} must be a whole number`); break;
      case 'boolean': if (typeof input !== 'boolean') problems.push(`${name} must be true or false`); break;
      case 'object':
        if (!input || typeof input !== 'object' || Array.isArray(input)) problems.push(`${name} must be an object`);
        else object(spec, input, `${name}.`);
        break;
      case 'array':
        if (!Array.isArray(input)) problems.push(`${name} must be a list`);
        else {
          if (spec.minItems !== undefined && input.length < spec.minItems) problems.push(`${name} has too few items`);
          if (spec.maxItems !== undefined && input.length > spec.maxItems) problems.push(`${name} has too many items`);
          if (spec.items) input.forEach((entry, index) => value(spec.items, entry, `${name}[${index}]`));
        }
        break;
    }
    if (spec.enum && !spec.enum.includes(input)) problems.push(`${name} must be one of ${spec.enum.join(', ')}`);
    if (typeof input === 'number') {
      if (spec.minimum !== undefined && input < spec.minimum) problems.push(`${name} must be at least ${spec.minimum}`);
      if (spec.maximum !== undefined && input > spec.maximum) problems.push(`${name} must be at most ${spec.maximum}`);
    }
  };
  object(schema, args as Schema);
  return problems;
}
