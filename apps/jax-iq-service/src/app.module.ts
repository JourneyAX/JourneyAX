import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { IqController } from './iq.controller';
import { IqService } from './iq.service';

@Module({
  controllers: [HealthController, IqController],
  providers: [IqService],
})
export class AppModule {}
