import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OrderService } from './order.service';

/** Reconciles the explicitly deployed scope even when no customer has the checkout page open. */
@Injectable()
export class PaymentRecoveryWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentRecoveryWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(@Inject(OrderService) private readonly orders: OrderService) {}
  onModuleInit() {
    const tenantId = process.env.RUNTIME_TENANT_ID || process.env.PROJECT_ID;
    const environmentId = process.env.COMMERCE_ENVIRONMENT;
    if (!process.env.MONGODB_URI || !tenantId || !environmentId) return;
    const tick = () => {
      if (this.stopped || this.running) return;
      this.running = this.orders.reconcilePending(tenantId, environmentId).then(() => {}).catch(() => { this.logger.error('Payment recovery could not finish; no payment success was assumed.'); }).finally(() => { this.running = undefined; });
    };
    this.timer = setInterval(tick, 30_000); tick();
  }
  async onModuleDestroy() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.running; }
}
