import { Chunk, DocumentMetadata } from './types';

const MAX_CHUNK_TOKENS = 500;
const OVERLAP_TOKENS = 100;
// Rough approximation: 1 token ≈ 4 characters
const CHARS_PER_TOKEN = 4;

/**
 * Chunk content based on document type.
 * Different strategies for different content types.
 */
export function chunkContent(
  content: string,
  title: string,
  sourceUrl: string,
  metadata: DocumentMetadata
): Chunk[] {
  switch (metadata.type) {
    case 'product':
      return chunkProduct(content, title, sourceUrl, metadata);
    case 'troubleshooting':
      return chunkTroubleshooting(content, title, sourceUrl, metadata);
    case 'faq':
      return chunkFaq(content, title, sourceUrl, metadata);
    case 'design':
    case 'collection':
      return chunkDesign(content, title, sourceUrl, metadata);
    default:
      return chunkSliding(content, title, sourceUrl, metadata);
  }
}

/**
 * Product pages: 1 chunk = entire product (name + specs + price + description).
 * Products are atomic — you always want the full context.
 */
function chunkProduct(
  content: string,
  title: string,
  sourceUrl: string,
  metadata: DocumentMetadata
): Chunk[] {
  // Products get stored as a single chunk with rich context
  const maxChars = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN * 3; // Allow bigger for products
  const text = content.length > maxChars
    ? `${title}\n\n${content.slice(0, maxChars)}`
    : `${title}\n\n${content}`;

  return [{
    text: cleanText(text),
    index: 0,
    sourceUrl,
    title,
    fullContent: content,
    metadata,
  }];
}

/**
 * Troubleshooting: split by symptom/solution sections.
 */
function chunkTroubleshooting(
  content: string,
  title: string,
  sourceUrl: string,
  metadata: DocumentMetadata
): Chunk[] {
  // Try to split by sections (## headings)
  const sections = content.split(/(?=^##\s+)/m).filter(s => s.trim().length > 50);

  if (sections.length > 1) {
    return sections.map((section, i) => ({
      text: cleanText(`${title}\n\n${section.trim()}`),
      index: i,
      sourceUrl,
      title,
      fullContent: content,
      metadata,
    }));
  }

  // If no clear sections, split by numbered steps or bullet groups
  return chunkSliding(content, title, sourceUrl, metadata);
}

/**
 * FAQ: split by Q&A pairs.
 */
function chunkFaq(
  content: string,
  title: string,
  sourceUrl: string,
  metadata: DocumentMetadata
): Chunk[] {
  // Try to split by question patterns
  const qaPairs = content.split(/(?=(?:^|\n)(?:Q:|###?\s+|(?:\d+\.\s+)?\*\*[^*]+\*\*\s*\??))/m)
    .filter(s => s.trim().length > 30);

  if (qaPairs.length > 1) {
    return qaPairs.map((qa, i) => ({
      text: cleanText(`${title} — FAQ\n\n${qa.trim()}`),
      index: i,
      sourceUrl,
      title,
      fullContent: content,
      metadata,
    }));
  }

  return chunkSliding(content, title, sourceUrl, metadata);
}

/**
 * Design/Collection: split by room or product group sections.
 */
function chunkDesign(
  content: string,
  title: string,
  sourceUrl: string,
  metadata: DocumentMetadata
): Chunk[] {
  const sections = content.split(/(?=^##\s+)/m).filter(s => s.trim().length > 50);

  if (sections.length > 1 && sections.length <= 20) {
    return sections.map((section, i) => ({
      text: cleanText(`${title}\n\n${section.trim()}`),
      index: i,
      sourceUrl,
      title,
      fullContent: content,
      metadata,
    }));
  }

  return chunkSliding(content, title, sourceUrl, metadata);
}

/**
 * Sliding window chunking with overlap — fallback for any content.
 */
function chunkSliding(
  content: string,
  title: string,
  sourceUrl: string,
  metadata: DocumentMetadata
): Chunk[] {
  const maxChars = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;
  const overlapChars = OVERLAP_TOKENS * CHARS_PER_TOKEN;
  const chunks: Chunk[] = [];

  // If content is small enough, keep as one chunk
  if (content.length <= maxChars * 1.5) {
    return [{
      text: cleanText(`${title}\n\n${content}`),
      index: 0,
      sourceUrl,
      title,
      fullContent: content,
      metadata,
    }];
  }

  // Split into paragraphs first, then group into chunks
  const paragraphs = content.split(/\n\n+/);
  let currentChunk = '';
  let chunkIndex = 0;

  for (const para of paragraphs) {
    if ((currentChunk + '\n\n' + para).length > maxChars && currentChunk.length > 0) {
      // Save current chunk
      chunks.push({
        text: cleanText(`${title}\n\n${currentChunk.trim()}`),
        index: chunkIndex++,
        sourceUrl,
        title,
        fullContent: content,
        metadata,
      });

      // Start new chunk with overlap (last portion of current)
      const overlap = currentChunk.slice(-overlapChars);
      currentChunk = overlap + '\n\n' + para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 50) {
    chunks.push({
      text: cleanText(`${title}\n\n${currentChunk.trim()}`),
      index: chunkIndex,
      sourceUrl,
      title,
      fullContent: content,
      metadata,
    });
  }

  return chunks;
}

/**
 * Clean text for embedding — remove excessive whitespace, normalize.
 */
function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .slice(0, MAX_CHUNK_TOKENS * CHARS_PER_TOKEN * 4); // Hard cap
}
