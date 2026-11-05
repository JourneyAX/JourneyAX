/** Own-property paths only. Neither inherited properties nor executable expressions are source data. */
export function readIqPath(value: unknown, path: string): unknown {
  let current: any = value;
  for (const part of path.split('.')) {
    if (!/^[A-Za-z0-9_]+$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part)) return undefined;
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
