import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';

// Load env vars from monorepo root .env
config({ path: resolve(__dirname, '../../../.env') });

import { NestFactory } from '@nestjs/core';
import { ProjectModule } from './project.module';

async function bootstrap() {
  const app = await NestFactory.create(ProjectModule);
  app.enableCors();
  const port = process.env.PORT || process.env.PROJECT_SERVICE_PORT || 8082;
  await app.listen(port);
  console.log(`[Project Service] Running on HTTP port ${port}`);
}
bootstrap();
