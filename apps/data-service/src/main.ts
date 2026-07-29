import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataModule } from './data.module';

async function bootstrap() {
  const app = await NestFactory.create(DataModule);
  app.enableCors();
  const port = 8084;
  await app.listen(port);
  console.log(`[Data Service] Running on HTTP port ${port}`);
}
bootstrap();
