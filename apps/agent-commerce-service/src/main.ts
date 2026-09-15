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
  console.log(`[Agent Commerce Service] Default Fallback LLM: ${process.env.LLM_MODEL || 'gpt-4o-mini'} (Per-project models configured in backoffice, e.g. PlaceMakers -> jax-placemakers-1.0)`);
  console.log(`[Agent Commerce Service] Product Service: ${process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083'}`);

  // Background keep-warm heartbeat for PlaceMakers GPU model on Cloud Run
  startGpuKeepWarmHeartbeat();
}

function startGpuKeepWarmHeartbeat() {
  // Opt-in only: a laptop with no GPU model configured has nothing to keep
  // warm, and the gcloud call below prints a full re-auth lecture to stderr
  // every 3.5 minutes once the personal login expires.
  const targetUrl = process.env.JAX_PLACEMAKERS_MODEL_URL;
  if (!targetUrl) return;
  const ping = async () => {
    const t0 = Date.now();
    try {
      const { execSync } = await import('child_process');
      const token = execSync('gcloud auth print-identity-token', { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const res = await fetch(`${targetUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          model: 'jax-placemakers-1.0',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        console.log(`[JourneyAX:KeepWarm] ⚡ GPU keep-warm heartbeat: ${Date.now() - t0}ms (VRAM warm)`);
      }
    } catch {
      // Best-effort background heartbeat
    }
  };

  // Run initial warm-up check in background, then recurring every 3.5 minutes (210s)
  setTimeout(ping, 2000);
  setInterval(ping, 210_000);
}

bootstrap();
