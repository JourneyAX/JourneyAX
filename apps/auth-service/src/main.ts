import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';

// Load env vars from monorepo root .env
config({ path: resolve(__dirname, '../../../.env') });

import { NestFactory } from '@nestjs/core';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';

async function bootstrap() {
  const app = await NestFactory.create(AuthModule);
  app.enableCors({
    origin: [
      'http://localhost:3008',
      'http://localhost:3009',
      'http://localhost:3010',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
    credentials: true,
  });

  // Ensure MongoDB indexes on startup
  const authService = app.get(AuthService);
  await authService.ensureIndexes();

  const port = process.env.AUTH_SERVICE_PORT || 8080;
  await app.listen(port);
  console.log(`[Auth Service] Running on HTTP port ${port}`);
  console.log(`[Auth Service] JWT_SECRET: ${process.env.JWT_SECRET ? '✅ set' : '❌ MISSING — set JWT_SECRET in .env'}`);
}
bootstrap();
