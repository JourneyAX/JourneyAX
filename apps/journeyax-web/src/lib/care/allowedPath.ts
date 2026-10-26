/** Which care desk paths the portal will pass on. Anything else is not found. */
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const DECISIONS = new Set(['approve', 'retry', 'reject', 'to-lead']);

/** me, tickets, tickets/<id>, tickets/<id>/<decision>, board, poll: nothing else. */
export function allowedCarePath(method: string, segments: string[]): boolean {
  if (!segments.length || !segments.every((s) => SEGMENT.test(s))) return false;
  const [first, id, action] = segments;
  if (method === 'GET') return (first === 'tickets' && segments.length <= 2) || ((first === 'board' || first === 'me') && segments.length === 1);
  if (method === 'POST') return (first === 'poll' && segments.length === 1) || (first === 'tickets' && !!id && segments.length === 3 && DECISIONS.has(action));
  return false;
}

