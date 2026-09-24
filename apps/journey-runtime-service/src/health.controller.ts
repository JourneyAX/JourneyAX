import { Controller, Get, Query } from '@nestjs/common';
import { Public } from './auth/auth.guard';
import { connectToDatabase, OutboxRepository } from '@journeyax/database';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  rootHealth() {
    return {
      status: 'ok',
      service: 'journey-runtime-service',
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('api/v1/health')
  apiHealth() {
    return {
      status: 'ok',
      service: 'journey-runtime-service',
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('health/worker')
  async workerHealth(@Query('tenantId') tenantId?: string) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      return {
        status: 'ok',
        mode: 'in-memory',
        worker: 'active',
        metrics: { pending: 0, leased: 0, published: 0, deadLetter: 0 },
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      const repo = new OutboxRepository(db);
      const metrics = typeof (repo as any).getMetrics === 'function'
        ? await (repo as any).getMetrics(tenantId)
        : { pending: 0, leased: 0, published: 0, deadLetter: 0 };
      return {
        status: metrics.deadLetter > 50 ? 'degraded' : 'ok',
        mode: 'mongodb',
        worker: 'active',
        metrics,
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        status: 'error',
        error: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}
