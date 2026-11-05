import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { AuthContext } from './auth.guard';

/** A browser can choose a chat identifier, never the identity namespace in which its memory is stored. */
export function privateConversationId(raw: string, auth: AuthContext): string {
  if (!auth?.principalId || ['anonymous', 'guest', 'guest@anonymous'].includes(auth.principalId)) throw new UnauthorizedException('A private guest session or sign-in is required for saved conversations.');
  const principal = createHash('sha256').update(JSON.stringify([auth.tenantId, auth.environmentId, auth.principalId])).digest('hex').slice(0, 24);
  const prefix = `chat_${principal}_`;
  if (raw.startsWith(prefix) && /^[a-f0-9]{64}$/.test(raw.slice(prefix.length))) return raw;
  return `${prefix}${createHash('sha256').update(String(raw)).digest('hex')}`;
}
