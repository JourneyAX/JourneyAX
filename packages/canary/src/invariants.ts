import { CARD_TYPES } from '@journeyax/ui-cards';
import defaults from './defaults/canary-invariants.json';
import type { SseFrame } from './sse';
import type { CanarySpec, TurnExpectation } from './spec';

export type Severity = 'error' | 'warning';
export interface Violation { id: string; severity: Severity; message: string }

export interface TurnObservation {
  status: number;
  headers: Record<string, string>;
  frames: SseFrame[];
  truncated: boolean;
  elapsedMs: number;
  /** The HTTP body when the response was not a stream (an error page, a JSON error). */
  bodyText?: string;
}

export interface TurnSummary {
  reply: string;
  cardTypes: string[];
  capabilities: string[];
  events: string[];
  cards: Array<{ cardType: string; state: any }>;
}

/** What the customer would see and which steps ran, read from the frames. */
export function summarizeTurn(frames: SseFrame[]): TurnSummary {
  const events = frames.map((frame) => frame.event);
  const cards = frames.filter((frame) => frame.event === 'uiAction' && frame.json?.name === 'presentCard' && frame.json?.arguments?.card)
    .map((frame) => ({ cardType: String(frame.json.arguments.card.cardType), state: frame.json.arguments.card.state }));
  const capabilities = frames.filter((frame) => frame.event === 'capability').map((frame) => String(frame.json?.toolId ?? frame.json?.name ?? ''));
  const done = frames.find((frame) => frame.event === 'done')?.json;
  const streamed = frames.filter((frame) => frame.event === 'token').map((frame) => String(frame.json?.delta ?? frame.json?.token ?? '')).join('');
  return { reply: String(done?.message?.content ?? done?.assistantMessage ?? done?.response ?? streamed), cardTypes: cards.map((card) => card.cardType), capabilities, events, cards };
}

const lower = (value: string) => value.toLowerCase();

/**
 * The invariants of the public chat path. They hold for every turn of every scenario, whatever the model said: a stream a
 * browser can consume, with only what a customer may see, in the shop's own currency, that never performs a purchase.
 */
export function checkTurn(observation: TurnObservation, spec: CanarySpec, expect: TurnExpectation = {}): { violations: Violation[]; summary: TurnSummary } {
  const violations: Violation[] = [];
  const add = (id: string, message: string, severity: Severity = 'error') => violations.push({ id, severity, message });
  const rules = defaults;
  const summary = summarizeTurn(observation.frames);
  const headers = Object.fromEntries(Object.entries(observation.headers).map(([key, value]) => [lower(key), value]));

  // ── Transport ──
  if (observation.status !== 200) add('http_status', `the chat stream answered ${observation.status}`);
  if (!lower(headers['content-type'] ?? '').startsWith(rules.stream.contentType)) add('content_type', `content-type is '${headers['content-type'] ?? 'missing'}', not ${rules.stream.contentType}`);
  for (const forbidden of rules.headers.forbid) if (forbidden in headers) add('header_leak', `the response carries '${forbidden}'`);
  if (!rules.headers.requireCacheControl.some((token) => lower(headers['cache-control'] ?? '').includes(token))) add('cache_control', 'a stream must not be cached (cache-control lacks no-cache/no-store)');
  if (observation.truncated) add('truncated', 'the stream ended mid-frame or was cut');

  // ── Stream shape ──
  const names = summary.events;
  for (const frame of observation.frames) {
    if (frame.jsonError) add('data_not_json', `a '${frame.event}' event carried data that is not JSON`);
    if (!rules.stream.allowedEvents.includes(frame.event)) add('event_not_public', `the event '${frame.event}' is not part of the customer-facing stream`);
  }
  if (observation.status === 200 && names.length === 0) add('empty_stream', 'the stream carried no events');
  if (names.length && names[0] !== rules.stream.firstEvent) add('first_event', `the first event is '${names[0]}', expected '${rules.stream.firstEvent}'`, 'warning');
  const terminals = names.filter((name) => rules.stream.terminalEvents.includes(name));
  if (observation.status === 200 && names.length) {
    if (terminals.length !== 1) add('terminal_event', `expected exactly one ${rules.stream.terminalEvents.join('/')} event, found ${terminals.length}`);
    else if (!rules.stream.terminalEvents.includes(names[names.length - 1])) add('terminal_event', 'events were sent after the stream ended');
  }
  if (names.includes('error') && !expect.error) add('error_event', `the turn ended with an error event: ${observation.frames.find((frame) => frame.event === 'error')?.data ?? ''}`);
  if (expect.error && !names.includes('error')) add('error_expected', 'this turn was expected to end in a customer-safe error');

  // ── The reply ──
  if (!expect.error) {
    if (!summary.reply.trim() && !expect.allowNoText) add('no_reply', 'the customer received no text');
    const streamed = observation.frames.filter((frame) => frame.event === 'token').map((frame) => String(frame.json?.delta ?? '')).join('');
    if (streamed && summary.reply && streamed.trim() !== summary.reply.trim()) add('reply_mismatch', 'the streamed text differs from the final message', 'warning');
  }

  // ── Nothing internal reaches the browser ──
  // Scan the frames as sent and as decoded (a stack trace is a newline-separated string inside JSON), plus the headers.
  const strings = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []);
  const wire = [...observation.frames.map((frame) => `${frame.event}\n${frame.data}`), ...observation.frames.flatMap((frame) => strings(frame.json)), JSON.stringify(headers)].join('\n');
  const patterns = [...rules.leakPatterns, ...spec.extraLeakPatterns];
  for (const pattern of patterns) {
    const found = new RegExp(pattern.pattern, 'i').exec(wire);
    // The finding names the kind of content, never the content itself: a credential must not be copied into a report.
    if (found) add(`leak:${pattern.id}`, `internal content reached the browser (${pattern.id})`);
  }

  // ── The reply reads like a person wrote it ──
  // Internal vocabulary and the same sentence twice are the two ways a refusal has gone wrong before.
  for (const source of rules.replyWording.internalVocabulary) {
    const found = new RegExp(source, 'i').exec(summary.reply);
    if (found) add('reply_internal_wording', `the reply uses platform wording ("${found[0]}")`);
  }
  const sentences = summary.reply.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim().toLowerCase()).filter((sentence) => sentence.length >= rules.replyWording.minRepeatedSentenceLength);
  const repeated = sentences.find((sentence, index) => sentences.indexOf(sentence) !== index);
  if (repeated) add('reply_repeats', `the reply says the same thing twice ("${repeated.slice(0, 60)}")`);

  // ── Cards: real card types with valid state, in the shop's currency ──
  for (const card of summary.cards) {
    const definition = (CARD_TYPES as Record<string, any>)[card.cardType];
    if (!definition) { add('card_unknown', `'${card.cardType}' is not a platform card type`); continue; }
    const parsed = definition.state.safeParse(card.state);
    if (!parsed.success) add('card_invalid', `a '${card.cardType}' card does not match its schema: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
    if (rules.forbiddenCardTypes.includes(card.cardType)) add('card_forbidden', `a '${card.cardType}' card appeared on a read-only canary`);
    const products: any[] = [...(card.state?.products ?? []), ...(card.state?.groups ?? []).flatMap((group: any) => group.items ?? [])];
    for (const product of products) {
      if (!product?.sku || !product?.title) add('card_product', `a product in a '${card.cardType}' card has no ${product?.sku ? 'title' : 'code'}`);
      if (typeof product?.price === 'number' && !product.currency) add('price_without_currency', `product ${product.sku} is priced without a currency`);
      if (spec.expectedCurrency && product?.currency && product.currency !== spec.expectedCurrency) add('currency', `product ${product.sku} is priced in ${product.currency}, the shop sells in ${spec.expectedCurrency}`);
      if (typeof product?.price === 'number' && !Number.isFinite(product.price)) add('price_not_finite', `product ${product.sku} has a price that is not a number`);
    }
  }

  // ── A canary never buys ──
  const forbiddenCapabilities = [...rules.forbiddenCapabilities, ...spec.forbiddenCapabilities, ...(expect.capabilities?.forbid ?? [])];
  for (const capability of summary.capabilities) if (forbiddenCapabilities.includes(capability)) add('mutation', `the capability '${capability}' ran during a read-only canary`);

  // ── What this scenario expects ──
  for (const required of expect.cards?.require ?? []) if (!summary.cardTypes.includes(required)) add('expected_card', `a '${required}' card was expected`);
  for (const forbidden of expect.cards?.forbid ?? []) if (summary.cardTypes.includes(forbidden)) add('forbidden_card', `a '${forbidden}' card must not appear here`);
  for (const required of expect.capabilities?.require ?? []) if (!summary.capabilities.includes(required)) add('expected_capability', `the step '${required}' was expected to run`);
  if (expect.text?.matchesAny?.length && !expect.text.matchesAny.some((pattern) => new RegExp(pattern, 'i').test(summary.reply))) add('reply_text', `the reply matches none of: ${expect.text.matchesAny.join(' | ')}`);
  for (const pattern of expect.text?.mustNotMatch ?? []) if (new RegExp(pattern, 'i').test(summary.reply)) add('reply_forbidden', `the reply matches the forbidden pattern ${pattern}`);
  const budget = expect.maxLatencyMs ?? rules.defaultMaxLatencyMs;
  if (observation.elapsedMs > budget) add('latency', `the turn took ${observation.elapsedMs} ms, over the ${budget} ms budget`);
  return { violations, summary };
}
