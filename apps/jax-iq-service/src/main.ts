import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/** The service starts only when someone switched it on on purpose. Returns why it will not start, or nothing. */
export function startRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.JAX_IQ_ENABLED === '1' ? undefined : 'JAX IQ service is switched off. Set JAX_IQ_ENABLED=1 to start it.';
}

async function bootstrap() {
  const refusal = startRefusal();
  if (refusal) {
    console.error(`[JAX IQ Service] ${refusal}`);
    process.exitCode = 1;
    return;
  }
  const app = await NestFactory.create(AppModule);

  const port = process.env.PORT || process.env.JAX_IQ_SERVICE_PORT || 8088;
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`[JAX IQ Service] Listening on ${host}:${port}`);
}

if (require.main === module) {
  bootstrap().catch((error) => { console.error(error); process.exit(1); });
}
