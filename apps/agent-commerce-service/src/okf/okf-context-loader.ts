import fs from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { connectToDatabase } from '@journeyax/database';

export interface OkfConceptContext {
  id: string;
  name: string;
  description: string;
  markdown: string;
  categories: string[];
}

/**
 * OkfContextLoader
 *
 * Implements Google's OKF pattern:
 * Loads curated trade and business knowledge (concepts, relationships,
 * building code rules, and safety boundaries) as clean Markdown context
 * to be provided directly to the LLM Agent.
 */
@Injectable()
export class OkfContextLoader {
  private fileCache: Map<string, any> = new Map();

  /**
   * Resolves the authoring JSON from MongoDB okf_drafts or local files for a tenant.
   */
  private async loadTenantAuthoring(tenantId: string): Promise<any> {
    const cached = this.fileCache.get(tenantId);
    if (cached) return cached;

    try {
      const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
      const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
      const { db } = await connectToDatabase(uri, dbName);
      const doc = await db.collection('okf_drafts').findOne({
        $or: [{ tenantId }, { projectId: tenantId }],
      });
      if (doc) {
        const payload = doc.content || doc;
        this.fileCache.set(tenantId, payload);
        return payload;
      }
    } catch (err: any) {
      // Fallback below
    }

    const authoringPath = path.resolve(
      __dirname,
      '../../../../scripts/okf/tenants',
      `${tenantId}.authoring.json`
    );

    if (fs.existsSync(authoringPath)) {
      try {
        const raw = fs.readFileSync(authoringPath, 'utf8');
        const parsed = JSON.parse(raw);
        this.fileCache.set(tenantId, parsed);
        return parsed;
      } catch (err) {
        console.error(`[OkfContextLoader] Failed to parse authoring file at ${authoringPath}:`, err);
      }
    }
    return null;
  }

  /**
   * Retrieves relevant OKF business context matching the customer's query or session.
   * Formats the result as clean Markdown suitable for the LLM system prompt.
   */
  async getBusinessContext(tenantId: string, userMessage: string): Promise<string> {
    const authoring = await this.loadTenantAuthoring(tenantId);
    if (!authoring) return '';

    const lowerQuery = (userMessage || '').toLowerCase();
    const queryTokens = lowerQuery.split(/\s+/).filter((t) => t.length > 2);

    const relevantSections: string[] = [];

    // 1. Matched Projects
    if (Array.isArray(authoring.projects)) {
      for (const project of authoring.projects) {
        const phrases = project.phrases || [];
        const isMatched =
          phrases.some((p: string) => lowerQuery.includes(p.toLowerCase())) ||
          queryTokens.some((t) => (project.name || '').toLowerCase().includes(t) || (project.id || '').toLowerCase().includes(t));

        if (isMatched) {
          relevantSections.push(
            `### Project Guide: ${project.name}\n` +
            `- **Description**: ${project.description}\n` +
            `- **Key Considerations**: ${(project.facts || []).map((f: any) => `${typeof f === 'string' ? f : f.fact} (${f.importance || 'standard'})`).join(', ')}\n` +
            `- **Relevant Product Categories**: ${(project.categories || []).join(', ')}`
          );
        }
      }
    }

    // 2. Matched Product Families
    if (Array.isArray(authoring.families)) {
      for (const family of authoring.families) {
        const triggers = [...(family.phrases || []), ...(family.synonyms || []), family.name, family.id].filter(Boolean);
        const isMatched = triggers.some((trig: string) => lowerQuery.includes(trig.toLowerCase()));

        if (isMatched) {
          let desc = `### Product Family: ${family.name}\n- **Description**: ${family.description}\n`;
          if (family.discriminator) {
            desc += `- **Substrate / Choice Distinction**: Fixings depend on '${family.discriminator.fact}'. Options: ${JSON.stringify(family.discriminator.valueMap)}\n`;
          }
          if (family.members) {
            desc += `- **Member Categories**: ${family.members.join(', ')}\n`;
          }
          relevantSections.push(desc);
        }
      }
    }

    // 3. Matched Diagnostic Problems & Safety Hazards
    if (Array.isArray(authoring.problems)) {
      for (const problem of authoring.problems) {
        const triggers = [...(problem.phrases || []), ...(problem.synonyms || []), problem.name, problem.id].filter(Boolean);
        const isMatched = triggers.some((trig: string) => lowerQuery.includes(trig.toLowerCase()));

        if (isMatched) {
          relevantSections.push(
            `### Diagnostic & Safety Topic: ${problem.name}\n` +
            `- **Overview**: ${problem.description}\n` +
            `- **Diagnostics Needed**: ${(problem.facts || []).join(', ')}\n` +
            `- **Trade Safety Advice**: For severe leaks behind walls or structural hazards, advise consulting a registered trade professional. Never advise DIY work on structural elements, gas lines, or mains plumbing/power without licensed oversight.`
          );
        }
      }
    }

    // 4. Overlays & Compliance Rules
    if (Array.isArray(authoring.overlays)) {
      for (const overlay of authoring.overlays) {
        if (relevantSections.length > 0) {
          relevantSections.push(
            `### Trade Rule: ${overlay.id}\n- ${overlay.reason}`
          );
        }
      }
    }

    if (relevantSections.length === 0) {
      return '';
    }

    return (
      `## Google Open Knowledge Format (OKF) Business Context:\n` +
      `The following verified trade knowledge and product domain information applies to this merchant:\n\n` +
      relevantSections.join('\n\n')
    );
  }
}
