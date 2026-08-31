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
import * as bodyParser from 'body-parser';
import { ProductModule } from './product.module';

async function bootstrap() {
  const app = await NestFactory.create(ProductModule, { bodyParser: false });
  // CDL analyze accepts an uploaded design image as a base64 data URL, which
  // easily exceeds Nest's default 100kb JSON limit (a small JPEG → ~180kb). Use
  // the same 10mb ceiling the gateway and agent already run with.
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
  app.enableCors();
  const port = process.env.PORT || process.env.PRODUCT_SERVICE_PORT || 8083;
  await app.listen(port);
  // CDL decompose can call FabricDiffusion on Replicate, whose FIRST call
  // cold-starts a GPU (~7 min). Node's default 5-min requestTimeout would kill
  // that request mid-flight (empty response). Give long-running design calls
  // room; ordinary requests are unaffected.
  const server = app.getHttpServer();
  server.requestTimeout = 900_000;   // 15 min
  server.headersTimeout = 905_000;
  console.log(`[Product Service] Running on HTTP port ${port}`);
}
bootstrap();
