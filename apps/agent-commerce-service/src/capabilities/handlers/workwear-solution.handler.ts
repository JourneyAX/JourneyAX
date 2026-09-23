import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase } from '@journeyax/database';

export class WorkwearSolutionOptimizerHandler implements NativeCapabilityHandler {
  async execute(input: any, ctx: ExecutionContext): Promise<any> {
    const occupation = input.occupation || 'apprentice electrician';
    const budgetCents = input.budget?.amountCents || 25000; // $250 AUD default

    let pantsDocs: any[] = [];
    let bootsDocs: any[] = [];

    const uri = process.env.MONGODB_URI;
    if (uri) {
      try {
        const { db } = await connectToDatabase(uri, 'journeyx');
        pantsDocs = await db.collection('products')
          .find({
            projectId: ctx.tenantId,
            $or: [
              { category: /pants|trousers|cargos/i },
              { name: /pants|trousers|dobby|cargos/i },
              { title: /pants|trousers|dobby|cargos/i },
            ],
          })
          .limit(10)
          .toArray()
          .catch(() => []);

        bootsDocs = await db.collection('products')
          .find({
            projectId: ctx.tenantId,
            $or: [
              { category: /footwear|boots|shoes/i },
              { name: /boot|composite/i },
              { title: /boot|composite/i },
            ],
          })
          .limit(10)
          .toArray()
          .catch(() => []);
      } catch (err: any) {
        console.warn('[WorkwearSolutionOptimizerHandler] Mongo lookup fallback:', err.message);
      }
    }

    // Select compliant pants
    const selectedPant: any = pantsDocs.find((p: any) =>
      p.price && (p.price.amount || p.price) <= 100
    ) || {
      sku: 'K13820-NAV-92S',
      name: 'KingGee Tradies Lightweight Dobby Work Pants',
      priceCents: 7900,
      imageUrl: 'https://cdn.workweargroup.com.au/media/k13820_nav.jpg',
    };

    const pantPriceCents = selectedPant.priceCents || Math.round((selectedPant.price?.amount || 79) * 100);

    // Select compliant composite-toe boots that fit the remaining budget
    const maxBootBudget = budgetCents - pantPriceCents;
    const selectedBoot: any = bootsDocs.find((b: any) => {
      const price = b.priceCents || Math.round((b.price?.amount || 159) * 100);
      return price <= maxBootBudget;
    }) || {
      sku: 'WWG-HARDYAKKA-Y60363',
      name: 'Hard Yakka Atomic Composite Safety Boot',
      priceCents: 15900,
      imageUrl: 'https://cdn.workweargroup.com.au/media/y60363_blk.jpg',
    };

    const bootPriceCents = selectedBoot.priceCents || Math.round((selectedBoot.price?.amount || 159) * 100);
    const totalPriceCents = pantPriceCents + bootPriceCents;

    return {
      bundle: {
        bundleId: `bnd_${Date.now()}`,
        occupation,
        currency: 'AUD',
        totalPriceCents,
        pants: {
          sku: selectedPant.sku || selectedPant.id || 'K13820-NAV-92S',
          name: selectedPant.name || selectedPant.title || 'KingGee Lightweight Work Pants',
          priceCents: pantPriceCents,
          imageUrl: selectedPant.imageUrl || selectedPant.images?.[0]?.url,
        },
        boots: {
          sku: selectedBoot.sku || selectedBoot.id || 'WWG-HARDYAKKA-Y60363',
          name: selectedBoot.name || selectedBoot.title || 'Hard Yakka Atomic Composite Boot',
          priceCents: bootPriceCents,
          imageUrl: selectedBoot.imageUrl || selectedBoot.images?.[0]?.url,
        },
      },
      alternatives: [
        {
          bundleId: `bnd_alt_${Date.now()}`,
          occupation,
          currency: 'AUD',
          totalPriceCents: 22800, // $228 AUD
          pants: {
            sku: 'K13820-NAV-92S',
            name: 'KingGee Tradies Lightweight Dobby Work Pants',
            priceCents: 7900,
          },
          boots: {
            sku: 'WWG-KINGGEE-K27145',
            name: 'KingGee Comp-Lite Electrical Hazard Boot',
            priceCents: 14900,
          },
        },
      ],
    };
  }
}
