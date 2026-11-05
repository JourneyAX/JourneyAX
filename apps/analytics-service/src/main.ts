import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';

// Load env vars from monorepo root .env
config({ path: process.env.JOURNEYAX_ENV_FILE || resolve(__dirname, '../../../.env') });

import { NestFactory } from '@nestjs/core';
import { AnalyticsModule } from './analytics.module';

async function bootstrap() {
  const app = await NestFactory.create(AnalyticsModule);
  app.enableCors();
  const port = process.env.PORT || process.env.ANALYTICS_SERVICE_PORT || 8086;
  await app.listen(port);
  console.log(`[Analytics Service] Running on HTTP port ${port}`);
}
bootstrap();
