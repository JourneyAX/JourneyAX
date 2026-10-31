import type { McpCallResult, McpToolOutput } from './types';

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');

/** Cuts a string to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end = Math.floor(end * 0.9);
  return text.slice(0, end);
}

/** Every array inside a JSON value, with the function that replaces it. */
function arraysIn(root: any): Array<{ array: any[]; set: (next: any[]) => void }> {
  const found: Array<{ array: any[]; set: (next: any[]) => void }> = [];
  const walk = (node: any, set: (next: any) => void) => {
    if (Array.isArray(node)) {
      found.push({ array: node, set });
      node.forEach((child, index) => walk(child, (next) => { node[index] = next; }));
    } else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], (next) => { node[key] = next; });
    }
  };
  walk(root, () => undefined);
  return found;
}

/**
 * Makes a JSON value fit in `maxBytes`. The largest list inside it is halved, again and again, until it fits; the number of items left
 * out is reported. A value with no list left to cut is replaced by the start of its text.
 */
export function capValue(value: unknown, maxBytes: number): { value: unknown; truncated: boolean; omitted: number } {
  if (sizeOf(value) <= maxBytes) return { value, truncated: false, omitted: 0 };
  const work: any = JSON.parse(JSON.stringify(value));
  let omitted = 0;
  for (let guard = 0; guard < 200 && sizeOf(work) > maxBytes; guard++) {
    const biggest = arraysIn(work)
      .filter((entry) => entry.array.length > 0)
      .sort((a, b) => sizeOf(b.array) - sizeOf(a.array))[0];
    if (!biggest) break;
    const keep = Math.floor(biggest.array.length / 2);
    omitted += biggest.array.length - keep;
    biggest.array.length = keep;
  }
  if (sizeOf(work) <= maxBytes) return { value: work, truncated: true, omitted };
  const text = truncateUtf8(JSON.stringify(value) ?? '', Math.max(0, maxBytes - 64));
  return { value: { truncatedText: text }, truncated: true, omitted };
}

/** What a server sent, as the model should get it: text or structured data, capped in size, with secrets scrubbed. */
export function normaliseToolResult(result: McpCallResult, maxBytes: number, redact: (text: string) => string = (text) => text): McpToolOutput {
  const isError = result.isError === true;
  const textParts: string[] = [];
  for (const block of result.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
    else if (block?.type) textParts.push(`[${block.type} content omitted]`);
  }
  let text = redact(textParts.join('\n'));

  if (!isError && result.structuredContent !== undefined) {
    const scrubbed = JSON.parse(redact(JSON.stringify(result.structuredContent) ?? 'null'));
    const capped = capValue(scrubbed, maxBytes);
    return { isError, text: '', data: capped.value, truncated: capped.truncated, ...(capped.omitted ? { omitted: capped.omitted } : {}), bytes: sizeOf(capped.value) };
  }
  const truncated = Buffer.byteLength(text, 'utf8') > maxBytes;
  if (truncated) text = truncateUtf8(text, maxBytes);
  return { isError, text, truncated, bytes: Buffer.byteLength(text, 'utf8') };
}
