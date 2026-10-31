/**
 * What the portal's care canvases call. Every route needs a care person (the signed identity the gateway adds says who): the browser never says who
 * it is. The tickets and the decisions are the desk's; this file only carries them.
 *
 *   GET  care/me                      { care: true, actor } for care staff, { care: false } for anyone else signed in
 *   GET  care/tickets                 the tickets, soonest promised time first
 *   GET  care/tickets/:id             one ticket
 *   GET  care/board                   how many tickets are at each stage, and who has what
 *   POST care/tickets/:id/approve     { draft, removedSteps }
 *   POST care/tickets/:id/retry
 *   POST care/tickets/:id/reject
 *   POST care/tickets/:id/to-lead
 *   POST care/poll                    look at Zendesk now (instead of waiting for the timer)
 *
 * The other desks (stock, quotes) answer the same routes under `care/<desk>/...` (me, tickets, tickets/:id, board, the four decisions, poll). They need
 * the people who work that desk, and answer "not switched on" while the desk's intake setting is off.
 */
import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { verifiedIdentity } from '../identity';
import type { CareDesk } from './care.desk';
import { extraSpec } from './desk-specs';
import { CareService } from './care.service';
import type { CareActor } from './care.writeback';

const isExtraDesk = (desk: string): boolean => !!extraSpec(desk);

@Controller('api/v1/:projectId/commerce/care')
export class CareController {
  constructor(@Inject(CareService) private readonly care: CareService) {}

  private who(projectId: string, assertion: string | undefined): { tenantId: string; actor: CareActor } {
    const tenantId = (projectId || '').toLowerCase().trim();
    const actor = this.care.actorFor(verifiedIdentity(assertion, tenantId));
    if (!actor) throw new HttpException({ error: 'Customer care only.' }, HttpStatus.FORBIDDEN);
    return { tenantId, actor };
  }
  private answer<T extends { ok: boolean }>(result: T): T {
    if (result.ok) return result;
    const code = (result as any).code;
    throw new HttpException({ error: (result as any).message }, code === 'not_found' ? HttpStatus.NOT_FOUND : code === 'not_allowed' ? HttpStatus.FORBIDDEN : HttpStatus.CONFLICT);
  }

  /** Whether the signed-in person is care staff: the one care route that answers "no" instead of refusing, so the chat can decide whether to offer the care screens. */
  @Get('me')
  me(@Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const tenantId = (projectId || '').toLowerCase().trim();
    const actor = this.care.actorFor(verifiedIdentity(assertion, tenantId));
    return actor ? { care: true, actor: { name: actor.name, id: actor.id, isLead: actor.isLead } } : { care: false };
  }

  @Get('tickets')
  async list(@Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, actor } = this.who(projectId, assertion);
    return { serverTime: new Date().toISOString(), actor: { name: actor.name, id: actor.id, isLead: actor.isLead }, tickets: await this.care.desk.list(tenantId) };
  }

  @Get('tickets/:id')
  async one(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId } = this.who(projectId, assertion);
    const ticket = await this.care.desk.get(tenantId, id);
    if (!ticket) throw new HttpException({ error: 'There is no such ticket.' }, HttpStatus.NOT_FOUND);
    return { ticket };
  }

  @Get('board')
  async board(@Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId } = this.who(projectId, assertion);
    return this.care.desk.board(tenantId);
  }

  @Post('tickets/:id/approve')
  async approve(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined, @Body() body: { draft?: unknown; removedSteps?: unknown; topic?: unknown; mood?: unknown }) {
    const { tenantId, actor } = this.who(projectId, assertion);
    return this.answer(await this.care.desk.approve(tenantId, id, actor, body || {}));
  }

  @Post('tickets/:id/retry')
  async retry(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, actor } = this.who(projectId, assertion);
    return this.answer(await this.care.desk.retry(tenantId, id, actor));
  }

  @Post('tickets/:id/reject')
  async reject(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, actor } = this.who(projectId, assertion);
    return this.answer(await this.care.desk.reject(tenantId, id, actor));
  }

  @Post('tickets/:id/to-lead')
  async toLead(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, actor } = this.who(projectId, assertion);
    return this.answer(await this.care.desk.toLead(tenantId, id, actor));
  }

  @Post('poll')
  async poll(@Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId } = this.who(projectId, assertion);
    return { found: await this.care.desk.pollOnce(tenantId) };
  }

  // ---- The other desks (stock exceptions, quotes): the same routes under `<desk>/...`, for the people who work them. ----

  private deskWho(desk: string, projectId: string, assertion: string | undefined): { tenantId: string; actor: CareActor; desk: CareDesk } {
    const found = isExtraDesk(desk) ? this.care.extraDesk(desk) : null;
    if (!found) throw new HttpException({ error: 'That desk is not switched on.' }, HttpStatus.NOT_FOUND);
    const tenantId = (projectId || '').toLowerCase().trim();
    const actor = this.care.actorForDesk(desk, verifiedIdentity(assertion, tenantId));
    if (!actor) throw new HttpException({ error: 'This desk is for the people who work it.' }, HttpStatus.FORBIDDEN);
    return { tenantId, actor, desk: found };
  }

  /** Whether the signed-in person works the desk: answers "no" instead of refusing, like `care/me`. */
  @Get(':desk/me')
  deskMe(@Param('desk') desk: string, @Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const tenantId = (projectId || '').toLowerCase().trim();
    const actor = isExtraDesk(desk) ? this.care.actorForDesk(desk, verifiedIdentity(assertion, tenantId)) : null;
    return actor ? { [desk]: true, actor: { name: actor.name, id: actor.id, isLead: actor.isLead } } : { [desk]: false };
  }

  @Get(':desk/tickets')
  async deskList(@Param('desk') desk: string, @Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const w = this.deskWho(desk, projectId, assertion);
    return { serverTime: new Date().toISOString(), actor: { name: w.actor.name, id: w.actor.id, isLead: w.actor.isLead }, tickets: await w.desk.list(w.tenantId) };
  }

  @Get(':desk/tickets/:id')
  async deskOne(@Param('desk') desk: string, @Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const w = this.deskWho(desk, projectId, assertion);
    const ticket = await w.desk.get(w.tenantId, id);
    if (!ticket) throw new HttpException({ error: 'There is no such case.' }, HttpStatus.NOT_FOUND);
    return { ticket };
  }

  @Get(':desk/board')
  async deskBoard(@Param('desk') desk: string, @Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const w = this.deskWho(desk, projectId, assertion);
    return w.desk.board(w.tenantId);
  }

  @Post(':desk/tickets/:id/approve')
  async deskApprove(@Param('desk') desk: string, @Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined, @Body() body: { draft?: unknown; removedSteps?: unknown; topic?: unknown; mood?: unknown }) {
    const w = this.deskWho(desk, projectId, assertion);
    return this.answer(await w.desk.approve(w.tenantId, id, w.actor, body || {}));
  }

  @Post(':desk/tickets/:id/retry')
  async deskRetry(@Param('desk') desk: string, @Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const w = this.deskWho(desk, projectId, assertion);
    return this.answer(await w.desk.retry(w.tenantId, id, w.actor));
  }

  @Post(':desk/tickets/:id/reject')
  async deskReject(@Param('desk') desk: string, @Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const w = this.deskWho(desk, projectId, assertion);
    return this.answer(await w.desk.reject(w.tenantId, id, w.actor));
  }

  @Post(':desk/tickets/:id/to-lead')
  async deskToLead(@Param('desk') desk: string, @Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const w = this.deskWho(desk, projectId, assertion);
    return this.answer(await w.desk.toLead(w.tenantId, id, w.actor));
  }

  @Post(':desk/poll')
  async deskPoll(@Param('desk') desk: string, @Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const w = this.deskWho(desk, projectId, assertion);
    return { found: await w.desk.pollOnce(w.tenantId) };
  }
}
