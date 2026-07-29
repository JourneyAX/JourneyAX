import { Controller, Get } from '@nestjs/common';

@Controller('api/v1/analytics')
export class AnalyticsController {
  @Get('dashboard')
  getDashboardStats() {
    return {
      success: true,
      timestamp: new Date().toISOString(),
      metrics: {
        activeUserSessions: Math.floor(100 + Math.random() * 50),
        totalQuotesGenerated: 148,
        conversionRatio: 0.34, // 34% lead conversion rate
        averageBomValue: 2450.00,
        tokenSpendDollars: 42.15,
        gatewayRequestCount: 14890
      }
    };
  }
}
