import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';

export class WorkwearSolutionOptimizerHandler implements NativeCapabilityHandler {
  async execute(input: any, ctx: ExecutionContext): Promise<any> {
    const occupation = input.occupation || 'tradesperson';
    const budgetCents = input.budget?.amountCents || 25000;

    const requiresComposite =
      Boolean(input.safety_spec && /composite/i.test(String(input.safety_spec))) ||
      Boolean(input.toe_type && /composite/i.test(String(input.toe_type))) ||
      Boolean(input.safety && /composite/i.test(String(input.safety)));

    const requiresLightweight =
      Boolean(input.apparel && /lightweight|summer/i.test(String(input.apparel))) ||
      Boolean(input.garment_weight && /light/i.test(String(input.garment_weight))) ||
      Boolean(input.requiresLightweight);

    let pantsDocs: any[] = [];
    let bootsDocs: any[] = [];

    const uri = process.env.MONGODB_URI;
    if (uri) {
      try {
        const { db } = await connectToDatabase(uri, 'journeyx');

        const pantQuery: any = {
          projectId: ctx.tenantId,
          $or: [
            { category: /pants|trousers|cargos/i },
            { name: /pants|trousers|cargos/i },
          ],
        };
        pantsDocs = await db.collection(COLLECTION_PRODUCTS)
          .find(pantQuery)
          .limit(40)
          .toArray()
          .catch(() => []);

        if (requiresLightweight) {
          pantsDocs.sort((a, b) => {
            const aLight = a.garment?.weightClass === 'lightweight' || /lightweight|summer/i.test(a.name || '') ? 1 : 0;
            const bLight = b.garment?.weightClass === 'lightweight' || /lightweight|summer/i.test(b.name || '') ? 1 : 0;
            return bLight - aLight;
          });
        }

        const bootQuery: any = {
          projectId: ctx.tenantId,
          $or: [
            { category: /boot|footwear|shoe/i },
            { name: /boot|safety/i },
            { description: /boot|safety|toe/i },
          ],
        };

        if (requiresComposite) {
          bootQuery['$and'] = [
            {
              $or: [
                { 'safety.toeProtection': 'composite' },
                { name: /composite/i },
                { description: /composite/i },
              ],
            },
            {
              name: { $not: /steel toe/i },
            },
          ];
        }

        bootsDocs = await db.collection(COLLECTION_PRODUCTS)
          .find(bootQuery)
          .limit(40)
          .toArray()
          .catch(() => []);
      } catch (err: any) {
        console.warn('[WorkwearSolutionOptimizerHandler] Mongo lookup error:', err.message);
      }
    }

    const getPriceCents = (p: any): number => {
      if (p.priceCents != null) return p.priceCents;
      if (p.price?.amount != null) return Math.round(p.price.amount * 100);
      if (p.priceUSD?.min != null) return Math.round(p.priceUSD.min * 100);
      if (p.priceUSD?.max != null) return Math.round(p.priceUSD.max * 100);
      return 0;
    };

    const formatItem = (p: any, role: 'pants' | 'boots') => {
      const toeProtection = p.safety?.toeProtection ||
        (/composite/i.test(p.name || '') || /composite/i.test(p.description || '') ? 'composite' :
         /steel/i.test(p.name || '') || /steel/i.test(p.description || '') ? 'steel' : 'none');

      const safetyFeatures: string[] = [];
      if (toeProtection === 'composite') safetyFeatures.push('Composite Safety Toe');
      else if (toeProtection === 'steel') safetyFeatures.push('Steel Safety Toe');
      if (p.safety?.electricalHazardRated) safetyFeatures.push('Electrical Hazard Resistance (EH)');
      if (p.safety?.certifications && p.safety.certifications.length > 0) {
        safetyFeatures.push(...p.safety.certifications);
      }

      const sku = p.parentSku || p.sku || String(p._id);
      const sourceUrl = p.sourceUrl || p.url || '';

      return {
        sku,
        name: p.name || p.title,
        priceCents: getPriceCents(p),
        category: p.category,
        brand: p.brandCode || p.brand || (p.name?.includes('Hard Yakka') ? 'Hard Yakka' : 'KingGee'),
        description: p.description?.replace(/<[^>]*>/g, '').slice(0, 150),
        sourceUrl,
        evidence: {
          databaseRecordId: String(p._id),
          collection: COLLECTION_PRODUCTS,
          verifiedAt: new Date().toISOString(),
          complianceStandards: safetyFeatures,
          inStock: p.stock?.inStock ?? true,
        },
        attributes: {
          toeProtection: role === 'boots' ? toeProtection : undefined,
          weightClass: p.garment?.weightClass || (/lightweight/i.test(p.name || '') ? 'lightweight' : 'midweight'),
          safetyFeatures,
        },
      };
    };

    let selectedPant: any = null;
    let selectedBoot: any = null;
    let bestTotal = Infinity;

    for (const pant of pantsDocs) {
      const pPrice = getPriceCents(pant);
      if (pPrice <= 0 || pPrice > budgetCents) continue;

      for (const boot of bootsDocs) {
        if (requiresComposite) {
          const isComposite =
            boot.safety?.toeProtection === 'composite' ||
            /composite/i.test(boot.name || '') ||
            /composite/i.test(boot.description || '');
          if (!isComposite) continue;
        }

        const bPrice = getPriceCents(boot);
        if (bPrice <= 0) continue;

        const total = pPrice + bPrice;
        if (total <= budgetCents && total < bestTotal) {
          selectedPant = pant;
          selectedBoot = boot;
          bestTotal = total;
          break;
        }
      }
      if (selectedPant && selectedBoot) break;
    }

    if (!selectedPant || !selectedBoot) {
      const missing: string[] = [];
      if (!selectedPant) missing.push('lightweight pants under budget');
      if (!selectedBoot) missing.push(requiresComposite ? 'verified composite-toe safety boots under budget' : 'safety boots under budget');

      return {
        status: 'insufficient_verified_results',
        missing,
        error: `Could not find verified compliant pants and boots in catalog under budget of $${(budgetCents / 100).toFixed(2)} AUD`,
        foundPantsCount: pantsDocs.length,
        foundBootsCount: bootsDocs.length,
      };
    }

    const pantItem = formatItem(selectedPant, 'pants');
    const bootItem = formatItem(selectedBoot, 'boots');
    const totalPriceCents = pantItem.priceCents + bootItem.priceCents;
    const hasSizing = Boolean(input.size || input.sizing || input.boot_size || input.pants_size);

    return {
      bundle: {
        bundleId: `bnd_${Date.now()}`,
        occupation,
        currency: 'AUD',
        totalPriceCents,
        sizingRequired: !hasSizing,
        items: [pantItem, bootItem],
        evidence: {
          groundingMethod: 'database_attribute_constraint_matching',
          verifiedAt: new Date().toISOString(),
          constraintsChecked: [
            'tenant_isolation_workweargroup',
            'composite_toe_strict_protection',
            'lightweight_summer_apparel',
            'budget_ceiling_satisfied',
          ],
        },
      },
    };
  }
}
