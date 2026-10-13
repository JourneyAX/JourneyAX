/** Server-sent events, parsed the way a browser does: frames end at a blank line, `event:`/`data:` lines, comments ignored. */

export interface SseFrame {
  event: string;
  /** The raw `data:` text (multi-line data is joined with newlines). */
  data: string;
  /** The parsed JSON when the data is JSON. */
  json?: any;
  jsonError?: boolean;
  /** Milliseconds since the request was sent when the frame completed. */
  atMs: number;
}

export function parseFrame(frame: string, atMs: number): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0 && event === 'message') return null;
  const raw = data.join('\n');
  try { return { event, data: raw, json: JSON.parse(raw), atMs }; } catch { return { event, data: raw, jsonError: true, atMs }; }
}

/** Parses a whole stream held in memory (tests, recorded transcripts). */
export function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const part of text.split(/\r?\n\r?\n/)) {
    if (!part.trim()) continue;
    const frame = parseFrame(part, 0);
    if (frame) frames.push(frame);
  }
  return frames;
}

/** Reads a fetch response body as a live stream, handing each completed frame over as it arrives. */
export async function readSse(response: Response, startedAt: number): Promise<{ frames: SseFrame[]; truncated: boolean }> {
  const frames: SseFrame[] = [];
  const reader = response.body?.getReader();
  if (!reader) return { frames, truncated: true };
  const decoder = new TextDecoder();
  let buffer = '';
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const index = match.index!;
        const frame = parseFrame(buffer.slice(0, index), Date.now() - startedAt);
        if (frame) frames.push(frame);
        buffer = buffer.slice(index + match[0].length);
      }
    }
  } catch {
    truncated = true;
  }
  // A frame the server never terminated with a blank line is a truncated stream, even if it parses.
  if (buffer.trim()) {
    truncated = true;
    const frame = parseFrame(buffer, Date.now() - startedAt);
    if (frame) frames.push(frame);
  }
  return { frames, truncated };
}
