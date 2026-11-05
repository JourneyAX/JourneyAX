import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RuntimeService } from '../runtime.service';

/** Application intake, independent of any open chat or browser. Not a user-chat reminder/monitor. */
@Injectable()
export class DeskIntakeWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeskIntakeWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(@Inject(RuntimeService) private readonly runtime: RuntimeService) {}
  onModuleInit() {
    // Explicit deployment scope is required; never enumerate all tenants/environments.
    if (!process.env.MONGODB_URI || !process.env.RUNTIME_TENANT_ID || !process.env.COMMERCE_ENVIRONMENT) return;
    const tick = () => {
      if (this.stopped || this.running) return;
      this.running = this.runtime.processDeskIntake(process.env.RUNTIME_TENANT_ID!, process.env.COMMERCE_ENVIRONMENT!)
        .catch(() => { this.logger.error('Scoped case intake failed; its durable checkpoint was retained.'); })
        .finally(() => { this.running = undefined; });
    };
    this.timer = setInterval(tick, 5000);
    tick();
  }
  async onModuleDestroy() {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
