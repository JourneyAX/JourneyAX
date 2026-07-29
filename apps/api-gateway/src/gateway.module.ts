import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { TenantMiddleware } from './gateway.registry';
import { AuthGuard } from './auth.guard';

@Module({
  controllers: [GatewayController],
  providers: [GatewayService],
})
export class GatewayModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantMiddleware, AuthGuard)
      .forRoutes('*');
  }
}
