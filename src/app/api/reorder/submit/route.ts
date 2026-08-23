/**
 * The coach's "Complete" step lands here.
 *
 * Coach-gated: only a signed-in coach can submit, and the record is stamped
 * with their id/name/school from the session — never from the request body —
 * so a submission can't be forged as coming from someone else's school.
 */

import { coachFromRequest } from '@/lib/coach/session';
import { recordHandoff, type CompletionPath, type RosterSnapshot, type DesignSnapshot } from '@/lib/handoff-store';
import { guard, isFailure, errorResponse } from '@/lib/api-guard';

const LIMIT = { windowMs: 60_000, max: 20 };

interface SubmitBody {
  reference?: unknown;
  completionPath?: unknown;
  team?: unknown;
  sport?: unknown;
  season?: unknown;
  originalOrderId?: unknown;
  changedAreas?: unknown;
  roster?: unknown;
  design?: unknown;
  deliveryNotes?: unknown;
  statusMessage?: unknown;
}

export async function POST(req: Request) {
  const coach = coachFromRequest(req);
  if (!coach) return errorResponse(401, 'not_authenticated', 'Sign in to submit a reorder.');

  const guarded = await guard<SubmitBody>(req, { scope: 'reorder-submit', rule: LIMIT });
  if (isFailure(guarded)) return guarded.response;
  const b = guarded.body;

  if (typeof b.reference !== 'string' || !b.reference) {
    return errorResponse(400, 'invalid_body', 'A reference is required.');
  }
  if (b.completionPath !== 'direct-reorder' && b.completionPath !== 'artwork-review') {
    return errorResponse(400, 'invalid_body', 'completionPath must be direct-reorder or artwork-review.');
  }
  if (!Array.isArray(b.roster) || !Array.isArray(b.changedAreas)) {
    return errorResponse(400, 'invalid_body', 'roster and changedAreas must be arrays.');
  }

  const record = recordHandoff({
    id: b.reference,
    reference: b.reference,
    completionPath: b.completionPath as CompletionPath,
    submittedAt: new Date().toISOString(),
    coachId: coach.id,
    coachName: coach.name,
    // The coach's OWN school, from the session — never trust a school string
    // the client might send, or a coach could hand off work under a school
    // they don't belong to.
    school: coach.schools[0] ?? '',
    team: typeof b.team === 'string' ? b.team : '',
    sport: typeof b.sport === 'string' ? b.sport : undefined,
    season: typeof b.season === 'string' ? b.season : '',
    originalOrderId: typeof b.originalOrderId === 'string' ? b.originalOrderId : '',
    changedAreas: (b.changedAreas as unknown[]).filter((a): a is string => typeof a === 'string'),
    roster: (b.roster as unknown[]).filter(
      (r): r is RosterSnapshot =>
        !!r && typeof r === 'object'
        && typeof (r as RosterSnapshot).id === 'string'
        && typeof (r as RosterSnapshot).number === 'string'
        && typeof (r as RosterSnapshot).name === 'string'
        && typeof (r as RosterSnapshot).size === 'string',
    ),
    design: (b.design && typeof b.design === 'object' ? b.design : {
      teamName: '', primaryColor: '', secondaryColor: '', logoText: '',
      logoPlacement: '', treatment: '', garmentStyle: '',
    }) as DesignSnapshot,
    deliveryNotes: typeof b.deliveryNotes === 'string' ? b.deliveryNotes : '',
    statusMessage: typeof b.statusMessage === 'string' ? b.statusMessage : '',
  });

  return Response.json({ ok: true, id: record.id });
}
