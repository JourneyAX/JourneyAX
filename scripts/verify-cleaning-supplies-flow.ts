import dotenv from 'dotenv';
dotenv.config();
import { RuntimeService } from '../apps/journey-runtime-service/src/runtime.service';
import assert from 'assert';

async function main() {
  const runtime = new RuntimeService();

  const sessionId = `test_cleaning_${Date.now()}`;
  console.log(`\n=== Testing 3-Turn Cleaning Workflow for session ${sessionId} ===\n`);

  // Turn 1: "cleanning supplies" (with typo)
  console.log('--- Turn 1: User says "cleanning supplies" ---');
  let t1Events: any[] = [];
  const t1Result = await runtime.streamTurn(
    {
      tenantId: 'placemakers',
      environmentId: 'production',
      sessionId,
      workspaceId: sessionId,
      turnId: `turn_1_${Date.now()}`,
      message: 'cleanning supplies',
    },
    (event, data) => {
      t1Events.push({ event, data });
    }
  );

  const getCards = (events: any[], res: any) => {
    const fromEvents = events.filter((e) => e.event === 'uiAction').map((e) => e.data?.card || e.data?.arguments?.card).filter(Boolean);
    if (fromEvents.length > 0) return fromEvents;
    return (res.uiInstructions || []).map((i: any) => ({ cardType: i.component, ...(i.props || {}) }));
  };

  const t1Cards = getCards(t1Events, t1Result);
  console.log('Turn 1 Stage:', t1Result.workspace.currentStage);
  console.log('Turn 1 Assistant Message:\n', t1Result.assistantMessage);
  console.log('Turn 1 Cards count:', t1Cards.length);
  console.log('Turn 1 Cards types:', t1Cards.map((c: any) => c.cardType || c.type));

  assert.equal(t1Result.workspace.currentStage, 'materials_intake', 'Must remain in materials_intake');
  assert.ok(
    !t1Cards.some((c: any) => (c.cardType || c.type) === 'products'),
    'Turn 1 must NOT emit any product cards'
  );
  assert.ok(
    !t1Result.assistantMessage?.toLowerCase().includes("don't have verified technical documentation"),
    'Turn 1 must NOT deny with "I don\'t have verified technical documentation"'
  );
  assert.ok(
    t1Cards.some((c: any) => (c.cardType || c.type) === 'clarify' || (c.cardType || c.type) === 'options'),
    'Turn 1 must emit a clarification card with options'
  );
  console.log('✅ Turn 1 Verified!\n');

  // Turn 2: "Mops, Buckets & Brooms"
  console.log('--- Turn 2: User selects "Mops, Buckets & Brooms" ---');
  let t2Events: any[] = [];
  const t2Result = await runtime.streamTurn(
    {
      tenantId: 'placemakers',
      environmentId: 'production',
      sessionId,
      workspaceId: sessionId,
      turnId: `turn_2_${Date.now()}`,
      message: 'Mops, Buckets & Brooms (Wringer buckets, squeeze mops, heavy duty tubs)',
    },
    (event, data) => {
      t2Events.push({ event, data });
    }
  );

  console.log('Turn 2 Executed Capabilities:', JSON.stringify(t2Result.executedCapabilities, null, 2));
  const t2Cards = getCards(t2Events, t2Result);
  console.log('Turn 2 Stage:', t2Result.workspace.currentStage);
  console.log('Turn 2 Assistant Message:\n', t2Result.assistantMessage);
  console.log('Turn 2 Cards count:', t2Cards.length);
  console.log('Turn 2 Cards types:', t2Cards.map((c: any) => c.cardType || c.type));

  assert.equal(t2Result.workspace.currentStage, 'materials_recommendation', 'Must transition to materials_recommendation');
  const productCards = t2Cards.filter((c: any) => (c.cardType || c.type) === 'products');
  assert.ok(productCards.length >= 1, 'Turn 2 must emit product cards');
  const items = productCards[0].items || productCards[0].data?.items || productCards[0].state?.items || [];
  console.log(`Turn 2 Recommended ${items.length} products:`, items.map((it: any) => it.name || it.title));
  assert.ok(items.length > 0, 'Must have found matching cleaning products');
  console.log('✅ Turn 2 Verified!\n');

  // Turn 3: "Tell me more about the Wringer Mop Bucket"
  console.log('--- Turn 3: User says "Tell me more about the Raven Wringer Mop Bucket" ---');
  let t3Events: any[] = [];
  const t3Result = await runtime.streamTurn(
    {
      tenantId: 'placemakers',
      environmentId: 'production',
      sessionId,
      workspaceId: sessionId,
      turnId: `turn_3_${Date.now()}`,
      message: 'Tell me more about the Raven Wringer Mop Bucket',
    },
    (event, data) => {
      t3Events.push({ event, data });
    }
  );

  const t3Cards = getCards(t3Events, t3Result);
  console.log('Turn 3 Stage:', t3Result.workspace.currentStage);
  console.log('Turn 3 Assistant Message:\n', t3Result.assistantMessage);
  console.log('Turn 3 Cards count:', t3Cards.length);

  assert.ok(
    t3Result.assistantMessage?.toLowerCase().includes('raven') ||
    t3Result.assistantMessage?.toLowerCase().includes('wringer') ||
    t3Result.assistantMessage?.toLowerCase().includes('bucket') ||
    t3Result.assistantMessage?.toLowerCase().includes('mop'),
    'Turn 3 must provide grounded details about the Raven Wringer Mop Bucket'
  );
  assert.ok(
    !t3Result.assistantMessage?.toLowerCase().includes('what type of cleaning or household supplies'),
    'Turn 3 must NOT repeat the intake question'
  );
  console.log('✅ Turn 3 Verified!\n');

  console.log('🎉 ALL 3 TURNS PASSED CANONICAL VERIFICATION!');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
