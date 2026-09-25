import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Headers,
  Res,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { Response } from 'express';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsEventRecord,
} from '@journeyax/database';

function verifyTenant(targetTenantId: string, headerTenantId?: string, userRole?: string): void {
  if (!targetTenantId) {
    throw new BadRequestException('tenantId or projectId is required');
  }
  if (headerTenantId && headerTenantId !== targetTenantId) {
    const isGlobalAdmin = userRole === 'superadmin' || userRole === 'platform_admin';
    if (!isGlobalAdmin) {
      throw new ForbiddenException(`Cross-tenant access forbidden: requested ${targetTenantId} but authenticated as ${headerTenantId}`);
    }
  }
}

function verifyPermission(permissions: string | undefined, userRole: string | undefined, requiredPerm: string): void {
  if (userRole === 'admin' || userRole === 'superadmin' || userRole === 'platform_admin') {
    return;
  }
  if (!permissions) {
    throw new ForbiddenException(`Permission denied: missing required permission ${requiredPerm}`);
  }
  const permsList = permissions.split(',').map((p) => p.trim());
  if (
    permsList.includes('*') ||
    permsList.includes('analytics:*') ||
    permsList.includes(requiredPerm)
  ) {
    return;
  }
  throw new ForbiddenException(`Permission denied: requires ${requiredPerm}`);
}

/**
 * AnalyticsController
 *
 * Reached via the API gateway (or internal outbox worker) — never directly from unverified clients.
 * The gateway injects x-user-permissions, x-user-email, x-tenant-id, and x-user-role.
 */
@Controller('api/v1/analytics')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analyticsService: AnalyticsService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'analytics-service', timestamp: new Date().toISOString() };
  }

  /**
   * Full insights payload consumed by backoffice Dashboard, Analytics, and Orders/Quotes pages.
   */
  @Get('insights')
  async getInsights(
    @Query('projectId') projectId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
    @Query('environmentId') environmentId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('teamId') teamId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('window') window?: any,
  ) {
    const tenant = projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    return this.analyticsService.computeInsights(tenant, {
      environmentId: environmentId as any,
      workspaceId,
      teamId,
      startDate,
      endDate,
      window,
    });
  }

  /**
   * Conversation transcript drill-down with PII redaction.
   */
  @Get('session/:sessionId/transcript')
  async getTranscript(
    @Param('sessionId') sessionId: string,
    @Query('projectId') projectId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
  ) {
    const tenant = projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    return this.analyticsService.getTranscript(tenant, sessionId);
  }

  /**
   * 1. Journey Funnel, stage conversion, abandonment, and p50/p95 completion times.
   */
  @Get('funnel')
  async getFunnel(
    @Query('projectId') projectId: string,
    @Query('tenantId') tenantId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
    @Query('environmentId') environmentId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('teamId') teamId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('packVersionId') packVersionId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('window') window?: any,
  ) {
    const tenant = tenantId || projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId or projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    return this.analyticsService.getFunnelAnalytics(tenant, {
      environmentId: environmentId as any,
      workspaceId,
      teamId,
      sessionId,
      packVersionId,
      startDate,
      endDate,
      window,
    });
  }

  /**
   * 2. Agent/tool/model performance, latency, failures, cost and token usage.
   */
  @Get('performance')
  async getPerformance(
    @Query('projectId') projectId: string,
    @Query('tenantId') tenantId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
    @Query('environmentId') environmentId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('teamId') teamId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('packVersionId') packVersionId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('window') window?: any,
  ) {
    const tenant = tenantId || projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId or projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    return this.analyticsService.getModelAndToolPerformance(tenant, {
      environmentId: environmentId as any,
      workspaceId,
      teamId,
      sessionId,
      packVersionId,
      startDate,
      endDate,
      window,
    });
  }

  /**
   * 3. Approval, notification, connector, and Activepieces execution health.
   */
  @Get('execution-health')
  async getExecutionHealth(
    @Query('projectId') projectId: string,
    @Query('tenantId') tenantId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
    @Query('environmentId') environmentId?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('teamId') teamId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('packVersionId') packVersionId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('window') window?: any,
  ) {
    const tenant = tenantId || projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId or projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    return this.analyticsService.getExecutionHealth(tenant, {
      environmentId: environmentId as any,
      workspaceId,
      teamId,
      sessionId,
      packVersionId,
      startDate,
      endDate,
      window,
    });
  }

  /**
   * 4. Business Pack / version comparisons and release impact.
   */
  @Get('pack-comparison')
  async getPackComparison(
    @Query('versionA') versionA: string,
    @Query('versionB') versionB: string,
    @Query('projectId') projectId: string,
    @Query('tenantId') tenantId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
    @Query('environmentId') environmentId?: string,
  ) {
    const tenant = tenantId || projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId or projectId required');
    if (!versionA || !versionB) throw new BadRequestException('versionA and versionB query parameters required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    return this.analyticsService.comparePackVersions(tenant, versionA, versionB, {
      environmentId: environmentId as any,
    });
  }

  /**
   * 5. Tenant / project / team / workspace dashboards (real-time & historical).
   */
  @Get('dashboard')
  async getDashboard(
    @Query('level') level: 'tenant' | 'project' | 'team' | 'workspace',
    @Query('tenantId') tenantId: string,
    @Query('projectId') projectId: string,
    @Query('teamId') teamId: string,
    @Query('workspaceId') workspaceId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
  ) {
    const targetTenant = tenantId || projectId || headerTenantId;
    if (!targetTenant) throw new BadRequestException('tenantId or projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(targetTenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    const scopeLevel = level || (workspaceId ? 'workspace' : teamId ? 'team' : projectId ? 'project' : 'tenant');

    return this.analyticsService.getScopedDashboard(targetTenant, {
      teamId,
      workspaceId,
    });
  }

  /**
   * 6. Custom Reports: Creation.
   */
  @Post('reports')
  async createReport(
    @Body() body: any,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') userRole: string,
  ) {
    const tenant = body?.tenantId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:write');

    const user = { id: userId || userEmail, role: userRole || 'user' };
    return this.analyticsService.createCustomReport(tenant, user, body);
  }

  /**
   * 6. Custom Reports: List.
   */
  @Get('reports')
  async getReports(
    @Query('projectId') projectId: string,
    @Query('tenantId') tenantId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
  ) {
    const tenant = tenantId || projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId or projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    return this.analyticsService.getCustomReports(tenant);
  }

  /**
   * 6. Custom Reports: Execution.
   */
  @Post('reports/:reportId/run')
  async runReport(
    @Param('reportId') reportId: string,
    @Body() body: any,
    @Query('tenantId') queryTenantId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') userRole: string,
  ) {
    const tenant = body?.tenantId || queryTenantId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    const user = { id: userId || userEmail, role: userRole || 'user' };
    return this.analyticsService.runCustomReport(tenant, user, reportId, body?.overrideFilters);
  }

  /**
   * 6. Custom Reports: Export (CSV RFC 4180 or JSON).
   */
  @Post('reports/:reportId/export')
  async exportReport(
    @Param('reportId') reportId: string,
    @Query('format') format: 'csv' | 'json',
    @Query('tenantId') queryTenantId: string,
    @Body() body: any,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') userRole: string,
    @Res() res: Response,
  ) {
    const tenant = body?.tenantId || queryTenantId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    const user = { id: userId || userEmail, role: userRole || 'user' };
    const exportFmt = format || body?.format || 'json';
    const result = await this.analyticsService.exportCustomReport(tenant, user, reportId, exportFmt, body?.overrideFilters);

    res.setHeader('Content-Type', result.contentType);
    if (result.format === 'csv') {
      res.setHeader('Content-Disposition', `attachment; filename="${reportId}.csv"`);
    }
    return res.status(200).send(result.data);
  }

  /**
   * 7. Alerts: Creation.
   */
  @Post('alerts')
  async createAlert(
    @Body() body: any,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-user-role') userRole: string,
  ) {
    const tenant = body?.tenantId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:write');

    const user = { id: userId || userEmail, role: userRole || 'user' };
    return this.analyticsService.createAlert(tenant, user, body);
  }

  /**
   * 7. Alerts: List.
   */
  @Get('alerts')
  async getAlerts(
    @Query('projectId') projectId: string,
    @Query('tenantId') tenantId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
  ) {
    const tenant = tenantId || projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId or projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    return this.analyticsService.getAlerts(tenant);
  }

  /**
   * 7. Alerts: Evaluation.
   */
  @Post('alerts/evaluate')
  async evaluateAlerts(
    @Body() body: any,
    @Query('projectId') projectId: string,
    @Query('tenantId') tenantId: string,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
  ) {
    const tenant = body?.tenantId || tenantId || projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId or projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:read');

    return this.analyticsService.evaluateAlerts(tenant);
  }

  /**
   * 8. Asynchronous / Durable Streaming Event Ingestion.
   * Never blocks runtime execution; accepts events from outbox worker or microservices.
   */
  @Post('events')
  async ingestEvent(
    @Body() event: AnalyticsEventRecord,
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-internal-call') internalCall: string,
    @Headers('x-user-email') userEmail: string,
  ) {
    if (internalCall !== 'true' && !userEmail) {
      throw new UnauthorizedException('Missing gateway identity or internal call headers');
    }
    if (!event.tenantId) {
      event.tenantId = headerTenantId;
    }
    if (!event.tenantId) {
      throw new BadRequestException('tenantId is required on event');
    }
    return this.analyticsService.ingestEvent(event);
  }

  /**
   * 9. Retention Policy Enforcement (Admin only).
   */
  @Post('retention/enforce')
  async enforceRetention(
    @Body() body: { retentionDays?: number; projectId?: string; tenantId?: string },
    @Headers('x-tenant-id') headerTenantId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-user-role') userRole: string,
  ) {
    const tenant = body?.tenantId || body?.projectId || headerTenantId;
    if (!tenant) throw new BadRequestException('tenantId or projectId required');
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    verifyTenant(tenant, headerTenantId, userRole);
    verifyPermission(permissions, userRole, 'analytics:admin');

    const days = body?.retentionDays ?? 90;
    return this.analyticsService.enforceRetentionPolicy(tenant, days);
  }
}
