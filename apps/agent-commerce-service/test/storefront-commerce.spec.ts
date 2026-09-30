import { StorefrontCommerceService } from '../src/commerce/storefront-commerce.service';

async function runTests() {
  console.log('🧪 Running StorefrontCommerceService Boundary Test Suite...');

  const service = new StorefrontCommerceService();

  // Test 1: resolveShopperSize normalizes colloquial and numeric sizes
  const msgMedium = [{ role: 'user', content: "I'm usually a medium in tops" }];
  if (service.resolveShopperSize({}, msgMedium) !== 'M') {
    throw new Error('Test 1 failed: medium should resolve to M');
  }

  const msgXL = [{ role: 'user', content: 'Looking for extra large size' }];
  if (service.resolveShopperSize({}, msgXL) !== 'XL') {
    throw new Error('Test 1 failed: extra large should resolve to XL');
  }

  const msgWaist = [{ role: 'user', content: 'waist 34 jeans' }];
  if (service.resolveShopperSize({}, msgWaist) !== '34') {
    throw new Error('Test 1 failed: waist 34 should resolve to 34');
  }
  console.log('  ✅ PASS: resolveShopperSize accurately canonicalizes size strings');

  // Test 2: applySizePreselect marks recommendedSize
  const toolCall: any = {
    function: {
      name: 'showItems',
      arguments: JSON.stringify({
        products: [
          { sku: 'SHIRT-1', name: 'Cotton Tee', sizes: ['S', 'M', 'L'] },
          { sku: 'SHIRT-2', name: 'Slim Tee', sizes: ['XS', 'S'] },
        ],
      }),
    },
  };
  service.applySizePreselect(toolCall, 'M');
  const prods = JSON.parse(toolCall.function.arguments).products;
  if (prods[0].recommendedSize !== 'M') {
    throw new Error('Test 2 failed: SHIRT-1 should have recommendedSize M');
  }
  if (prods[1].recommendedSize !== undefined) {
    throw new Error('Test 2 failed: SHIRT-2 does not have size M, should not be marked');
  }
  console.log('  ✅ PASS: applySizePreselect updates valid cards without touching ineligible ones');

  // Test 3: crossSellDirective respects checkout intent and generates appropriate directive
  const checkoutText = "I'm done, ready to checkout";
  const state: any = {};
  if (service.crossSellDirective('cart', checkoutText, { lines: [{ sku: 'A' }] }, state) !== null) {
    throw new Error('Test 3 failed: checkout intent must yield null crossSellDirective');
  }
  const regularText = 'Add that to my bag';
  const directive = service.crossSellDirective('cart', regularText, { lines: [{ sku: 'A', category: 'Tops' }] }, state);
  if (!directive) {
    throw new Error('Test 3 failed: should produce cross-sell directive on item addition');
  }
  console.log('  ✅ PASS: crossSellDirective honors checkout intent and triggers complete-the-look guidance');

  // Test 4: applyCrossSellFilter drops duplicate categories/products
  state.crossSellExcludeCats = ['Tops'];
  state.crossSellExcludeNames = ['cool tee'];
  const xsellCall: any = {
    function: {
      name: 'showItems',
      arguments: JSON.stringify({
        products: [
          { sku: 'P1', name: 'Cool Tee', category: 'Tops' },
          { sku: 'P2', name: 'Chino Pant', category: 'Bottoms' },
        ],
      }),
    },
  };
  const filteredAll = service.applyCrossSellFilter(xsellCall, state);
  if (filteredAll) {
    throw new Error('Test 4 failed: Chino Pant should remain');
  }
  const remaining = JSON.parse(xsellCall.function.arguments).products;
  if (remaining.length !== 1 || remaining[0].sku !== 'P2') {
    throw new Error('Test 4 failed: duplicate category/product was not filtered out');
  }
  console.log('  ✅ PASS: applyCrossSellFilter eliminates redundant categories in cross-sell');

  console.log('🎉 ALL STOREFRONT COMMERCE TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ StorefrontCommerceService tests failed:', err);
  process.exit(1);
});
