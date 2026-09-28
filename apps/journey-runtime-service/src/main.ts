import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
import { NestFactory } from '@nestjs/core';
import { RuntimeModule } from './runtime.module';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(RuntimeModule);

  // Enforce 1MB payload limits
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ limit: '1mb', extended: true }));

  // Enforce restricted CORS policy
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
  const origin = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map((o) => o.trim())
    : [
        'http://localhost:3008', // journeyax-web
        'http://localhost:3009', // backoffice-admin
        'http://localhost:3010', // api-gateway
        /\.journeyax\.com$/,
      ];

  app.enableCors({
    origin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-ID',
      'X-User-ID',
      'X-User-Role',
      'X-Principal-ID',
      'X-Principal-Role',
      'X-Internal-Key',
    ],
    credentials: true,
  });

  app.enableShutdownHooks();

  const port = process.env.JOURNEY_RUNTIME_PORT || process.env.PORT || 3012;
  await app.listen(port);
  console.log(`🚀 Journey Runtime Service running on port ${port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal error during Journey Runtime Service startup:', err);
  process.exit(1);
});
