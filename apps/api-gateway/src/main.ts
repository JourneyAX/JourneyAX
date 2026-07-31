import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';

// Load env vars from monorepo root .env
config({ path: resolve(__dirname, '../../../.env') });

import { NestFactory } from '@nestjs/core';
import { GatewayModule } from './gateway.module';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(GatewayModule);

  // Allow large payloads (chat history can be verbose)
  app.use(bodyParser.json({ limit: '10mb' }));

  app.enableCors({
    origin: [
      'http://localhost:3008',  // journeyax-web
      'http://localhost:3009',  // backoffice-admin
      /\.journeyax\.com$/,      // production subdomains
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
    credentials: true,
  });

  const port = process.env.PORT || process.env.GATEWAY_PORT || 3010;
  await app.listen(port);
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  JourneyAX API Gateway  — port ${port}          ║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  UI    → Gateway :${port} → Services           ║`);
  console.log(`║                                              ║`);
  console.log(`║  Routes:                                     ║`);
  console.log(`║  /api/v1/commerce  → agent-commerce:3004    ║`);
  console.log(`║  /api/v1/products  → product-svc:8083       ║`);
  console.log(`║  /api/v1/projects  → project-svc:8082       ║`);
  console.log(`║  /api/v1/auth      → auth-svc:8080          ║`);
  console.log(`║  /api/v1/leads     → lead-svc:8087          ║`);
  console.log(`║  /api/v1/analytics → analytics-svc:8086     ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
}
bootstrap();
