/**
 * Health and readiness.
 *
 * Answers the two questions nobody could previously answer from outside the
 * process: is the knowledge base reachable, and is retrieval actually working
 * or has it quietly fallen back to keyword matching?
 *
 * Point an uptime monitor at this. `status: "degraded"` means the app is
 * still answering but the answers are worse than they look — historically the
 * failure mode most likely to go unnoticed here.
 */

import { getCollection, lastSearchReport } from '@/services/knowledge/mongo';
import { logger } from '@/lib/logger';

const log = logger('api/health');

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // Configuration presence. Reports whether a key is set — never its value.
  checks.openaiKeyConfigured = {
    ok: !!process.env.OPENAI_API_KEY && !/your-.*-key/i.test(process.env.OPENAI_API_KEY),
  };
  checks.mongoUriConfigured = { ok: !!process.env.MONGODB_URI };

  // Actual connectivity, not just configuration.
  if (checks.mongoUriConfigured.ok) {
    try {
      const col = await getCollection();
      const count = await col.estimatedDocumentCount();
      checks.knowledgeBase = { ok: count > 0, detail: `${count} documents` };
    } catch (error) {
      log.error('health: knowledge base unreachable', error);
      checks.knowledgeBase = { ok: false, detail: 'unreachable' };
    }
  } else {
    checks.knowledgeBase = { ok: false, detail: 'MONGODB_URI not set' };
  }

  const search = lastSearchReport();

  const failing = Object.values(checks).some(c => !c.ok);
  const status = failing ? 'unhealthy' : search.degraded ? 'degraded' : 'ok';

  return Response.json(
    { status, checks, search, timestamp: new Date().toISOString() },
    { status: status === 'unhealthy' ? 503 : 200 },
  );
}
