import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Headers,
  Query,
  Req,
  Res,
  UseGuards,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  UsePipes,
  PipeTransform,
  ArgumentMetadata,
  HttpCode,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { RuntimeService } from './runtime.service';
import { TurnCommand, TurnResult, WorkspaceState, FactSource, DuplicateTurnError, ChannelEvent, projectPublicTurnResult, publicEmitter } from '@journeyax/journey-core';
import { DurableCutoverRecord, ReleaseActivationRecord } from '@journeyax/database';
import { RuntimeAuthGuard, InternalOnly, Public } from './auth/auth.guard';
import { privateConversationId } from './auth/conversation-scope';
import { CartRequestSchema, CartSessionSchema } from './commerce/cart-request';
import {
  TurnCommandRequestSchema,
  DecideApprovalRequestSchema,
  AppendFactRequestSchema,
  ActivepiecesWebhookSchema,
  RegisterWebhookSubscriptionSchema,
} from './dto/turn.dto';

@Controller(['api/v1/:tenantId/:environmentId/runtime', 'api/v1/:tenantId/runtime'])
@UseGuards(RuntimeAuthGuard)
export class RuntimeController {
  constructor(@Inject(RuntimeService) private readonly runtimeService: RuntimeService) {}

  @Post('turn')
  @HttpCode(200)
  async runTurn(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Body() rawBody: unknown,
    @Req() req: any
  ): Promise<TurnResult> {
    const parseResult = TurnCommandRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Invalid turn command payload',
        errors: parseResult.error.flatten(),
      });
    }

    const dto = parseResult.data;
    const authContext = req.authContext;
    const env = (environmentId || authContext?.environmentId || 'production') as TurnCommand['environmentId'];

    // Construct server-owned TurnCommand (principalId and principalRole strictly from verified auth context)
    const command: TurnCommand = {
      tenantId: authContext.tenantId,
      environmentId: env,
      workspaceId: privateConversationId(dto.workspaceId || dto.sessionId, authContext),
      sessionId: privateConversationId(dto.sessionId, authContext),
      turnId: dto.turnId,
      principalId: authContext.principalId,
      principalRole: authContext.principalRole,
      principalGroups: authContext.principalGroups,
      disabledConnectors: dto.disabledConnectors,
      readOnly: dto.readOnly,
      correlationId: dto.correlationId,
      message: dto.message,
      event: dto.event as ChannelEvent | undefined,
      customerEvent: (dto.customerEvent || dto.customer_event) as any,
      agentId: dto.agentId,
      parentMessageId: dto.parentMessageId,
      inputFacts: dto.inputFacts,
      approvalRequestId: dto.approvalRequestId,
      idempotencyKey: dto.idempotencyKey,
      projectId: dto.projectId,
      journeyId: dto.journeyId,
      environment: dto.environment || env,
    };

    try {
      const result = await this.runtimeService.runTurn(command);
      // A caller that is not a platform workload (a customer's token via the gateway) gets the customer-facing view only.
      return authContext?.isInternal ? result : (projectPublicTurnResult(result) as unknown as TurnResult);
    } catch (err: any) {
      if (err instanceof DuplicateTurnError) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: err.code,
          message: err.message,
          turnId: err.turnId,
        });
      }
      throw err;
    }
  }

  /**
   * The connectors the signed-in person may use, for the chat's "+" menu. The person is the one the verified identity names (the same
   * one a turn is answered for), so the list is exactly what the assistant would be allowed to use for them.
   */
  @Get('connectors')
  async getConnectors(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Req() req: any
  ) {
    const authContext = req.authContext;
    const env = (environmentId || authContext?.environmentId || 'production') as any;
    return this.runtimeService.listConnectors(authContext.tenantId, env, {
      userId: authContext.principalId,
      role: authContext.principalRole,
      groups: authContext.principalGroups,
    });
  }

  /**
   * The corner tile and the dashboard for the signed-in person (pack `extensions.dashboard`). The person is the one the verified identity
   * names; the figures are read through the same connector gate the assistant uses, so they are only what this person may see.
   */
  @Get('dashboard')
  async getDashboard(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Req() req: any
  ) {
    const authContext = req.authContext;
    const env = (environmentId || authContext?.environmentId || 'production') as any;
    return this.runtimeService.getDashboard(authContext.tenantId, env, {
      userId: authContext.principalId,
      role: authContext.principalRole,
      groups: authContext.principalGroups,
    });
  }

  @Get('cart')
  async cart(@Query('sessionId') sessionId: string, @Req() req: any) {
    const parsed = CartSessionSchema.safeParse(sessionId);
    if (!parsed.success) throw new BadRequestException('A conversation is required.');
    return this.runtimeService.commerceCart(req.authContext, privateConversationId(parsed.data, req.authContext));
  }

  @Post('cart')
  @HttpCode(200)
  async updateCart(@Body() body: unknown, @Req() req: any) {
    const parsed = CartRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A valid cart, revision and request key are required.');
    return this.runtimeService.commerceCart(req.authContext, privateConversationId(parsed.data.sessionId, req.authContext), parsed.data as { items: Array<{ sku: string; quantity: number }>; expectedVersion: number; idempotencyKey: string });
  }

  @Get('desks')
  async desks(@Param('environmentId') environmentId: string | undefined, @Req() req: any) {
    const auth = req.authContext;
    return this.runtimeService.getOperationalDesks(auth.tenantId, (environmentId || auth.environmentId) as any, { userId: auth.principalId, role: auth.principalRole, groups: auth.principalGroups });
  }

  @Get('desks/:deskId')
  async desk(@Param('environmentId') environmentId: string | undefined, @Param('deskId') deskId: string, @Query('recordId') recordId: string | undefined, @Req() req: any, @Query('cursor') cursor?: string) {
    const auth = req.authContext;
    return this.runtimeService.getOperationalDesks(auth.tenantId, (environmentId || auth.environmentId) as any, { userId: auth.principalId, role: auth.principalRole, groups: auth.principalGroups }, deskId, recordId, cursor);
  }

  @Post('desks/:deskId/prepare')
  @HttpCode(200)
  async prepareDesk(@Param('deskId') deskId: string, @Body() body: any, @Req() req: any) {
    if (!body || typeof body.recordId !== 'string' || !body.recordId || body.recordId.length > 200 || /[\u0000-\u001f\u007f]/.test(body.recordId)) throw new BadRequestException('A selected record is required.');
    if (body.workId !== undefined && (typeof body.workId !== 'string' || !/^[a-f0-9]{64}$/.test(body.workId))) throw new BadRequestException('Invalid investigation.');
    return this.runtimeService.prepareDeskRecord(req.authContext, deskId, body.recordId, body.workId);
  }

  @InternalOnly()
  @Get('engine-mode')
  async getEngineMode(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Req() req: any
  ) {
    const env = (environmentId || req.authContext?.environmentId || 'production') as any;
    return this.runtimeService.getEngineMode(tenantId, env);
  }

  /**
   * SSE Event Streaming Boundary
   *
   * Note on Protocol Architecture:
   * This endpoint provides Server-Sent Event (SSE) streaming via RuntimeService.streamTurn.
   * Model and runtime lifecycle events (session, trace, capability, uiAction, token, data, error, done)
   * are emitted directly to the event sink as they occur, preserving atomic capability execution
   * and final outcome validation.
   */
  @Post('chat/stream')
  async streamTurn(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Body() rawBody: unknown,
    @Req() req: any,
    @Res() res: Response
  ): Promise<void> {
    const parseResult = TurnCommandRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Invalid turn command payload',
        errors: parseResult.error.flatten(),
      });
    }

    const dto = parseResult.data;
    const authContext = req.authContext;
    const env = (environmentId || authContext?.environmentId || 'production') as TurnCommand['environmentId'];

    const command: TurnCommand = {
      tenantId: authContext.tenantId,
      environmentId: env,
      workspaceId: privateConversationId(dto.workspaceId || dto.sessionId, authContext),
      sessionId: privateConversationId(dto.sessionId, authContext),
      turnId: dto.turnId,
      principalId: authContext.principalId,
      principalRole: authContext.principalRole,
      principalGroups: authContext.principalGroups,
      disabledConnectors: dto.disabledConnectors,
      readOnly: dto.readOnly,
      correlationId: dto.correlationId,
      message: dto.message,
      event: dto.event as ChannelEvent | undefined,
      customerEvent: (dto.customerEvent || dto.customer_event) as any,
      agentId: dto.agentId,
      parentMessageId: dto.parentMessageId,
      inputFacts: dto.inputFacts,
      approvalRequestId: dto.approvalRequestId,
      idempotencyKey: dto.idempotencyKey,
      projectId: dto.projectId,
      journeyId: dto.journeyId,
      environment: dto.environment || env,
    };

    // The stream starts with the first event, not before: a refusal that happens before anything is sent (no approved release,
    // an unavailable pack, a bad request) is a real HTTP error a gateway and a monitor can see, not a 200 with an error inside.
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      if (typeof res.status === 'function') res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
    };

    let errorEmitted = false;
    const write = (event: string, data: any) => {
      start();
      if (event === 'error') {
        errorEmitted = true;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Platform workloads (the commerce service, presenting the internal key) receive every event; anyone else the public view.
    const emit = authContext?.isInternal ? write : publicEmitter(write);

    try {
      await this.runtimeService.streamTurn(command, emit);
    } catch (err: any) {
      if (!started && err instanceof HttpException && !(err instanceof DuplicateTurnError)) throw err;
      if (!errorEmitted) {
        if (err instanceof DuplicateTurnError) {
          emit('error', {
            code: err.code,
            turnId: err.turnId,
            message: err.message,
          });
        } else {
          emit('error', { message: err.message || 'Error executing turn stream' });
        }
      }
    } finally {
      if (started) res.end();
    }
  }

  @Get('workspaces/:workspaceId')
  async getWorkspace(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Param('workspaceId') workspaceId: string,
    @Req() req: any
  ): Promise<WorkspaceState> {
    const env = (environmentId || req.authContext?.environmentId || 'production') as any;
    const workspace = await this.runtimeService.getWorkspace(req.authContext.tenantId, env, privateConversationId(workspaceId, req.authContext));
    if (!workspace) {
      throw new NotFoundException(`Workspace '${workspaceId}' not found for tenant '${tenantId}'`);
    }
    return workspace;
  }

  @Get('transcripts/:workspaceId')
  async getTranscript(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Param('workspaceId') workspaceId: string,
    @Req() req: any
  ) {
    const env = (environmentId || req.authContext?.environmentId || 'production') as any;
    return this.runtimeService.getTranscript(req.authContext.tenantId, env, privateConversationId(workspaceId, req.authContext));
  }

  @Post('workspaces/:workspaceId/facts')
  @InternalOnly()
  async appendFact(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Param('workspaceId') workspaceId: string,
    @Body() rawBody: unknown,
    @Req() req: any
  ) {
    const parseResult = AppendFactRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Invalid fact payload',
        errors: parseResult.error.flatten(),
      });
    }
    const dto = parseResult.data;
    const env = (environmentId || req.authContext?.environmentId || 'production') as any;

    return this.runtimeService.appendFact(
      req.authContext.tenantId,
      env,
      workspaceId,
      dto.key,
      dto.value,
      (dto.source || 'external') as FactSource
    );
  }

  @Post('workspaces/:workspaceId/approvals/:approvalRequestId/decide')
  @InternalOnly()
  async decideApproval(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Param('workspaceId') workspaceId: string,
    @Param('approvalRequestId') approvalRequestId: string,
    @Body() rawBody: unknown,
    @Req() req: any
  ) {
    const parseResult = DecideApprovalRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Invalid approval payload',
        errors: parseResult.error.flatten(),
      });
    }
    const dto = parseResult.data;
    const env = (environmentId || req.authContext?.environmentId || 'production') as any;

    const success = await this.runtimeService.decideApproval(
      req.authContext.tenantId,
      env,
      workspaceId,
      approvalRequestId,
      dto.decision,
      req.authContext.principalId,
      dto.reason
    );
    return { success, approvalRequestId, decision: dto.decision };
  }

  @Post('webhooks/activepieces')
  @Public()
  async handleActivepiecesWebhook(
    @Param('tenantId') pathTenantId: string,
    @Param('environmentId') pathEnvId: string | undefined,
    @Headers('x-activepieces-signature') signature: string,
    @Headers('x-activepieces-timestamp') timestamp: string,
    @Headers('x-activepieces-nonce') nonce: string,
    @Body() rawBody: unknown,
    @Req() req: any
  ) {
    const parseResult = ActivepiecesWebhookSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Invalid Activepieces webhook payload',
        errors: parseResult.error.flatten(),
      });
    }

    const payload = parseResult.data;
    payload.tenantId = pathTenantId;
    payload.environmentId = pathEnvId || payload.environmentId || 'production';

    const stringBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(rawBody);
    const result = await this.runtimeService.processActivepiecesWebhook(
      signature,
      timestamp,
      nonce,
      payload,
      stringBody
    );
    if (result.status === 'rejected') {
      throw new BadRequestException(result.error || 'Webhook verification rejected');
    }
    return result;
  }

  @Post('webhooks/subscriptions')
  @InternalOnly()
  async registerWebhookSubscription(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Body() rawBody: unknown,
    @Req() req: any
  ) {
    const parseResult = RegisterWebhookSubscriptionSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Invalid webhook subscription payload',
        errors: parseResult.error.flatten(),
      });
    }
    const env = environmentId || req.authContext?.environmentId || 'production';
    return this.runtimeService.registerWebhookSubscription(
      req.authContext.tenantId,
      env,
      parseResult.data.event,
      parseResult.data.webhookUrl
    );
  }

  @Delete('webhooks/subscriptions/:subscriptionId')
  @InternalOnly()
  async unregisterWebhookSubscription(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Param('subscriptionId') subscriptionId: string,
    @Req() req: any
  ) {
    const env = environmentId || req.authContext?.environmentId || 'production';
    const success = await this.runtimeService.unregisterWebhookSubscription(
      req.authContext.tenantId,
      env,
      subscriptionId
    );
    return { success, subscriptionId };
  }

  @Get('webhooks/subscriptions')
  @InternalOnly()
  async listWebhookSubscriptions(
    @Param('tenantId') tenantId: string,
    @Param('environmentId') environmentId: string | undefined,
    @Req() req: any
  ) {
    const env = environmentId || req.authContext?.environmentId || 'production';
    return this.runtimeService.listWebhookSubscriptions(
      req.authContext.tenantId,
      env
    );
  }

  @Get('release-activation')
  @InternalOnly()
  async getReleaseActivationRecord(
    @Param('tenantId') pathTenantId: string,
    @Param('environmentId') pathEnvId: string | undefined,
    @Req() req: any
  ): Promise<ReleaseActivationRecord> {
    const tenantId = (pathTenantId || req.authContext?.tenantId || '').toLowerCase().trim();
    const environmentId = (pathEnvId || req.authContext?.environmentId || 'production').toLowerCase().trim();
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    if (req.authContext?.tenantId && req.authContext.tenantId !== tenantId) {
      throw new ForbiddenException(`Tenant binding mismatch: token=${req.authContext.tenantId}, requested=${tenantId}`);
    }
    if (req.authContext?.environmentId && req.authContext.environmentId !== environmentId) {
      throw new ForbiddenException(`Environment binding mismatch: token=${req.authContext.environmentId}, requested=${environmentId}`);
    }
    const record = await this.runtimeService.getReleaseActivationRecord(tenantId, environmentId);
    if (!record) {
      throw new NotFoundException(
        `No authoritative release activation record found for tenant '${tenantId}' in environment '${environmentId}'`
      );
    }
    return record;
  }

  /**
   * @deprecated Temporary backward-compatibility route for /cutover. Use /release-activation.
   */
  @Get('cutover')
  @InternalOnly()
  async getCutoverRecord(
    @Param('tenantId') pathTenantId: string,
    @Param('environmentId') pathEnvId: string | undefined,
    @Req() req: any
  ): Promise<ReleaseActivationRecord> {
    return this.getReleaseActivationRecord(pathTenantId, pathEnvId, req);
  }

  @Post('release-activation')
  @InternalOnly()
  async setReleaseActivationRecord(
    @Param('tenantId') pathTenantId: string,
    @Param('environmentId') pathEnvId: string | undefined,
    @Body() body: any,
    @Req() req: any
  ): Promise<ReleaseActivationRecord> {
    const tenantId = (pathTenantId || req.authContext?.tenantId || '').toLowerCase().trim();
    const environmentId = (pathEnvId || req.authContext?.environmentId || 'production').toLowerCase().trim() as any;
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    if (req.authContext?.tenantId && req.authContext.tenantId !== tenantId) {
      throw new ForbiddenException(`Tenant binding mismatch: token=${req.authContext.tenantId}, requested=${tenantId}`);
    }
    if (req.authContext?.environmentId && req.authContext.environmentId !== environmentId) {
      throw new ForbiddenException(`Environment binding mismatch: token=${req.authContext.environmentId}, requested=${environmentId}`);
    }

    if (!body || !body.status || !body.approvedReleaseVersion || !body.approvedReleaseChecksum) {
      throw new BadRequestException(
        'status, approvedReleaseVersion, and approvedReleaseChecksum are required fields'
      );
    }

    return this.runtimeService.persistReleaseActivationRecordTransactionally(
      tenantId,
      environmentId,
      {
        status: body.status,
        approvedReleaseVersion: body.approvedReleaseVersion,
        approvedReleaseChecksum: body.approvedReleaseChecksum,
        expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined,
        canaryPercentage: body.canaryPercentage,
        approvedBy: body.approvedBy || req.authContext?.principalId || 'internal-admin',
        rollbackTargetVersion: body.rollbackTargetVersion,
        notes: body.notes,
      }
    );
  }

  /**
   * @deprecated Temporary backward-compatibility route for /cutover. Use /release-activation.
   */
  @Post('cutover')
  @InternalOnly()
  async setCutoverRecord(
    @Param('tenantId') pathTenantId: string,
    @Param('environmentId') pathEnvId: string | undefined,
    @Body() body: any,
    @Req() req: any
  ): Promise<ReleaseActivationRecord> {
    return this.setReleaseActivationRecord(pathTenantId, pathEnvId, body, req);
  }

  @Get('outbox/metrics')
  @InternalOnly()
  async getOutboxMetrics(
    @Param('tenantId') pathTenantId: string,
    @Req() req: any
  ) {
    const tenantId = pathTenantId || req.authContext?.tenantId;
    return this.runtimeService.getOutboxMetrics(tenantId);
  }

  @Post('outbox/dead-letter/:eventId/replay')
  @InternalOnly()
  async replayDeadLetterEvent(
    @Param('eventId') eventId: string
  ) {
    const success = await this.runtimeService.replayDeadLetterEvent(eventId);
    if (!success) {
      throw new NotFoundException(`Dead letter event '${eventId}' not found or not in dead_letter status`);
    }
    return { success, eventId, status: 'pending' };
  }

  @Post('outbox/dead-letter/:eventId/resolve')
  @InternalOnly()
  async resolveDeadLetterEvent(
    @Param('eventId') eventId: string,
    @Body() body: any,
    @Req() req: any
  ) {
    const resolutionNote = body?.resolutionNote || `Resolved by ${req.authContext?.principalId || 'admin'}`;
    const success = await this.runtimeService.resolveDeadLetterEvent(eventId, resolutionNote);
    if (!success) {
      throw new NotFoundException(`Dead letter event '${eventId}' not found or not in dead_letter status`);
    }
    return { success, eventId, status: 'resolved', resolutionNote };
  }
}
