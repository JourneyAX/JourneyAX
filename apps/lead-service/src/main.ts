import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { LeadModule } from './lead.module';

async function bootstrap() {
  const app = await NestFactory.create(LeadModule);
  app.enableCors();
  // Must match the gateway's LEAD_SERVICE_URL default (8087) or lead routing 404s.
  const port = process.env.PORT || process.env.LEAD_SERVICE_PORT || 8087;
  await app.listen(port);
  console.log(`[Lead Service] Running on HTTP port ${port}`);
}
bootstrap();
