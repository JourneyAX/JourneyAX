import { Injectable } from '@nestjs/common';

/**
 * ResponseComposer
 *
 * Domain-neutral presentation framing, media stripping, item listing compaction,
 * and generic dynamic card presentation envelopes.
 */

export interface CardPresentationEnvelope {
  cardType: string;
  template?: string;
  title?: string;
  description?: string;
  data: Record<string, any>;
  bindings?: Record<string, string>;
  actions?: Array<{ label: string; action: string; payload?: any }>;
}

@Injectable()
export class ResponseComposer {
  /**
   * Backstop: strips image/link markdown from chat text since UI cards render media.
   */
  stripChatMedia(text: string): string {
    if (!text) return text;
    return text
      .replace(/!\[[^\]]*\]\([^)]*(?:\([^)]*\)[^)]*)*\)/g, '')
      .replace(/!\[[^\]]*\]/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\.(?:png|jpe?g|webp|avif|svg|gif)\)?/gi, '')
      .replace(/\(\s*\)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Names of the items a card is rendering this turn (showItems / presentComparison).
   */
  shownItemNames(uiToolCalls: any[]): string[] {
    const names: string[] = [];
    for (const call of uiToolCalls || []) {
      const fn = call?.function?.name;
      if (fn !== 'showItems' && fn !== 'presentComparison') continue;
      let args: any = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        continue;
      }
      const items: any[] = args.products || args.items || [];
      for (const it of items) {
        const n = String(it?.name || it?.title || '').trim();
        if (n) names.push(n);
      }
    }
    return [...new Set(names)];
  }

  /**
   * Eliminates prose that merely enumerates the items already visible in cards.
   */
  compactItemListing(text: string, names: string[]): string {
    if (!text || names.length < 2) return text;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const keys = [
      ...new Set(
        names.flatMap((n) => {
          const k = norm(n);
          const short = k.split(' ').slice(0, 4).join(' ');
          return short.length >= 12 && short !== k ? [k, short] : [k];
        })
      ),
    ].filter((k) => k.length >= 4);

    const lines = text.split('\n');
    const kept: string[] = [];
    for (const l of lines) {
      const nl = norm(l);
      const isEnumeration =
        keys.some((k) => nl.includes(k)) &&
        (/^\s*(\d+[\.\)]|[-*•])\s+/.test(l) || /:\s*\$[\d,]+/.test(l));
      if (!isEnumeration) kept.push(l);
    }
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Composes a generic dynamic card presentation envelope from a pack definition.
   */
  composeCard(
    cardType: string,
    cardDef: any,
    runtimeData: Record<string, any>
  ): CardPresentationEnvelope {
    return {
      cardType,
      template: cardDef?.template || 'default',
      title: cardDef?.title || runtimeData.title,
      description: cardDef?.description || runtimeData.description,
      data: {
        ...(cardDef?.defaultData || {}),
        ...runtimeData,
      },
      bindings: cardDef?.bindings || {},
      actions: cardDef?.actions || runtimeData.actions || [],
    };
  }

  /**
   * Streams a text token to the client.
   */
  emitToken(emit: ((event: string, data: any) => void) | undefined, token: string): void {
    if (!emit || !token) return;
    emit('token', { token });
  }

  /**
   * Streams a UI action (card/panel instruction) to the client.
   */
  emitUiAction(
    emit: ((event: string, data: any) => void) | undefined,
    name: string,
    args: any
  ): void {
    if (!emit) return;
    emit('uiAction', { name, arguments: args });
  }

  /**
   * Emits a generic dynamic card presentation envelope.
   */
  emitPresentCard(
    emit: ((event: string, data: any) => void) | undefined,
    envelope: CardPresentationEnvelope
  ): void {
    if (!emit) return;
    emit('uiAction', {
      name: 'presentCard',
      arguments: envelope,
    });
  }

  /**
   * Emits session state / intent metadata chunk.
   */
  emitData(
    emit: ((event: string, data: any) => void) | undefined,
    payload: { sessionId: string; intent?: any; trace?: any[] }
  ): void {
    if (!emit) return;
    emit('data', payload);
  }

  /**
   * Emits stream completion event.
   */
  emitDone(emit: ((event: string, data: any) => void) | undefined): void {
    if (!emit) return;
    emit('done', {});
  }
}
