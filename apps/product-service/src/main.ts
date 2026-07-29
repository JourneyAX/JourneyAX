import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';

/* Load env vars from monorepo root .env — and let the FILE win.
 *
 * dotenv's default is to keep any variable already present in the process
 * environment. Under turbo, that environment is inherited from a supervisor
 * started hours or days ago: fix a key in .env, restart the service, and the
 * child still carries the supervisor's stale value — which is how embeddings
 * stayed broken through a key rotation and every search silently degraded to
 * regex. In this stack .env IS the configuration of record, so it overrides. */
config({ path: resolve(__dirname, '../../../.env'), override: true });

import { NestFactory } from '@nestjs/core';
import { ProductModule } from './product.module';

async function bootstrap() {
  const app = await NestFactory.create(ProductModule);
  app.enableCors();
  const port = process.env.PRODUCT_SERVICE_PORT || 8083;
  await app.listen(port);
  console.log(`[Product Service] Running on HTTP port ${port}`);
}
bootstrap();
