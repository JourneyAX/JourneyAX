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

    const defaultDocuments = [
      {
        id: 'DOC-STD-101',
        title: 'Technical Standards Compliance Document',
        summary: 'Specifies acceptable solutions and lining performance standards for project installations.',
        source: 'Standards Technical Documentation',
        verified: true,
      },
      {
        id: 'DOC-APP-202',
        title: 'Technical Appraisal: Specification & Systems Guide',
        summary: 'Technical guidance for substrate preparation, performance standards, and compliance.',
        source: 'Appraisal Technical Documentation',
        verified: true,
      },
      {
        id: 'DOC-SPEC-303',
        title: 'Certified Fastener & Materials Specification Guide',
        summary: 'Engineering span tables, spacing calculations, and certified component specifications.',
        source: 'Standards Documentation',
        verified: true,
      },
    ];

    const pool = this.inMemoryDocs || defaultDocuments;
    const documents = pool
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
      documents: documents.length > 0 ? documents : defaultDocuments.slice(0, limit),
      total: documents.length > 0 ? documents.length : defaultDocuments.length,
      verified: true,
    };
  }
}
