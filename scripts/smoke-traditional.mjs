const { runTraditional } = await import('../src/lib/traditional/engine.ts');

let r = runTraditional("I'm renovating my bathroom — help me choose a new shower.");
console.log('1', r.meta?.intent, r.uiActions.map((a) => a.name));

r = runTraditional(
  'My answers:\nRenovating, or building new? → Renovating\nShower experience? → Rain overhead\nOverall style? → Minimalist\nFinish? → Matte Black',
  { lastIntent: 'bathroom_shower' }
);
const products = r.uiActions.find((a) => a.name === 'showProducts')?.arguments.products || [];
console.log(
  '2',
  products.map((p) => p.name)
);

r = runTraditional(
  'Build my quote with these selected items:\n- Main Product: Caroma 300mm Square Rain Shower\n  + [Required Part] EasySwitch® Bath/Shower Mixer In-Wall Body\n  + [Accessory] Liano II Robe Hook',
  {
    lastIntent: 'bathroom_shower',
    recommendedProducts: products,
    answers: { finish: 'Matte Black', shower: 'Rain overhead' },
  }
);
const items = r.uiActions.find((a) => a.name === 'updateQuote')?.arguments.items || [];
console.log(
  '3',
  items.map((i) => i.name)
);

r = runTraditional('My shower is dripping');
console.log('4', r.meta?.intent, r.uiActions[0]?.arguments.phase);

if (!products.length || !items.length) {
  console.error('SMOKE FAILED');
  process.exit(1);
}
console.log('SMOKE OK');
