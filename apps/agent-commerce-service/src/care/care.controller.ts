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
 * The stock exceptions desk answers the same routes under `care/stock/...` (me, tickets, tickets/:id, board, the four decisions, poll). They need
 * branch staff, and answer "not switched on" while STOCK_INTAKE is off.
 */
import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { verifiedIdentity } from '../identity';
import type { CareDesk } from './care.desk';
import { CareService } from './care.service';
import type { CareActor } from './care.writeback';

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

  // ---- The stock exceptions desk: the same routes, for branch staff, on the second desk. ----

  private stockWho(projectId: string, assertion: string | undefined): { tenantId: string; actor: CareActor; desk: CareDesk } {
    const desk = this.care.stock;
    if (!desk) throw new HttpException({ error: 'The stock exceptions desk is not switched on.' }, HttpStatus.NOT_FOUND);
    const tenantId = (projectId || '').toLowerCase().trim();
    const actor = this.care.stockActorFor(verifiedIdentity(assertion, tenantId));
    if (!actor) throw new HttpException({ error: 'Branch staff only.' }, HttpStatus.FORBIDDEN);
    return { tenantId, actor, desk };
  }

  /** Whether the signed-in person works the stock desk: answers "no" instead of refusing, like `care/me`. */
  @Get('stock/me')
  stockMe(@Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const tenantId = (projectId || '').toLowerCase().trim();
    const actor = this.care.stockActorFor(verifiedIdentity(assertion, tenantId));
    return actor ? { stock: true, actor: { name: actor.name, id: actor.id, isLead: actor.isLead } } : { stock: false };
  }

  @Get('stock/tickets')
  async stockList(@Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, actor, desk } = this.stockWho(projectId, assertion);
    return { serverTime: new Date().toISOString(), actor: { name: actor.name, id: actor.id, isLead: actor.isLead }, tickets: await desk.list(tenantId) };
  }

  @Get('stock/tickets/:id')
  async stockOne(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, desk } = this.stockWho(projectId, assertion);
    const ticket = await desk.get(tenantId, id);
    if (!ticket) throw new HttpException({ error: 'There is no such exception.' }, HttpStatus.NOT_FOUND);
    return { ticket };
  }

  @Get('stock/board')
  async stockBoard(@Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, desk } = this.stockWho(projectId, assertion);
    return desk.board(tenantId);
  }

  @Post('stock/tickets/:id/approve')
  async stockApprove(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined, @Body() body: { draft?: unknown; removedSteps?: unknown; topic?: unknown; mood?: unknown }) {
    const { tenantId, actor, desk } = this.stockWho(projectId, assertion);
    return this.answer(await desk.approve(tenantId, id, actor, body || {}));
  }

  @Post('stock/tickets/:id/retry')
  async stockRetry(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, actor, desk } = this.stockWho(projectId, assertion);
    return this.answer(await desk.retry(tenantId, id, actor));
  }

  @Post('stock/tickets/:id/reject')
  async stockReject(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, actor, desk } = this.stockWho(projectId, assertion);
    return this.answer(await desk.reject(tenantId, id, actor));
  }

  @Post('stock/tickets/:id/to-lead')
  async stockToLead(@Param('projectId') projectId: string, @Param('id') id: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, actor, desk } = this.stockWho(projectId, assertion);
    return this.answer(await desk.toLead(tenantId, id, actor));
  }

  @Post('stock/poll')
  async stockPoll(@Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const { tenantId, desk } = this.stockWho(projectId, assertion);
    return { found: await desk.pollOnce(tenantId) };
  }
}
