import { Injectable } from '@nestjs/common';
import { connectToDatabase } from '@journeyax/database';

export interface TradeKnowledgeConsultRequest {
  tenantId: string;
  topic: string;
  limit?: number;
}

export interface TradeKnowledgeResult {
  found: boolean;
  topic: string;
  concepts: Array<{
    id: string;
    name: string;
    type: string;
    description?: string;
    rules?: string[];
    targetCategories?: string[];
  }>;
  relevantFacts?: Array<{
    factKey: string;
    question: string;
    options?: Array<{ label: string; value: string }>;
  }>;
  tradeGuidance?: string[];
}

@Injectable()
export class TradeKnowledgeService {
  /**
   * Queries tenant-scoped OKF business knowledge, trade rules, and facts directly from MongoDB.
   */
  async consult(req: TradeKnowledgeConsultRequest): Promise<TradeKnowledgeResult> {
    const tenantId = (req.tenantId || '').toLowerCase().trim();
    const rawTopic = (req.topic || '').trim();
    if (!tenantId || !rawTopic) {
      return { found: false, topic: rawTopic, concepts: [], tradeGuidance: [] };
    }

    try {
      const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
      const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
      const { db } = await connectToDatabase(uri, dbName);

      const tokens = rawTopic
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2);

      const regexList = tokens.map((t) => new RegExp(t, 'i'));

      // 1. Search okf_concepts for matching nodes (matching name, conceptId, synonyms, customerPhrases, or description)
      const conceptFilter: any = {
        $or: [{ tenantId }, { projectId: tenantId }],
      };
      if (regexList.length > 0) {
        conceptFilter.$and = regexList.map((r) => ({
          $or: [
            { name: { $regex: r } },
            { conceptId: { $regex: r } },
            { description: { $regex: r } },
            { synonyms: { $elemMatch: { $regex: r } } },
            { customerPhrases: { $elemMatch: { $regex: r } } },
            { tags: { $elemMatch: { $regex: r } } },
          ],
        }));
      }

      const limit = Math.min(Math.max(Number(req.limit) || 6, 1), 12);
      const rawConceptDocs = await db.collection('okf_concepts').find(conceptFilter).limit(limit * 2).toArray();

      // Deduplicate concepts by conceptId / name
      const seenConceptKeys = new Set<string>();
      const conceptDocs: any[] = [];
      const extractedFactKeys = new Set<string>();

      for (const c of rawConceptDocs) {
        const key = c.conceptId || c.name;
        if (!seenConceptKeys.has(key)) {
          seenConceptKeys.add(key);
          conceptDocs.push(c);
          if (conceptDocs.length >= limit) break;
        }

        // Collect fact keys referenced by this concept
        if (Array.isArray(c.requiredFacts)) {
          for (const rf of c.requiredFacts) {
            if (rf.factKey) extractedFactKeys.add(rf.factKey);
          }
        }
        if (Array.isArray(c.discriminators)) {
          for (const d of c.discriminators) {
            if (d.factKey) extractedFactKeys.add(d.factKey);
          }
        }
      }

      // 2. Search okf_fact_definitions for relevant trade questions
      const factConditions: any[] = [];
      if (extractedFactKeys.size > 0) {
        factConditions.push({ factKey: { $in: Array.from(extractedFactKeys) } });
      }
      if (regexList.length > 0) {
        for (const r of regexList) {
          factConditions.push({ factKey: { $regex: r } }, { question: { $regex: r } });
        }
      }

      const factFilter: any = {
        $or: [{ tenantId }, { projectId: tenantId }],
      };
      if (factConditions.length > 0) {
        factFilter.$and = [{ $or: factConditions }];
      }

      const rawFactDocs = await db.collection('okf_fact_definitions').find(factFilter).limit(15).toArray();

      // Deduplicate facts by factKey
      const seenFactKeys = new Set<string>();
      const relevantFacts: Array<{ factKey: string; question: string; options?: Array<{ label: string; value: string }> }> = [];

      for (const fd of rawFactDocs) {
        if (!seenFactKeys.has(fd.factKey)) {
          seenFactKeys.add(fd.factKey);
          relevantFacts.push({
            factKey: fd.factKey,
            question: fd.question || fd.factKey,
            options: (fd.options || []).map((o: any) => ({
              label: o.label || o.value,
              value: o.value || o.label,
            })),
          });
        }
      }

      // 3. Search okf_drafts for rich authored rules, families, and project facts
      const draft = await db.collection('okf_drafts').findOne({
        $or: [{ tenantId }, { projectId: tenantId }],
      });

      const matchedRules: string[] = [];

      // Check draft families
      const families = draft?.families || draft?.content?.families;
      if (Array.isArray(families)) {
        for (const fam of families) {
          const matches = tokens.some((t) =>
            (fam.name || '').toLowerCase().includes(t) ||
            (fam.id || '').toLowerCase().includes(t) ||
            (fam.synonyms || []).some((s: string) => s.toLowerCase().includes(t))
          );
          if (matches) {
            if (fam.description) matchedRules.push(`${fam.name}: ${fam.description}`);
            if (fam.members?.length) matchedRules.push(`Application types: ${fam.members.join(', ')}`);
            if (fam.discriminator?.fact) {
              const matchedFact = (draft?.facts || draft?.content?.facts || []).find((f: any) => f.factKey === fam.discriminator.fact);
              if (matchedFact && !seenFactKeys.has(matchedFact.factKey)) {
                seenFactKeys.add(matchedFact.factKey);
                relevantFacts.push({
                  factKey: matchedFact.factKey,
                  question: matchedFact.question,
                  options: (matchedFact.options || []).map((o: any) => ({
                    label: o.label || o.value,
                    value: o.value || o.label,
                  })),
                });
              }
            }
          }
        }
      }

      // Check draft projects
      const projects = draft?.projects || draft?.content?.projects;
      if (Array.isArray(projects)) {
        for (const proj of projects) {
          const matches = tokens.some((t) =>
            (proj.name || '').toLowerCase().includes(t) ||
            (proj.id || '').toLowerCase().includes(t) ||
            (proj.phrases || []).some((p: string) => p.toLowerCase().includes(t))
          );
          if (matches) {
            if (proj.description) matchedRules.push(`Project overview: ${proj.description}`);
            if (proj.categories?.length) matchedRules.push(`Primary materials categories: ${proj.categories.join(', ')}`);
            for (const fItem of proj.facts || []) {
              const fKey = typeof fItem === 'string' ? fItem : fItem.fact;
              const matchedFact = (draft?.facts || draft?.content?.facts || []).find((f: any) => f.factKey === fKey);
              if (matchedFact && !seenFactKeys.has(matchedFact.factKey)) {
                seenFactKeys.add(matchedFact.factKey);
                relevantFacts.push({
                  factKey: matchedFact.factKey,
                  question: matchedFact.question,
                  options: (matchedFact.options || []).map((o: any) => ({
                    label: o.label || o.value,
                    value: o.value || o.label,
                  })),
                });
              }
            }
          }
        }
      }

      // Check draft problems / troubleshooting
      const problems = draft?.problems || draft?.content?.problems;
      if (Array.isArray(problems)) {
        for (const prob of problems) {
          const matches = tokens.some((t) =>
            (prob.name || '').toLowerCase().includes(t) ||
            (prob.id || '').toLowerCase().includes(t) ||
            (prob.phrases || []).some((p: string) => p.toLowerCase().includes(t))
          );
          if (matches) {
            matchedRules.push(`Diagnosis: ${prob.name} - ${prob.description}`);
            for (const fKey of prob.facts || []) {
              const matchedFact = (draft?.facts || draft?.content?.facts || []).find((f: any) => f.factKey === fKey);
              if (matchedFact && !seenFactKeys.has(matchedFact.factKey)) {
                seenFactKeys.add(matchedFact.factKey);
                relevantFacts.push({
                  factKey: matchedFact.factKey,
                  question: matchedFact.question,
                  options: (matchedFact.options || []).map((o: any) => ({
                    label: o.label || o.value,
                    value: o.value || o.label,
                  })),
                });
              }
            }
          }
        }
      }

      const formattedConcepts = conceptDocs.map((c: any) => ({
        id: c.conceptId || String(c._id),
        name: c.name || c.title || 'Concept',
        type: c.type || 'general',
        description: c.description || '',
        rules: Array.isArray(c.rules) ? c.rules.map((r: any) => typeof r === 'string' ? r : r.requirement || r.text) : [],
        targetCategories: Array.isArray(c.searchScope?.catalogCategoryIds)
          ? c.searchScope.catalogCategoryIds
          : Array.isArray(c.categories)
            ? c.categories
            : [],
      }));

      const isFound = formattedConcepts.length > 0 || relevantFacts.length > 0 || matchedRules.length > 0;

      return {
        found: isFound,
        topic: rawTopic,
        concepts: formattedConcepts,
        relevantFacts,
        tradeGuidance: matchedRules,
      };
    } catch (err: any) {
      console.warn(`[TradeKnowledgeService] MongoDB query warning for tenant "${tenantId}":`, err.message);
      return { found: false, topic: rawTopic, concepts: [], tradeGuidance: [] };
    }
  }
}
