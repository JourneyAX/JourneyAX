import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';

// Load env vars from monorepo root .env
config({ path: resolve(__dirname, '../../../.env') });

import { NestFactory } from '@nestjs/core';
import * as bodyParser from 'body-parser';
import { AgentModule } from './agent.module';

async function bootstrap() {
  // Disable Nest's default 100kb body parser and use a higher limit — the chat
  // payload carries the full journey state (recommended products + specs/images)
  // and conversation history, which easily exceeds 100kb on the quote turn.
  const app = await NestFactory.create(AgentModule, { bodyParser: false });
  // Preserve the raw body so the Stripe webhook can verify X-Signature over the
  // exact bytes Stripe signed (P0-04). Parsed JSON is still available as req.body.
  app.use(bodyParser.json({
    limit: '10mb',
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
  app.enableCors();
  const port = process.env.PORT || process.env.AGENT_SERVICE_PORT || 3004;
  await app.listen(port);
  console.log(`[Agent Commerce Service] Running on HTTP port ${port}`);
  console.log(`[Agent Commerce Service] LLM Model: ${process.env.LLM_MODEL || 'gpt-5.4-mini'}`);
  console.log(`[Agent Commerce Service] Product Service: ${process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083'}`);
}
bootstrap();
