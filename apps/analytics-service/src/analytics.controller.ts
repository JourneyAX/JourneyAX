import { Controller, Get, Query, Param, Headers, UnauthorizedException, Inject } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

/**
 * AnalyticsController
 *
 * Reached ONLY via the API gateway — never directly from the browser.
 * The gateway injects x-user-permissions from the verified JWT.
 *
 *   GET /api/v1/analytics/health
 *   GET /api/v1/analytics/insights?projectId=…   (dashboard, funnel, sessions, quotes)
 *   GET /api/v1/analytics/dashboard               (legacy stub — kept for compat)
 */
@Controller('api/v1/analytics')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analyticsService: AnalyticsService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'analytics-service', timestamp: new Date().toISOString() };
  }

  /**
   * Full insights payload consumed by the backoffice Dashboard, Analytics,
   * and Orders/Quotes pages.
   *
   * Auth: gateway injects x-user-permissions; any authenticated user with at
   * least one permission can read analytics (the gateway already verified the JWT).
   */
  @Get('insights')
  async getInsights(
    @Query('projectId') projectId: string,
    @Headers('x-user-permissions') permissions: string,
    @Headers('x-user-email') userEmail: string,
  ) {
    if (!projectId) return { error: 'projectId required' };

    // Gate: must come through the gateway (x-user-email is injected by AuthGuard)
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');

    try {
      return await this.analyticsService.computeInsights(projectId);
    } catch (e: any) {
      console.error('[AnalyticsController] getInsights error:', e);
      throw e;
    }
  }

  /**
   * Real conversation transcript for ONE session — the drill-down from the
   * "recent sessions" list in /insights. Same auth gate as /insights.
   *
   *   GET /api/v1/analytics/session/:sessionId/transcript?projectId=…
   */
  @Get('session/:sessionId/transcript')
  async getTranscript(
    @Param('sessionId') sessionId: string,
    @Query('projectId') projectId: string,
    @Headers('x-user-email') userEmail: string,
  ) {
    if (!projectId) return { error: 'projectId required' };
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    return this.analyticsService.getTranscript(projectId, sessionId);
  }

  /** Legacy stub — kept so existing integrations don't 404. */
  @Get('dashboard')
  getDashboardStats(@Headers('x-user-email') userEmail: string) {
    if (!userEmail) throw new UnauthorizedException('Missing gateway identity headers');
    return {
      success: true,
      timestamp: new Date().toISOString(),
      message: 'Use GET /api/v1/analytics/insights?projectId=… for real metrics.',
    };
  }
}
