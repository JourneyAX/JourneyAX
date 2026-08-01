import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';

config({ path: resolve(__dirname, '../../../.env') });

import { NestFactory } from '@nestjs/core';
import { OrganizationModule } from './organization.module';
async function bootstrap() {
  const app = await NestFactory.create(OrganizationModule);

  app.enableCors({
    origin: [
      'http://localhost:3008',
      'http://localhost:3009',
      'http://localhost:3010',
    ],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-User-Email', 'X-User-Role'],
    credentials: true,
  });

  // Note: onModuleInit() in OrganizationService handles DB connect + indexes
  const port = process.env.PORT || process.env.ORG_SERVICE_PORT || 8085;
  await app.listen(port);
  console.log(`[Organization Service] Running on port ${port}`);
  console.log(`[Organization Service] MongoDB: ${process.env.MONGODB_URI ? '✅ connected' : '❌ MONGODB_URI missing'}`);
}
bootstrap();
