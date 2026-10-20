import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { shapeReply, type ShapeContext, resolveEffectiveReplyStyle } from '../src/kernel/reply-shaper';
import { resolveInterpretationPolicy, type ReplyStyle } from '../src/turn/fact-semantics';
import { resolveTurnKind } from '../src/turn/turn-kind';
import { validatePackSettings } from '../../project-service/src/pack-settings';

const suite = createSuite('runtime: contextual reply styles depend on turn kind (Task B4)');
const basePolicy = resolveInterpretationPolicy();
const baseStyle: ReplyStyle = basePolicy.replyStyle;

const context = (over: Partial<ShapeContext> = {}): ShapeContext => ({
  style: baseStyle,
  companyNames: ['PlaceMakers'],
  questionCardShown: false,
  internalIds: ['cleaning-and-consumables', 'timber-and-building'],
  ...over,
});

async function main() {
  await suite.test('fact and card turns enforce strict short style (max 2 sentences, no lists, no question)', () => {
    const rawReply = [
      'We have standard 100x50 timber available.',
      'What length do you need?',
      '- 2.4m length',
      '- 3.0m length',
    ].join('\n');

    // Card turn (a card is shown on screen)
    const cardShaped = shapeReply(rawReply, context({ turnKind: 'card', questionCardShown: true }));
    assert.equal(cardShaped.text, 'We have standard 100x50 timber available.');
    assert.ok(cardShaped.removed.some((r) => r.reason === 'list'));
    assert.ok(cardShaped.removed.some((r) => r.reason === 'second question'));

    // Pure fact turn
    const factShaped = shapeReply(rawReply, context({ turnKind: 'fact', questionCardShown: false }));
    assert.equal(factShaped.text, 'We have standard 100x50 timber available.');
  });

  await suite.test('howto turn allows numbered steps, up to 6 sentences, and one follow-up question', () => {
    const howToReply = [
      'To install standard plasterboard on timber framing, follow these core steps:',
      '1. Measure and cut the board to fit the wall frame.',
      '2. Fasten the sheets using 32mm drywall screws spaced 300mm apart.',
      '3. Tape and plaster the joints with compound.',
      'Would you like help choosing the right plasterboard screws?',
    ].join('\n');

    const shaped = shapeReply(howToReply, context({ turnKind: 'howto' }));
    assert.ok(shaped.text.includes('1. Measure and cut'));
    assert.ok(shaped.text.includes('2. Fasten the sheets'));
    assert.ok(shaped.text.includes('Would you like help choosing the right plasterboard screws?'));
    assert.equal(shaped.removed.filter((r) => r.reason === 'list').length, 0, 'steps should not be dropped in howto turns');
  });

  await suite.test('recommend turn allows longer grounded recommendations and one follow-up question', () => {
    const recReply = [
      'For your outdoor deck project, H3.2 treated pine is suitable for framing and joists.',
      'It resists fungal decay and insect attack in exterior above-ground situations.',
      'Stainless steel or Class 4 galvanised fixings are recommended to prevent corrosion.',
      'What dimensions are you planning for the deck?',
    ].join('\n');

    const shaped = shapeReply(recReply, context({ turnKind: 'recommend' }));
    assert.ok(shaped.text.includes('H3.2 treated pine is suitable'));
    assert.ok(shaped.text.includes('Stainless steel or Class 4 galvanised fixings'));
    assert.ok(shaped.text.includes('What dimensions are you planning for the deck?'));
  });

  await suite.test('subsequent questions in answer turns are removed, keeping at most one follow-up question', () => {
    const twoQuestions = [
      'Standard H1.2 timber is treated with boron for internal framing protected from moisture.',
      'It should not be used outdoors or in high-moisture ground contact.',
      'Are you building an interior partition wall?',
      'What height will the studs be?',
    ].join('\n');

    const shaped = shapeReply(twoQuestions, context({ turnKind: 'answer' }));
    assert.ok(shaped.text.includes('Are you building an interior partition wall?'));
    assert.ok(!shaped.text.includes('What height will the studs be?'), 'second question should be dropped');
    assert.ok(shaped.removed.some((r) => r.reason === 'second question' && r.sentence.includes('What height')));
  });

  await suite.test('resolveTurnKind classifies turns accurately', () => {
    // How-to inquiry
    assert.equal(
      resolveTurnKind({
        customerQuestion: 'How do I fix a hole in my plasterboard wall?',
        decision: { type: 'complete_goal', payload: {}, reason: 'ok', createdAt: '' } as any,
      }),
      'howto'
    );

    // Recommend inquiry
    assert.equal(
      resolveTurnKind({
        customerQuestion: 'What screws should I use for that deck?',
        decision: { type: 'complete_goal', payload: {}, reason: 'ok', createdAt: '' } as any,
        conversationPlan: { action: 'recommend', products: [{ item: { sku: '123' } }] } as any,
      }),
      'recommend'
    );

    // Card turn
    assert.equal(
      resolveTurnKind({
        customerQuestion: 'paint',
        decision: { type: 'ask_fact', payload: {}, reason: 'ok', createdAt: '' } as any,
        knowledgeGate: { clarification: { question: 'What surface?' } } as any,
      }),
      'card'
    );

    // Pure fact discovery turn
    assert.equal(
      resolveTurnKind({
        customerQuestion: '50m2',
        decision: { type: 'ask_fact', payload: {}, reason: 'ok', createdAt: '' } as any,
        openQuestionIds: ['deck_area'],
      }),
      'fact'
    );

    // General answer
    assert.equal(
      resolveTurnKind({
        customerQuestion: 'Tell me more about the technical specifications of GIB Aqualine',
        decision: { type: 'complete_goal', payload: {}, reason: 'ok', createdAt: '' } as any,
      }),
      'answer'
    );
  });

  await suite.test('pack settings validates turnStyles, allowFollowUpQuestion and maxQuestions', () => {
    const valid = validatePackSettings({
      interpretationPolicy: {
        replyStyle: {
          maxSentences: 3,
          allowFollowUpQuestion: true,
          maxQuestions: 1,
          turnStyles: {
            howto: {
              maxSentences: 6,
              dropListLines: false,
              allowFollowUpQuestion: true,
              maxQuestions: 1,
              rules: ['Provide clear instructions.'],
            },
            recommend: {
              maxSentences: 4,
            },
          },
        },
      },
    });
    assert.equal(valid.ok, true);

    // Invalid turn kind
    const invalidKind = validatePackSettings({
      interpretationPolicy: {
        replyStyle: {
          turnStyles: {
            unsupported_kind: { maxSentences: 5 },
          },
        },
      },
    });
    assert.equal(invalidKind.ok, false);

    // Invalid maxSentences in turnStyles
    const invalidSentences = validatePackSettings({
      interpretationPolicy: {
        replyStyle: {
          turnStyles: {
            howto: { maxSentences: 15 },
          },
        },
      },
    });
    assert.equal(invalidSentences.ok, false);
  });

  process.exitCode = suite.finish() ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
