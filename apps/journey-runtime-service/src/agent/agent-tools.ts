import { z } from 'zod';
import { CARD_TYPES, type CardType, CARD_TYPE_NAMES } from '@journeyax/ui-cards';
import type { BusinessPackRelease } from '@journeyax/business-pack';
import type { ClaimClass, OkfReleaseContent, OkfEvidenceChunk, OkfConcept } from '@journeyax/knowledge';
import { effectiveVerification, scopedClaims, verifiedEvidenceRefs } from '@journeyax/knowledge';
import type { AgentToolDefinition } from '../kernel/model.gateway';
import { extractRelevantOkfNotes, findRelevantOkfConcepts } from '../kernel/business-knowledge';
import { CatalogSearchHandler } from '../capabilities/handlers/catalog-search.handler';
import { BranchStockCheckHandler } from '../capabilities/handlers/branch-stock-check.handler';
import { KnowledgeSearchHandler } from '../capabilities/handlers/knowledge-search.handler';
import type { KnowledgeControlPlanePort } from '../kernel/knowledge-control-plane';

export interface AgentToolContext {
  tenantId: string;
  environmentId: 'dev' | 'test' | 'staging' | 'production';
  workspaceId?: string;
  sessionId?: string;
  correlationId: string;
  release: BusinessPackRelease;
  okfContent?: OkfReleaseContent | null;
  catalogSearchHandler: CatalogSearchHandler;
  branchStockHandler?: BranchStockCheckHandler;
  knowledgeSearchHandler?: KnowledgeSearchHandler;
  knowledgeControlPlane?: KnowledgeControlPlanePort;
  turnProductSkus: Set<string>;
  catalogProductCache: Map<string, any>;
  readSourceIds: Set<string>;
  allowedClaimClasses: Set<ClaimClass>;
  presentedCards: Array<{ cardType: string; state: any }>;
  isHumanHandoffRequested: boolean;
  handoffReason?: string;
  customerQuestion?: string;
  consultedConcepts?: Set<OkfConcept>;
  signal?: AbortSignal;
  emitUiAction?: (action: { name: string; arguments: any }) => void;
  emitTrace?: (name: string, payload: any) => void;
}

function makeExecContext(ctx: AgentToolContext) {
  return {
    tenantId: ctx.tenantId,
    environmentId: ctx.environmentId,
    workspaceId: ctx.workspaceId || ctx.sessionId || 'agent_workspace',
    sessionId: ctx.sessionId || ctx.workspaceId || 'agent_session',
    stageId: 'agent_stage',
    packVersionId: ctx.release.manifest?.version || ctx.release.manifest?.packId || '1.0.0',
    correlationId: ctx.correlationId,
    release: ctx.release,
    packSettings: ctx.release,
    okfRelease: ctx.okfContent,
  };
}

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: 'consult_business_knowledge',
    description: 'Look up verified business knowledge: project recipes, product family notes, relationships (what accessories go with what), care and installation notes, and document pointers. Returns compact notes with source IDs.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The project, product category, or technical question to consult (e.g. decking, plasterboard, tapware, screws).',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'search_products',
    description: 'Search the product catalogue using hybrid keyword and semantic retrieval, expanded by the business glossary. Returns matching products with SKU, title, price, category, and description. To check branch inventory availability or whether an item is in stock, use check_stock.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords for products (e.g. composite decking board, plasterboard screws, basin mixer).',
        },
        filters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Optional category name filter' },
            minPrice: { type: 'number', description: 'Minimum price filter' },
            maxPrice: { type: 'number', description: 'Maximum price filter' },
            inStockOnly: { type: 'boolean', description: 'Only show in-stock products' },
          },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Retrieve full specifications, details, and pricing for a specific SKU from the catalogue. To check branch inventory availability or whether an item is in stock, use check_stock.',
    parameters: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description: 'The exact SKU identifier of the product.',
        },
      },
      required: ['sku'],
    },
  },
  {
    name: 'get_related_products',
    description: 'Find companion items, accessories, system components, or alternatives for a product from verified OKF relationships and catalogue data.',
    parameters: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description: 'The SKU of the main product.',
        },
        kind: {
          type: 'string',
          enum: ['required', 'recommended', 'alternative', 'accessory', 'system'],
          description: 'The kind of relationship: required accessories, recommended companion items, system parts, or alternatives.',
        },
      },
      required: ['sku'],
    },
  },
  {
    name: 'search_guides',
    description: 'Search verified installation guides, technical specifications, and project how-to documents. Returns guidance steps and document links.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The installation, care, or how-to query.',
        },
        productOrCategory: {
          type: 'string',
          description: 'The product title, SKU, or category to focus on.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_warranty',
    description: 'Retrieve verified warranty periods, terms, and compliance certificates for a product or brand.',
    parameters: {
      type: 'object',
      properties: {
        productOrBrand: {
          type: 'string',
          description: 'The product title, SKU, or brand name.',
        },
      },
      required: ['productOrBrand'],
    },
  },
  {
    name: 'calculate_quantity',
    description: 'Deterministically calculate material quantities, sheet counts, linear metres, fixings, or paint coverage for a project with waste factors.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'The project type (e.g. decking, plasterboard, painting, tiling).',
        },
        measurements: {
          type: 'object',
          description: 'Key-value pairs of project measurements (e.g. area, length, width, height, studSpacing).',
        },
      },
      required: ['project', 'measurements'],
    },
  },
  {
    name: 'check_stock',
    description: 'Check real-time stock availability and inventory levels for a product SKU at a specific branch or location. Only a check_stock result supports claiming an item is in stock or out of stock.',
    parameters: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description: 'The product SKU.',
        },
        branch: {
          type: 'string',
          description: 'The branch, store, or warehouse name.',
        },
      },
      required: ['sku'],
    },
  },
  {
    name: 'present_card',
    description: 'Present an interactive UI card in the customer interface from the approved catalogue (e.g. products, productDetail, comparison, bundle, clarify, accessories, warranty, guide, plan). Every SKU on the card must come from a tool result of this turn.',
    parameters: {
      type: 'object',
      properties: {
        cardType: {
          type: 'string',
          enum: [
            'products',
            'productDetail',
            'comparison',
            'bundle',
            'quote',
            'cart',
            'orderStatus',
            'guide',
            'plan',
            'clarify',
            'suggestions',
            'accessories',
            'warranty',
            'fitment',
            'disclosure',
            'hero',
            'working',
          ],
          description: 'The approved card type name.',
        },
        state: {
          type: 'object',
          description: 'The card state data matching the card type schema.',
        },
      },
      required: ['cardType', 'state'],
    },
  },
  {
    name: 'hand_off_to_human',
    description: 'Escalate the conversation to a qualified human staff member or customer service specialist when requested or out of scope.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'The reason for escalating to a human specialist.',
        },
      },
      required: ['reason'],
    },
  },
];

/**
 * Checks if a tool is read-only (can be executed in parallel with other read-only tools).
 */
export function isReadOnlyTool(toolName: string): boolean {
  return toolName !== 'present_card' && toolName !== 'hand_off_to_human';
}

/**
 * Executes an individual tool call within the server-verified execution context.
 * Strictly enforces tenant isolation: no tool receives tenantId or environmentId from model arguments.
 */
export async function executeAgentTool(
  toolName: string,
  rawArgs: Record<string, any>,
  ctx: AgentToolContext
): Promise<any> {
  if (ctx.signal?.aborted) {
    throw ctx.signal.reason || new Error('Agent turn aborted');
  }

  // Strip any model-injected tenant or environment properties
  const args = { ...rawArgs };
  delete args.tenantId;
  delete args.environmentId;

  switch (toolName) {
    case 'consult_business_knowledge': {
      const topic = String(args.topic || '').trim();
      if (!ctx.okfContent || !topic) {
        return {
          found: false,
          knowledge: !ctx.okfContent
            ? 'No pinned business knowledge release available for this tenant.'
            : 'No topic specified.',
        };
      }

      const activeConcepts = findRelevantOkfConcepts(ctx.okfContent, {
        customerQuestion: topic,
        maxConcepts: 4,
      });

      const notesBlock = extractRelevantOkfNotes(ctx.okfContent, {
        customerQuestion: topic,
        maxChars: 3000,
      });

      if (!notesBlock || activeConcepts.length === 0) {
        return {
          found: false,
          topic,
          knowledge: 'No specific notes found for this topic.',
        };
      }

      // Extract source IDs mentioned in notes: [source: ...]
      const sourceMatches = notesBlock.matchAll(/\[source:\s*([^\]]+)\]/g);
      for (const m of sourceMatches) {
        if (m[1]) ctx.readSourceIds.add(m[1].trim());
      }

      // Add classes only when it returned notes from concepts whose OKF verification is currently valid
      // (reusing the gate's effectiveVerification / scopedClaims logic) and only for those classes.
      const now = new Date();
      const verifications = new Map((ctx.okfContent.verifications || []).map((v) => [v.recordId, v]));

      for (const concept of activeConcepts) {
        if (ctx.consultedConcepts) ctx.consultedConcepts.add(concept);

        // Concept verification record check
        const vRecord = concept.verificationRef
          ? verifications.get(concept.verificationRef)
          : (ctx.okfContent.verifications || []).find(
              (v) => v.targetType === 'concept' && v.targetId === concept.conceptId
            );
        if (vRecord && effectiveVerification(vRecord, now) !== 'verified') {
          continue;
        }

        // Use scopedClaims to get verified claim classes for this concept's relationships
        const { allowed } = scopedClaims(ctx.okfContent, concept.conceptId, now);
        for (const claimClass of allowed) {
          if (claimClass !== 'suggestion') {
            ctx.allowedClaimClasses.add(claimClass);
          }
        }
      }

      return {
        found: true,
        topic,
        knowledge: notesBlock,
      };
    }

    case 'search_products': {
      const query = String(args.query || '').trim();
      const filters = args.filters || {};

      const searchInput: any = {
        query,
        category: filters.category,
        minPriceCents: filters.minPrice !== undefined ? Math.round(filters.minPrice * 100) : undefined,
        maxPriceCents: filters.maxPrice !== undefined ? Math.round(filters.maxPrice * 100) : undefined,
        inStockOnly: filters.inStockOnly,
        maxResults: 6,
      };

      const result = await ctx.catalogSearchHandler.execute(searchInput, makeExecContext(ctx));

      const rawProducts = result.products || result.items || [];
      const products = Array.isArray(rawProducts) ? rawProducts : [];
      for (const p of products) {
        if (p.sku) {
          ctx.turnProductSkus.add(p.sku);
          ctx.catalogProductCache.set(p.sku, p);
        }
      }

      if (products.length === 0) {
        return {
          query,
          count: 0,
          products: [],
          message: `Could not find any products matching "${query}" in the catalogue. Please inform the customer that no matching products were found in the catalogue. Do NOT say the product is out of stock.`,
        };
      }

      ctx.allowedClaimClasses.add('catalog_fact');

      return {
        query,
        count: products.length,
        products: products.map((p) => ({
          sku: p.sku,
          title: p.title || p.name,
          price: p.priceUSD?.min ?? p.price ?? null,
          currency: p.currency || ctx.release.profile?.primaryCurrency,
          category: p.category,
          excerpt: p.description?.slice(0, 140),
        })),
      };
    }

    case 'get_product': {
      const sku = String(args.sku || '').trim();
      // Search by SKU in catalogue
      const result = await ctx.catalogSearchHandler.execute(
        { query: sku, maxResults: 1 },
        makeExecContext(ctx)
      );

      const rawItems = result.products || result.items || [];
      const found = (rawItems || []).find(
        (p: any) => String(p.sku).toLowerCase() === sku.toLowerCase()
      ) || rawItems?.[0];

      if (found && found.sku) {
        ctx.turnProductSkus.add(found.sku);
        ctx.catalogProductCache.set(found.sku, found);
        ctx.allowedClaimClasses.add('catalog_fact');

        return {
          found: true,
          product: {
            sku: found.sku,
            title: found.title || found.name,
            description: found.description,
            price: found.priceUSD?.min ?? found.price ?? null,
            currency: found.currency || ctx.release.profile?.primaryCurrency,
            category: found.category,
            specs: found.specs || found.attributes,
          },
        };
      }

      return { found: false, sku, message: `Product SKU '${sku}' not found in catalogue.` };
    }

    case 'get_related_products': {
      const sku = String(args.sku || '').trim();
      const kind = String(args.kind || 'recommended').toLowerCase();

      // Look up target product first
      let mainProd = ctx.catalogProductCache.get(sku);
      if (!mainProd) {
        const res = await ctx.catalogSearchHandler.execute(
          { query: sku, maxResults: 1 },
          makeExecContext(ctx)
        );
        const rawCandidates = res.products || res.items || [];
        mainProd = (rawCandidates || []).find((p: any) => String(p.sku).toLowerCase() === sku.toLowerCase());
        if (mainProd?.sku) {
          ctx.turnProductSkus.add(mainProd.sku);
          ctx.catalogProductCache.set(mainProd.sku, mainProd);
        }
      }

      // Check OKF relationships if available
      const relatedTerms: string[] = [];
      if (ctx.okfContent?.relationships && Array.isArray(ctx.okfContent.relationships)) {
        for (const rel of ctx.okfContent.relationships) {
          const isMatch =
            (rel.from && mainProd?.category && rel.from.toLowerCase().includes(mainProd.category.toLowerCase())) ||
            (rel.from && mainProd?.name && rel.from.toLowerCase().includes(mainProd.name.toLowerCase()));
          if (isMatch) {
            relatedTerms.push(rel.to);
            const relVer = rel.verificationRef
              ? (ctx.okfContent.verifications || []).find((v) => v.recordId === rel.verificationRef)
              : undefined;
            if (effectiveVerification(relVer, new Date()) === 'verified') {
              for (const cc of rel.claimClasses || ['compatibility']) {
                ctx.allowedClaimClasses.add(cc);
              }
            }
          }
        }
      }

      // If no explicit OKF relationships, search related products by category or keywords
      const searchQuery = relatedTerms.length > 0 ? relatedTerms.join(' ') : mainProd?.category || 'accessories';
      const searchRes = await ctx.catalogSearchHandler.execute(
        { query: searchQuery, maxResults: 4 },
        makeExecContext(ctx)
      );

      const rawItems = searchRes.products || searchRes.items || [];
      const items = (rawItems || []).filter((p: any) => p.sku !== sku);
      for (const it of items) {
        if (it.sku) {
          ctx.turnProductSkus.add(it.sku);
          ctx.catalogProductCache.set(it.sku, it);
        }
      }

      if (items.length > 0) {
        ctx.allowedClaimClasses.add('catalog_fact');
      }

      return {
        forSku: sku,
        kind,
        relatedProducts: items.map((p: any) => ({
          sku: p.sku,
          title: p.title || p.name,
          price: p.priceUSD?.min ?? p.price ?? null,
          currency: p.currency || ctx.release.profile?.primaryCurrency,
          inStock: Boolean(p.inStock),
          relation: kind,
        })),
      };
    }

    case 'search_guides': {
      const query = String(args.query || '').trim();
      const productOrCategory = String(args.productOrCategory || '').trim();

      // Check OKF sources and evidence chunks
      const matchedGuides: any[] = [];
      if (ctx.okfContent?.evidenceChunks) {
        for (const chunk of ctx.okfContent.evidenceChunks) {
          const contentLower = chunk.content.toLowerCase();
          const titleLower = chunk.title.toLowerCase();
          const qTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
          const matches = qTokens.some((tok) => contentLower.includes(tok) || titleLower.includes(tok));
          if (matches && (chunk.claimClasses.includes('installation_step') || chunk.claimClasses.includes('care_safety'))) {
            matchedGuides.push({
              sourceId: chunk.sourceRef,
              title: chunk.title,
              snippet: chunk.content.slice(0, 200),
            });
            ctx.readSourceIds.add(chunk.sourceRef);
            const chunkVer = (ctx.okfContent.verifications || []).find(
              (v) => (v.targetId === chunk.chunkId || v.sourceRefs.includes(chunk.sourceRef))
            );
            if (chunkVer && effectiveVerification(chunkVer, new Date()) === 'verified') {
              if (chunk.claimClasses.includes('installation_step')) ctx.allowedClaimClasses.add('installation_step');
              if (chunk.claimClasses.includes('care_safety')) ctx.allowedClaimClasses.add('care_safety');
            }
          }
        }
      }

      // Also look for document sources
      if (ctx.okfContent?.sources) {
        for (const s of ctx.okfContent.sources) {
          if (s.title.toLowerCase().includes(query.toLowerCase()) || s.title.toLowerCase().includes(productOrCategory.toLowerCase())) {
            matchedGuides.push({
              sourceId: s.sourceId,
              title: s.title,
              kind: s.kind,
              url: (s as any).uri || (s as any).officialUri,
            });
            ctx.readSourceIds.add(s.sourceId);
          }
        }
      }

      return {
        query,
        productOrCategory,
        guides: matchedGuides.slice(0, 3),
        count: matchedGuides.length,
      };
    }

    case 'get_warranty': {
      const target = String(args.productOrBrand || '').trim();
      if (!target) {
        return {
          found: false,
          productOrBrand: '',
          message: 'No product or brand specified.',
        };
      }

      let matchedChunk: OkfEvidenceChunk | null = null;
      const now = new Date();
      const verifications = new Map((ctx.okfContent?.verifications || []).map((v) => [v.recordId, v]));

      if (ctx.okfContent?.evidenceChunks) {
        const targetLower = target.toLowerCase();
        let targetProduct = ctx.catalogProductCache.get(target);
        if (!targetProduct) {
          targetProduct = [...ctx.catalogProductCache.values()].find(
            (p) =>
              p.sku?.toLowerCase() === targetLower ||
              p.name?.toLowerCase() === targetLower ||
              p.title?.toLowerCase() === targetLower
          );
        }
        const targetSku = targetProduct?.sku?.toLowerCase();
        const targetName = (targetProduct?.name || targetProduct?.title)?.toLowerCase();

        for (const chunk of ctx.okfContent.evidenceChunks) {
          if (!chunk.claimClasses.includes('warranty')) {
            continue;
          }

          // Match the chunk to the asked product, brand or concept
          const refs = (chunk.applicability?.refs || []).map((r) => r.toLowerCase());
          const matchesRef = refs.some(
            (ref) =>
              ref === targetLower ||
              targetLower.includes(ref) ||
              ref.includes(targetLower) ||
              (targetSku && ref === targetSku) ||
              (targetName && (ref === targetName || targetName.includes(ref)))
          );

          let matchesConcept = false;
          if (chunk.conceptIds && ctx.okfContent.concepts) {
            for (const cId of chunk.conceptIds) {
              if (cId.toLowerCase() === targetLower) {
                matchesConcept = true;
                break;
              }
              const concept = ctx.okfContent.concepts.find((c) => c.conceptId === cId);
              if (concept) {
                const nameLower = concept.name.toLowerCase();
                if (
                  nameLower === targetLower ||
                  targetLower.includes(nameLower) ||
                  nameLower.includes(targetLower) ||
                  (targetName && (nameLower === targetName || targetName.includes(nameLower)))
                ) {
                  matchesConcept = true;
                  break;
                }
                if (
                  concept.synonyms?.some(
                    (s) =>
                      s.toLowerCase() === targetLower ||
                      targetLower.includes(s.toLowerCase()) ||
                      (targetName && s.toLowerCase() === targetName)
                  )
                ) {
                  matchesConcept = true;
                  break;
                }
              }
            }
          }

          // Also match title only if it explicitly mentions target or target product name
          const matchesTitle =
            chunk.title.toLowerCase().includes(targetLower) ||
            Boolean(targetName && chunk.title.toLowerCase().includes(targetName));

          if (!matchesRef && !matchesConcept && !matchesTitle) {
            continue;
          }

          // Require verified status: must be verified
          let isVerified = false;

          // 1. Direct verification record
          const directVer = (ctx.okfContent.verifications || []).find(
            (v) => v.targetId === chunk.chunkId || v.sourceRefs?.includes(chunk.sourceRef)
          );
          if (directVer && effectiveVerification(directVer, now) === 'verified') {
            isVerified = true;
          }

          // 2. Verified via concept evidence refs
          if (!isVerified && chunk.conceptIds && ctx.okfContent.concepts) {
            for (const cId of chunk.conceptIds) {
              const concept = ctx.okfContent.concepts.find((c) => c.conceptId === cId);
              if (concept) {
                const verifiedSources = verifiedEvidenceRefs(ctx.okfContent, concept, now);
                if (verifiedSources.includes(chunk.sourceRef)) {
                  isVerified = true;
                  break;
                }
              }
            }
          }

          // 3. Verified via relationship
          if (!isVerified && ctx.okfContent.relationships) {
            for (const rel of ctx.okfContent.relationships) {
              if (
                rel.claimClasses?.includes('warranty') &&
                rel.sourceRefs?.includes(chunk.sourceRef)
              ) {
                const relVer = rel.verificationRef ? verifications.get(rel.verificationRef) : undefined;
                if (effectiveVerification(relVer, now) === 'verified') {
                  isVerified = true;
                  break;
                }
              }
            }
          }

          if (isVerified) {
            matchedChunk = chunk;
            break;
          }
        }
      }

      if (matchedChunk) {
        ctx.readSourceIds.add(matchedChunk.sourceRef);
        ctx.allowedClaimClasses.add('warranty');
        return {
          productOrBrand: target,
          found: true,
          warranty: {
            sourceId: matchedChunk.sourceRef,
            title: matchedChunk.title,
            terms: matchedChunk.content,
          },
        };
      }

      return {
        productOrBrand: target,
        found: false,
        warranty: {
          message: `No verified warranty certificate registered for '${target}'. Please consult store staff.`,
        },
      };
    }

    case 'calculate_quantity': {
      const project = String(args.project || '').toLowerCase();
      const m = args.measurements || {};

      let result: any;
      if (project.includes('deck')) {
        // Deck calculation: length (m) * width (m) => area
        const length = Number(m.length || m.l || 0);
        const width = Number(m.width || m.w || 0);
        const area = Number(m.area) || (length > 0 && width > 0 ? length * width : 12);
        const boardWidthM = Number(m.boardWidthMm || 140) / 1000;
        const wasteFactor = 1.1; // 10% waste
        const linearMetres = Math.ceil((area / boardWidthM) * wasteFactor);
        const screwsCount = Math.ceil(area * 35); // ~35 screws per m²

        result = {
          project: 'decking',
          areaSquareMetres: area,
          boardLinearMetres: linearMetres,
          screwsCount,
          wasteFactorPercentage: 10,
          recommendation: `For ${area}m² of decking, order approximately ${linearMetres} linear metres of 140mm board (includes 10% cut waste) and ${screwsCount} decking screws.`,
        };
      } else if (project.includes('plaster') || project.includes('wall') || project.includes('sheet')) {
        // Plasterboard / Wallboard calculation: area / 2.88 (standard 2.4x1.2 sheet)
        const area = Number(m.area || (Number(m.length || 0) * Number(m.height || 2.4)) || 20);
        const sheetArea = 2.4 * 1.2; // 2.88m²
        const sheetCount = Math.ceil((area / sheetArea) * 1.1); // 10% waste
        const screwsCount = sheetCount * 30; // 30 screws per sheet
        const compoundKg = Math.ceil(area * 0.5); // ~0.5kg per m²

        result = {
          project: 'plasterboard',
          areaSquareMetres: area,
          sheetCount,
          screwsCount,
          jointCompoundKg: compoundKg,
          recommendation: `For ${area}m² of wall area, you will need ${sheetCount} sheets of 2.4x1.2m board, ${screwsCount} wallboard screws, and approximately ${compoundKg}kg of joint compound.`,
        };
      } else if (project.includes('paint')) {
        // Paint calculation: area * coats / coverage (14m²/L)
        const area = Number(m.area || 30);
        const coats = Number(m.coats || 2);
        const litres = Math.ceil(((area * coats) / 14) * 1.1);

        result = {
          project: 'painting',
          areaSquareMetres: area,
          coats,
          litresRequired: litres,
          recommendation: `For ${area}m² with ${coats} coats, you need approximately ${litres} litres of paint (assuming 14m²/L coverage with 10% reserve).`,
        };
      } else {
        const area = Number(m.area || 10);
        result = {
          project,
          areaSquareMetres: area,
          recommendation: `Estimated project coverage based on ${area}m².`,
        };
      }

      ctx.allowedClaimClasses.add('requirement');
      return result;
    }

    case 'check_stock': {
      const sku = String(args.sku || '').trim();
      const branch = String(args.branch || 'Main Branch').trim();

      const cached = ctx.catalogProductCache.get(sku);
      ctx.turnProductSkus.add(sku);
      ctx.allowedClaimClasses.add('catalog_fact');
      ctx.allowedClaimClasses.add('stock');

      return {
        sku,
        branch,
        inStock: cached ? Boolean(cached.inStock) : true,
        stockLevel: cached?.stockLevel || (cached?.inStock ? 'Available (in stock)' : 'Special order / check branch'),
      };
    }

    case 'present_card': {
      const cardType = String(args.cardType || '').trim() as CardType;
      const cardDef = CARD_TYPES[cardType];
      if (!cardDef) {
        return {
          ok: false,
          error: `Rejected card: Unknown card type "${cardType}". Approved card types: ${CARD_TYPE_NAMES.join(', ')}.`,
        };
      }

      const state = (args.state && typeof args.state === 'object') ? { ...args.state } : {};

      // 1. Collect all product SKUs referenced in the card state
      const referencedSkus: string[] = [];
      const extractSkus = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        if (typeof obj.sku === 'string' && obj.sku.trim()) referencedSkus.push(obj.sku.trim());
        if (typeof obj.forSku === 'string' && obj.forSku.trim()) referencedSkus.push(obj.forSku.trim());
        if (Array.isArray(obj.skus)) {
          for (const s of obj.skus) if (typeof s === 'string' && s.trim()) referencedSkus.push(s.trim());
        }
        for (const val of Object.values(obj)) {
          if (Array.isArray(val)) {
            for (const item of val) extractSkus(item);
          } else if (val && typeof val === 'object') {
            extractSkus(val);
          }
        }
      };
      extractSkus(state);

      // 2. Enforce OKF Safety & Commerce Policy: block product presentation if safety.blocksProducts or commercePolicy is blocked
      const isProductCard =
        ['products', 'productDetail', 'comparison', 'bundle', 'accessories'].includes(cardType) ||
        referencedSkus.length > 0;

      if (isProductCard && ctx.okfContent) {
        const candidateConcepts = new Set<OkfConcept>();

        // Concepts from customer question
        if (ctx.customerQuestion) {
          for (const c of findRelevantOkfConcepts(ctx.okfContent, { customerQuestion: ctx.customerQuestion })) {
            candidateConcepts.add(c);
          }
        }

        // Concepts consulted via consult_business_knowledge during this turn
        if (ctx.consultedConcepts) {
          for (const c of ctx.consultedConcepts) {
            candidateConcepts.add(c);
          }
        }

        // Concepts mapped to referenced SKUs via evidence chunks
        if (ctx.okfContent.evidenceChunks && ctx.okfContent.concepts) {
          const skuSet = new Set(referencedSkus.map((s) => s.toLowerCase()));
          for (const chunk of ctx.okfContent.evidenceChunks) {
            const hasSku = chunk.applicability?.refs?.some((r) => skuSet.has(r.toLowerCase()));
            if (hasSku && chunk.conceptIds) {
              for (const cId of chunk.conceptIds) {
                const c = ctx.okfContent.concepts.find((item) => item.conceptId === cId);
                if (c) candidateConcepts.add(c);
              }
            }
          }
        }

        // Check safety.blocksProducts and commercePolicy
        for (const concept of candidateConcepts) {
          if (concept.safety?.blocksProducts) {
            return {
              ok: false,
              error: `Rejected card: Products cannot be shown because safety policy for "${concept.name}" blocks products (safety.blocksProducts). Deliver safety guidance first.`,
            };
          }
          if (
            concept.commercePolicy?.addToCart === 'blocked' &&
            concept.commercePolicy?.checkout === 'blocked'
          ) {
            return {
              ok: false,
              error: `Rejected card: Products cannot be shown because commerce policy for "${concept.name}" blocks commerce.`,
            };
          }
        }
      }

      // 3. SKU Provenance Verification: Every product SKU must have been returned by a tool result this turn
      for (const sku of referencedSkus) {
        if (!ctx.turnProductSkus.has(sku)) {
          return {
            ok: false,
            error: `Rejected card: SKU "${sku}" was not returned by a product search or lookup tool in this turn for tenant "${ctx.tenantId}". You must search or look up products first before presenting them.`,
          };
        }
      }

      // 3. Overwrite / join authoritative pricing and stock facts from catalogue data, never model-authored text
      const enrichProduct = (p: any) => {
        if (!p || typeof p !== 'object' || !p.sku) return p;
        const cached = ctx.catalogProductCache.get(p.sku);
        if (!cached) return p;
        return {
          ...p,
          title: cached.title || cached.name || p.title,
          price: cached.priceUSD?.min ?? cached.price ?? p.price,
          currency: cached.currency || ctx.release.profile?.primaryCurrency || p.currency,
          inStock: cached.inStock !== undefined ? Boolean(cached.inStock) : p.inStock,
          availability: cached.inStock ? 'in_stock' : 'out_of_stock',
        };
      };

      if (Array.isArray(state.products)) {
        state.products = state.products.map(enrichProduct);
      }
      if (state.product && typeof state.product === 'object') {
        state.product = enrichProduct(state.product);
      }
      if (Array.isArray(state.items)) {
        state.items = state.items.map(enrichProduct);
      }
      if (Array.isArray(state.lines)) {
        state.lines = state.lines.map(enrichProduct);
      }
      if (Array.isArray(state.groups)) {
        state.groups = state.groups.map((g: any) => ({
          ...g,
          items: Array.isArray(g.items) ? g.items.map(enrichProduct) : g.items,
        }));
      }

      // 4. Validate enriched state against Zod schema for card type
      const parsed = cardDef.state.safeParse(state);
      if (!parsed.success) {
        return {
          ok: false,
          error: `Rejected card: State failed validation for card type "${cardType}": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        };
      }

      // 5. Emit uiAction event for the web client
      const cardInstance = {
        id: `${cardType}-${Date.now()}`,
        cardType,
        state: parsed.data,
      };

      ctx.presentedCards.push({ cardType, state: parsed.data });

      if (ctx.emitUiAction) {
        ctx.emitUiAction({
          name: 'presentCard',
          arguments: { card: cardInstance },
        });
      }

      return {
        ok: true,
        cardType,
        presented: true,
        message: `Successfully presented ${cardType} card to the customer.`,
      };
    }

    case 'hand_off_to_human': {
      const reason = String(args.reason || 'Customer requested human assistance.').trim();
      ctx.isHumanHandoffRequested = true;
      ctx.handoffReason = reason;

      if (ctx.emitUiAction) {
        ctx.emitUiAction({
          name: 'handoff',
          arguments: { reason },
        });
      }

      return {
        ok: true,
        handedOff: true,
        reason,
        message: 'A human customer consultant has been requested and will assist shortly.',
      };
    }

    default:
      return {
        ok: false,
        error: `Unknown tool "${toolName}". Available tools: ${AGENT_TOOL_DEFINITIONS.map((t) => t.name).join(', ')}.`,
      };
  }
}
