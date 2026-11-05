import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AgentModule } from '../src/agent.module';
import { AgentService } from '../src/agent.service';
import { JourneyCoordinator } from '../src/orchestration/journey-coordinator';
import { TenantRuntimeActivationRouter } from '../src/runtime/tenant-runtime-activation.router';
import { CanonicalRuntimeAdapter } from '../src/runtime/canonical-runtime.adapter';
import { QuoteService } from '../src/commerce/quote.service';
import { OrderService } from '../src/commerce/order.service';
import { RosterService } from '../src/commerce/roster.service';
import { SchoolResearchService } from '../src/commerce/school-research.service';
import { WhatsAppService } from '../src/commerce/whatsapp.service';
import { PaymentRecoveryWorkerService } from '../src/commerce/payment-recovery-worker.service';
import { CartController } from '../src/commerce/cart.controller';
import { OperationalDesksController } from '../src/desks/operational-desks.controller';

async function runTests() {
  console.log('🧪 Running Nest Dependency Injection & Application Context Suite...');

  // 1. Boot actual Nest application context from AgentModule
  const app = await NestFactory.createApplicationContext(AgentModule, {
    logger: false,
  });

  if (!app) {
    throw new Error('Nest application context failed to initialize');
  }
  console.log('  ✅ PASS: Nest application context initialized successfully');

  // 2. Resolve AgentService
  const agentService = app.get(AgentService);
  if (!agentService) {
    throw new Error('Failed to resolve AgentService from Nest context');
  }
  console.log('  ✅ PASS: AgentService resolved from Nest context');

  // 3. Resolve JourneyCoordinator
  const coordinator = app.get(JourneyCoordinator);
  if (!coordinator) {
    throw new Error('Failed to resolve JourneyCoordinator from Nest context');
  }
  console.log('  ✅ PASS: JourneyCoordinator resolved from Nest context');

  // 4. Verify that AgentService's coordinator is injected via Nest DI
  const internalCoordinator = (agentService as any).coordinator;
  if (!internalCoordinator || internalCoordinator !== coordinator) {
    throw new Error('AgentService coordinator was not injected properly from Nest DI');
  }
  console.log('  ✅ PASS: JourneyCoordinator correctly injected into AgentService façade');

  // 5. Verify all required runtime providers resolve
  const providers = [
    TenantRuntimeActivationRouter,
    CanonicalRuntimeAdapter,
    QuoteService,
    OrderService,
    RosterService,
    SchoolResearchService,
    WhatsAppService,
    PaymentRecoveryWorkerService,
    CartController,
    OperationalDesksController,
  ];

  for (const provider of providers) {
    const instance = app.get(provider);
    if (!instance) {
      throw new Error(`Failed to resolve provider: ${provider.name}`);
    }
  }
  console.log('  ✅ PASS: All coordinator runtime dependencies resolved via Nest DI');

  await app.close();
  console.log('🎉 ALL NEST DI TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ Nest DI test suite failed:', err);
  process.exit(1);
});
