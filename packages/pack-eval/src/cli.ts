import { EvaluationRunner } from './eval-runner';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const args = process.argv.slice(2);
  let tenantId = 'placemakers';
  let environmentId: 'dev' | 'test' | 'staging' | 'production' = 'production';
  let suitePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant' && args[i + 1]) {
      tenantId = args[i + 1];
      i++;
    } else if (args[i] === '--env' && args[i + 1]) {
      environmentId = args[i + 1] as any;
      i++;
    } else if (args[i] === '--suite' && args[i + 1]) {
      suitePath = args[i + 1];
      i++;
    }
  }

  console.log(`\n🧪 Running Evaluation Gate for Tenant: '${tenantId}' (${environmentId})...\n`);

  const runner = new EvaluationRunner();
  try {
    const result = await runner.runSuite({
      tenantId,
      environmentId,
      suitePath,
    });

    console.log(`Suite: ${result.suiteId} (${result.durationMs}ms)`);
    console.log(`Total Scenarios: ${result.totalScenarios}, Passed: ${result.passedScenarios}, Failed: ${result.failedScenarios}\n`);

    for (const s of result.scenarios) {
      if (s.passed) {
        console.log(`  ✅ PASS: ${s.name} [${s.scenarioId}] (${s.durationMs}ms)`);
        console.log(`     Reached Stage: ${s.finalStage}`);
        console.log(`     Capabilities: ${s.executedCapabilities.join(', ') || 'none'}`);
        for (const t of s.turns) {
          console.log(`       Turn ${t.turnIndex} User: "${t.customerMessage}"`);
          console.log(`       Turn ${t.turnIndex} Reply: "${t.assistantMessage}"`);
        }
      } else {
        console.error(`  ❌ FAIL: ${s.name} [${s.scenarioId}] (${s.durationMs}ms)`);
        console.error(`     Reached Stage: ${s.finalStage} (expected: ${s.expectedStage})`);
        for (const failure of s.failures) {
          console.error(`     - ${failure}`);
        }
        for (const t of s.turns) {
          console.error(`       Turn ${t.turnIndex} User: "${t.customerMessage}"`);
          console.error(`       Turn ${t.turnIndex} Reply: "${t.assistantMessage}"`);
          console.error(`       Turn ${t.turnIndex} Stage: ${t.stage}, Decision: ${t.decisionType}, Facts: ${JSON.stringify(t.facts)}`);
        }
      }
      console.log('');
    }

    // Save sanitized SSE transcript artifact if placemakers
    if (tenantId === 'placemakers') {
      const transcriptFile = path.resolve(process.cwd(), 'docs', 'placemakers-sse-transcript-sanitized.json');
      const transcriptData = {
        metadata: {
          tenantId: 'placemakers',
          generatedAt: new Date().toISOString(),
          evaluationSuiteId: result.suiteId,
          allPassed: result.passed,
        },
        scenarios: result.scenarios.map((s) => ({
          scenarioId: s.scenarioId,
          name: s.name,
          passed: s.passed,
          finalStage: s.finalStage,
          executedCapabilities: s.executedCapabilities,
          turns: s.turns.map((t) => ({
            turn: t.turnIndex,
            userMessage: t.customerMessage,
            assistantMessage: t.assistantMessage,
            stage: t.stage,
            decision: t.decisionType,
            cards: t.cardTypes,
          })),
        })),
      };
      fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
      fs.writeFileSync(transcriptFile, JSON.stringify(transcriptData, null, 2), 'utf8');
      console.log(`📝 Updated evidence transcript saved to ${transcriptFile}\n`);
    }

    if (!result.passed) {
      console.error(`\n❌ EVALUATION SUITE FAILED: ${result.failedScenarios} scenarios did not pass.\n`);
      process.exit(1);
    }

    console.log(`\n🎉 EVALUATION SUITE PASSED ALL ${result.passedScenarios} SCENARIOS!\n`);
    process.exit(0);
  } catch (err: any) {
    console.error(`\n❌ Error running evaluation suite:`, err);
    process.exit(1);
  }
}

main();
