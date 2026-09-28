import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Headers,
  Req,
  Res,
  UseGuards,
  NotFoundException,
  BadRequestException,
  Inject,
  UsePipes,
  PipeTransform,
  ArgumentMetadata,
  HttpCode,
} from '@nestjs/common';
import { Response } from 'express';
import { RuntimeService } from './runtime.service';
import { TurnCommand, TurnResult, WorkspaceState, FactSource, DuplicateTurnError, ChannelEvent } from '@journeyax/journey-core';
import { DurableCutoverRecord } from '@journeyax/database';
import { RuntimeAuthGuard, InternalOnly, Public } from './auth/auth.guard';
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
      workspaceId: dto.workspaceId || dto.sessionId,
      sessionId: dto.sessionId,
      turnId: dto.turnId,
      principalId: authContext.principalId,
      principalRole: authContext.principalRole,
      correlationId: dto.correlationId,
      message: dto.message,
      event: dto.event as ChannelEvent | undefined,
      inputFacts: dto.inputFacts,
      approvalRequestId: dto.approvalRequestId,
      idempotencyKey: dto.idempotencyKey,
    };

    try {
      return await this.runtimeService.runTurn(command);
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
      workspaceId: dto.workspaceId || dto.sessionId,
      sessionId: dto.sessionId,
      turnId: dto.turnId,
      principalId: authContext.principalId,
      principalRole: authContext.principalRole,
      correlationId: dto.correlationId,
      message: dto.message,
      event: dto.event as ChannelEvent | undefined,
      inputFacts: dto.inputFacts,
      approvalRequestId: dto.approvalRequestId,
      idempotencyKey: dto.idempotencyKey,
    };

    // Set SSE headers
    if (typeof res.status === 'function') {
      res.status(200);
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const emit = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    emit('session', { sessionId: command.sessionId });

    try {
      const turnResult = await this.runtimeService.runTurn(command);

      // Emit presentCard envelopes for validated UI cards
      for (const inst of turnResult.uiInstructions) {
        emit('uiAction', {
          name: 'presentCard',
          arguments: {
            card: {
              id: inst.actionId || `${inst.component}-${Date.now()}`,
              cardType: inst.component,
              state: inst.props,
            },
          },
          card: {
            cardType: inst.component,
            state: inst.props,
          },
        });
      }

      // Stream assistant response tokens
      const text = turnResult.assistantMessage || '';
      const words = text.split(' ');
      for (let i = 0; i < words.length; i++) {
        emit('token', words[i] + (i < words.length - 1 ? ' ' : ''));
        await new Promise((r) => setTimeout(r, 10));
      }

      emit('done', {
        sessionId: command.sessionId,
        workspaceId: command.workspaceId,
        decision: turnResult.decision,
        trace: turnResult.trace,
      });
    } catch (err: any) {
      if (err instanceof DuplicateTurnError) {
        emit('error', {
          code: err.code,
          turnId: err.turnId,
          message: err.message,
        });
      } else {
        emit('error', { message: err.message || 'Error executing turn stream' });
      }
    } finally {
      res.end();
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
    const workspace = await this.runtimeService.getWorkspace(req.authContext.tenantId, env, workspaceId);
    if (!workspace) {
      throw new NotFoundException(`Workspace '${workspaceId}' not found for tenant '${tenantId}'`);
    }
    return workspace;
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

  @Get('cutover')
  @Public()
  async getCutoverRecord(
    @Param('tenantId') pathTenantId: string,
    @Param('environmentId') pathEnvId: string | undefined,
    @Req() req: any
  ): Promise<DurableCutoverRecord> {
    const tenantId = pathTenantId || req.authContext?.tenantId;
    const environmentId = pathEnvId || req.authContext?.environmentId || 'production';
    const record = await this.runtimeService.getCutoverRecord(tenantId, environmentId);
    if (!record) {
      throw new NotFoundException(
        `No durable cutover record found for tenant '${tenantId}' in environment '${environmentId}'`
      );
    }
    return record;
  }

  @Post('cutover')
  @InternalOnly()
  async setCutoverRecord(
    @Param('tenantId') pathTenantId: string,
    @Param('environmentId') pathEnvId: string | undefined,
    @Body() body: any,
    @Req() req: any
  ): Promise<DurableCutoverRecord> {
    const tenantId = pathTenantId || req.authContext?.tenantId;
    const environmentId = (pathEnvId || req.authContext?.environmentId || 'production') as any;

    if (!body || !body.status || !body.approvedReleaseVersion || !body.approvedReleaseChecksum) {
      throw new BadRequestException(
        'status, approvedReleaseVersion, and approvedReleaseChecksum are required fields'
      );
    }

    return this.runtimeService.persistCutoverRecordTransactionally(
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
