import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface KnowledgeSearchInput {
  query?: string;
  category?: string;
  limit?: number;
}

export class KnowledgeSearchHandler implements NativeCapabilityHandler {
  constructor(private readonly inMemoryDocs?: any[]) {}

  async execute(input: KnowledgeSearchInput, ctx: ExecutionContext): Promise<any> {
    const query = (input.query || '').toLowerCase();
    const limit = Math.min(input.limit || 5, 20);

    if (this.inMemoryDocs) {
      const documents = this.inMemoryDocs
        .filter((doc) => {
          if (!query) return true;
          return (
            doc.title?.toLowerCase().includes(query) ||
            doc.summary?.toLowerCase().includes(query) ||
            doc.id?.toLowerCase().includes(query)
          );
        })
        .slice(0, limit);

      return {
        documents,
        total: documents.length,
        verified: true,
      };
    }

    // Production handler: without an authoritative connector or injected test docs, fail closed
    return {
      documents: [],
      total: 0,
      verified: false,
    };
  }
}
