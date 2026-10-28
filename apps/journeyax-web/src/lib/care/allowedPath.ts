/** Which care desk paths the portal will pass on. Anything else is not found. */
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const DECISIONS = new Set(['approve', 'retry', 'reject', 'to-lead']);

/**
 * me, tickets, tickets/<id>, tickets/<id>/<decision>, board, poll: nothing else. The stock exceptions desk has the same set under a leading `stock/`
 * (and `stock` on its own is not a path).
 */
export function allowedCarePath(method: string, segments: string[]): boolean {
  if (!segments.length || !segments.every((s) => SEGMENT.test(s))) return false;
  const path = segments[0] === 'stock' ? segments.slice(1) : segments;
  if (!path.length) return false;
  const [first, id, action] = path;
  if (method === 'GET') return (first === 'tickets' && path.length <= 2) || ((first === 'board' || first === 'me') && path.length === 1);
  if (method === 'POST') return (first === 'poll' && path.length === 1) || (first === 'tickets' && !!id && path.length === 3 && DECISIONS.has(action));
  return false;
}

