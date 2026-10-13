import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSuite } from '@journeyax/test-support';
import { CARD_TYPES, DEFAULT_TEMPLATES, DEFAULT_TOKENS, getDefaultTemplate, mergeTokens, tokensToCssVars, cssVarsToString } from '@journeyax/ui-cards';
import { CardRenderer } from '@journeyax/ui-cards/react';
import { answerLabel, answerSummary } from '@journeyax/ui-cards/answers';
import { runCanary } from '../../packages/canary/src';
import { sampleStateFor } from '../../apps/backoffice-admin/src/lib/cardSampleState';
import { startPublicPath } from './harness';
import { buildPlaceMakersStack } from '../../apps/journey-runtime-service/test/helpers/placemakers-stack';

/**
 * Every card a customer can be sent renders, and renders through the tenant's theme: the cards the real public path produced for
 * the canary scenarios, and a sample of every platform card type, go through the real card renderer with the platform templates.
 */
const suite = createSuite('cards: every card the public path sends renders, themed');
const canarySpec = JSON.parse(readFileSync(path.resolve(__dirname, '../../scripts/canary/placemakers.canary.json'), 'utf8'));

const render = (cardType: string, state: any, tokens = DEFAULT_TOKENS, template: any = DEFAULT_TEMPLATES[cardType as keyof typeof DEFAULT_TEMPLATES]) =>
  renderToStaticMarkup(<div style={tokensToCssVars(tokens) as any}><CardRenderer template={template} state={state} /></div>);

const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

async function main() {
  const quiet = console.log;
  console.log = () => undefined;
  const publicPath = await startPublicPath();
  const report = await runCanary({ url: publicPath.chatStreamUrl, headers: publicPath.customerHeaders }, canarySpec);
  const pack: any = publicPath.stack.pack;
  await publicPath.stop();
  console.log = quiet;

  const seen = new Map<string, any>();
  for (const scenario of report.scenarios) for (const turn of scenario.turns) for (const frame of turn.transcript as any[]) {
    const card = frame.event === 'uiAction' ? frame.data?.arguments?.card : undefined;
    if (card) seen.set(`${card.cardType}:${scenario.id}`, card);
  }

  await suite.test('the pack the public path served allows exactly the cards it sent, and every one is a platform card with a template', () => {
    const sent = new Set([...seen.values()].map((card) => card.cardType));
    assert.ok(sent.size >= 3, `card types sent: ${[...sent].join(', ')}`);
    const allowed: string[] = pack.experience.cards.allowedCardTypes;
    for (const cardType of sent) {
      assert.ok(allowed.includes(cardType), `${cardType} is allowed by the pack`);
      assert.ok((CARD_TYPES as any)[cardType] && DEFAULT_TEMPLATES[cardType as keyof typeof DEFAULT_TEMPLATES], `${cardType} has a schema and a template`);
    }
  });

  await suite.test('every card the canary received renders without error and without broken text', () => {
    for (const [key, card] of seen) {
      const html = render(card.cardType, card.state);
      const plain = text(html);
      assert.ok(plain.trim().length > 0, `${key} rendered something`);
      assert.doesNotMatch(plain, /undefined|NaN|\[object Object\]|null/, `${key}: ${plain.slice(0, 160)}`);
    }
  });

  await suite.test('product cards show the name and a price in the shop\'s currency; the cross-sell card carries its heading and its not-confirmed note', () => {
    const products = [...seen.values()].find((card) => card.cardType === 'products')!;
    const html = text(render('products', products.state));
    for (const product of products.state.products.slice(0, 3)) {
      assert.ok(html.includes(product.title), `${product.title} is shown`);
      assert.match(html, /NZ\$|NZD|\$\s?\d/, 'a price is shown');
    }
    assert.doesNotMatch(html, /Add all to/, 'alternatives in a product overview are not a ready-made basket');
    assert.match(text(render('bundle', sampleFor('bundle'))), /Add all to/, 'a deliberately assembled bundle retains its bulk action');
    const accessories = [...seen.values()].find((card) => card.cardType === 'accessories')!;
    const accessoriesText = text(render('accessories', accessories.state));
    assert.match(accessoriesText, /Have you considered\?/);
    assert.match(accessoriesText, /not confirmed to be compatible/);
    assert.ok(!/Goes with it|Accessories & add-ons/.test(accessoriesText), 'no template wording competes with the tenant\'s own heading');
    const clarify = [...seen.values()].find((card) => card.cardType === 'clarify')!;
    for (const question of clarify.state.questions) assert.ok(text(render('clarify', clarify.state)).includes(question.text), 'the question is shown');
  });

  await suite.test('theming: the card stylesheet reads only theme variables, every one a tenant theme defines, with no hard-coded colour; a tenant theme reaches the markup', () => {
    const css = readFileSync(path.resolve(__dirname, '../../packages/ui-cards/styles.css'), 'utf8');
    const defined = new Set(Object.keys(tokensToCssVars(DEFAULT_TOKENS)));
    const referenced = new Set([...css.matchAll(/var\((--jx-[a-z0-9-]+)/g)].map((match) => match[1]));
    assert.deepEqual([...referenced].filter((name) => !defined.has(name) && !name.startsWith('--jx-x-')), [], 'a tenant theme cannot style a variable no token defines');
    assert.ok(referenced.size >= 20, `the stylesheet is driven by ${referenced.size} theme variables`);
    // A colour literal is allowed only as the fallback inside var(--jx-…, <fallback>); everywhere else it would ignore the theme.
    const withoutFallbacks = css.replace(/var\(--jx-[a-z0-9-]+,[^)]*\)/g, 'var(--x)');
    assert.deepEqual(withoutFallbacks.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [], [], 'no hard-coded colour outside a theme variable');
    for (const cardType of Object.keys(CARD_TYPES)) {
      assert.doesNotMatch(render(cardType, sampleFor(cardType)).replace(/--jx-[a-z0-9-]+:[^;"]+/g, ''), /#[0-9a-f]{3,8}\b|rgba?\(/i, `${cardType} has a hard-coded colour in its markup`);
    }
    const branded = mergeTokens({ colors: { brand: '#0B5FFF', accent: '#FF6A00' } } as any);
    assert.match(cssVarsToString(tokensToCssVars(branded)), /--jx-color-brand:#0B5FFF/);
    assert.match(render('products', [...seen.values()].find((card) => card.cardType === 'products')!.state, branded), /--jx-color-brand:#0B5FFF/);
  });

  await suite.test('a tapped answer reads in the customer\'s words, never as the option\'s internal code, and the server still reads it back', async () => {
    const paint = { id: 'nav_paint', text: 'Which type of Paint are you looking for?', options: [{ value: 'interior-paint', label: 'Interior Paint' }, { value: 'primers-sealers-and-undercoats', label: 'Primers Sealers & Undercoats' }] };
    assert.equal(answerSummary([paint], { nav_paint: 'interior-paint' }), 'Which type of Paint are you looking for? → Interior Paint');
    assert.equal(answerLabel(paint, 'primers-sealers-and-undercoats'), 'Primers Sealers & Undercoats');
    assert.equal(answerLabel(paint, 'something typed'), 'something typed', 'a value that is no option stays as it is');
    // Plain-string options (value is the label), several questions, no answer yet, an answer carried on the question itself.
    const size = { id: 'size', title: 'How big?', options: ['Small', 'Large'] };
    const budget = { id: 'budget', text: 'Budget?', options: [], answer: 'under 50' };
    assert.equal(answerSummary([paint, size, budget], { nav_paint: 'interior-paint' }), 'Which type of Paint are you looking for? → Interior Paint\nHow big? → Not answered\nBudget? → under 50');
    // A multi-select keeps its values: its labels may contain commas, which would split the answer wrongly.
    const rooms = { id: 'rooms', text: 'Which rooms?', multi: true, options: [{ value: 'kitchen', label: 'Kitchen, pantry' }, { value: 'bath', label: 'Bathroom' }] };
    assert.equal(answerSummary([rooms], { rooms: 'kitchen, bath' }), 'Which rooms? → kitchen, bath');
    // The server understands the label as well as the value: the same conversation, both ways.
    const stack = await buildPlaceMakersStack({ environmentId: 'production' });
    const service: any = stack.serviceFor();
    const ask = (workspaceId: string, message: string, n: number) => service.executeTurn({ tenantId: 'placemakers', environmentId: 'production', workspaceId, sessionId: workspaceId, turnId: `${workspaceId}-${n}`, correlationId: `${workspaceId}-${n}`, message }, stack.pack);
    const quietly = console.log;
    console.log = () => undefined;
    try {
      for (const [workspaceId, pick] of [['label', (option: any) => option.label], ['value', (option: any) => option.value]] as const) {
        const first = await ask(workspaceId, 'paint', 1);
        const question = first.uiInstructions.find((card: any) => card.component === 'clarify').props.questions[0];
        const option = question.options.find((entry: any) => entry.value === 'interior-paint');
        assert.equal(answerLabel(question, option.value), 'Interior Paint');
        const second = await ask(workspaceId, `My answers:\n${answerSummary([question], { [question.id]: pick(option) })}`, 2);
        assert.equal(second.trace.knowledgeGate.conceptId.split('/').pop(), 'interior-paint', workspaceId);
        assert.ok(second.uiInstructions.some((card: any) => card.component === 'products'), workspaceId);
      }
    } finally { console.log = quietly; }
  });

  await suite.test('every platform card type has a valid sample, renders, and its default template only binds fields its schema declares', () => {
    for (const [cardType, definition] of Object.entries(CARD_TYPES as Record<string, any>)) {
      const sample = sampleFor(cardType);
      const parsed = definition.state.safeParse(sample);
      assert.ok(parsed.success, `${cardType} sample: ${parsed.success ? '' : parsed.error.issues[0]?.message}`);
      assert.ok(getDefaultTemplate(cardType as any), `${cardType} has a default template`);
      assert.doesNotMatch(text(render(cardType, parsed.data)), /undefined|NaN|\[object Object\]/, cardType);
    }
  });
}

/** The catalogue's own sample for each card type (the same states the Cards & Theme studio previews with). */
function sampleFor(cardType: string): any {
  return sampleStateFor(cardType as any);
}

main().then(() => { suite.finish(); process.exit(process.exitCode ?? 0); }).catch((error) => { console.error(error); process.exit(1); });
