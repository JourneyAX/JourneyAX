/**
 * PLATFORM DEFAULT templates — one json-render spec per card type.
 * A tenant's Mongo doc (`ProjectConfig.cardTemplates[cardType]`) overrides
 * these wholesale. Defaults are deliberately neutral; they exist so a brand-new
 * tenant renders every card on day one before anyone opens the theming studio.
 *
 * Binding cheatsheet (json-render):
 *   { "$state": "/products" }        read from card state
 *   { "$item": "title" }             field of the current repeat item
 *   repeat: { statePath: "/products", key: "sku" }   render children per item
 *   visible: [{ "$state": "/heading" }]              hide when falsy
 *   on: { press: { action: "addToCart", params: { sku: { "$item": "sku" } } } }
 */
import type { Spec } from '@json-render/core';
import type { CardType } from '../catalog/card-types';

type El = Spec['elements'][string];
const S = (p: string) => ({ $state: p });
const I = (p: string) => ({ $item: p });
const el = (type: string, props: Record<string, unknown> = {}, extra: Partial<El> = {}): El => ({ type, props, children: [], ...extra } as El);
const spec = (root: string, elements: Record<string, El>): Spec => ({ root, elements });

/* ---------- shared fragments ---------- */
const productTile = (prefix: string, opts: { showReason?: boolean; cta?: 'addToCart' | 'selectItem' | 'viewProduct' } = {}): Record<string, El> => {
  const k = (s: string) => `${prefix}-${s}`;
  const cta = opts.cta || 'selectItem';
  return {
    // Compact tile — three across inside a 620px conversation column, a short
    // 4:3 picture (or icon when the catalogue has none), name, the agent's
    // one-line reason, SKU + stock, price + add. Sized for reading in a
    // thread, not as a product-listing page.
    [k('card')]: el('Card', { pad: 'sm', gap: 'sm', interactive: true }, {
      children: [k('img'), k('body'), k('foot')],
      on: { press: { action: 'viewProduct', params: { sku: I('sku') } } },
    }),
    [k('img')]: el('Image', { src: I('imageUrl'), alt: I('title'), ratio: '4:3', radius: 'sm', fallbackIcon: 'box' }),
    [k('body')]: el('Box', { gap: 'xs', flex: 1 }, { children: [k('badges'), k('title'), k('reason'), k('meta')] }),
    [k('badges')]: el('Box', { direction: 'row', gap: 'xs', wrap: true }, { children: [k('rec')], visible: [{ $item: 'recommended', eq: true }] }),
    [k('rec')]: el('Badge', { text: 'Recommended', tone: 'brand', icon: 'spark', uppercase: true }),
    [k('title')]: el('Text', { text: I('title'), variant: 'subheading', lines: 2 }),
    [k('reason')]: el('Text', { text: I('reason'), variant: 'small', tone: 'muted', lines: 3 }, { visible: [{ $item: 'reason' }] }),
    [k('meta')]: el('Box', { direction: 'row', gap: 'sm', align: 'center', wrap: true }, { children: [k('sku'), k('stock')] }),
    [k('sku')]: el('Text', { text: I('sku'), variant: 'mono', tone: 'muted' }),
    [k('stock')]: el('StatusDot', { label: I('stockLabel'), tone: 'success' }, { visible: [{ $item: 'stockLabel' }] }),
    [k('foot')]: el('Box', { direction: 'row', align: 'center', justify: 'between', gap: 'sm' }, { children: [k('price'), k('cta'), k('done')] }),
    [k('price')]: el('Price', { amount: I('price'), currency: I('currency'), compareAt: I('compareAtPrice'), size: 'md' }),
    // The tap carries the product's NAME too, so the thread reads "Add The
    // Raid Playmat (SKU …) to my bag." rather than a bare code.
    [k('cta')]: el('Button', { label: cta === 'addToCart' ? 'Add' : 'Choose', variant: 'primary', size: 'sm', icon: cta === 'addToCart' ? 'cart' : 'check' }, {
      on: { press: { action: cta, params: { sku: I('sku'), qty: 1, title: I('title') } } },
      visible: [{ $item: 'inBag', neq: true }],
    }),
    // Once the SKU is in the bag the storefront flags the item (`inBag`) and
    // the button says so — pressing it again opens the bag.
    [k('done')]: el('Button', { label: cta === 'addToCart' ? 'Added ✓' : 'Chosen ✓', variant: 'secondary', size: 'sm', icon: 'check' }, {
      on: { press: { action: 'openPanel', params: { panel: 'quote' } } },
      visible: [{ $item: 'inBag', eq: true }],
    }),
  };
};

const quoteLine = (prefix: string): Record<string, El> => {
  const k = (s: string) => `${prefix}-${s}`;
  return {
    [k('row')]: el('Box', { direction: 'row', gap: 'md', align: 'center', pad: 'md', border: false, bg: 'surface' }, { children: [k('img'), k('body'), k('right')], visible: undefined }),
    [k('img')]: el('Image', { src: I('imageUrl'), alt: I('title'), width: '64px', height: '64px', ratio: '1:1', radius: 'sm', fallbackIcon: 'box' }),
    [k('body')]: el('Box', { gap: 'xs', flex: 1, minWidth: '0' }, { children: [k('head'), k('note'), k('meta')] }),
    [k('head')]: el('Box', { direction: 'row', gap: 'sm', align: 'center', wrap: true }, { children: [k('title'), k('req')] }),
    [k('title')]: el('Text', { text: I('title'), variant: 'subheading' }),
    [k('req')]: el('Badge', { text: 'Auto-added · required', tone: 'accent', uppercase: true }, { visible: [{ $item: 'autoAdded', eq: true }] }),
    [k('note')]: el('Text', { text: I('note'), variant: 'small', tone: 'muted' }, { visible: [{ $item: 'note' }] }),
    [k('meta')]: el('Box', { direction: 'row', gap: 'md', align: 'center', wrap: true }, { children: [k('sku'), k('stock'), k('qty')] }),
    [k('sku')]: el('Text', { text: I('sku'), variant: 'mono', tone: 'muted' }),
    [k('stock')]: el('StatusDot', { label: I('stockLabel'), tone: 'success' }, { visible: [{ $item: 'stockLabel' }] }),
    [k('qty')]: el('Quantity', { value: I('qty'), min: 0, action: 'setQuantity', valueKey: 'qty', params: { sku: I('sku') }, size: 'sm' }),
    [k('right')]: el('Box', { align: 'end', gap: 'xs' }, { children: [k('total'), k('unit')] }),
    [k('total')]: el('Price', { amount: I('lineTotal'), currency: S('/totals/currency'), size: 'md' }),
    [k('unit')]: el('Price', { amount: I('price'), currency: S('/totals/currency'), size: 'sm', tone: 'muted', note: I('qtyLabel') }),
  };
};

const totalsBlock = (prefix: string, _ctaLabel = 'Approve & pay securely'): Record<string, El> => {
  const k = (s: string) => `${prefix}-${s}`;
  return {
    [k('bar')]: el('Box', { direction: 'row', align: 'center', justify: 'between', gap: 'lg', wrap: true, pad: 'md', border: true, bg: 'surface', radius: 'md' }, { children: [k('figs'), k('actions')] }),
    [k('figs')]: el('Box', { direction: 'row', gap: 'lg', wrap: true }, { children: [k('sub'), k('disc'), k('tax'), k('tot')] }),
    [k('sub')]: el('KeyValue', { label: 'Subtotal', value: S('/totals/subtotalLabel') }),
    [k('disc')]: el('KeyValue', { label: 'Discount', value: S('/totals/discountLabel'), tone: 'success' }, { visible: [S('/totals/discount')] }),
    [k('tax')]: el('KeyValue', { label: S('/totals/taxLabel'), value: S('/totals/taxAmountLabel') }, { visible: [S('/totals/tax')] }),
    [k('tot')]: el('Box', { gap: '0' }, { children: [k('totl'), k('totv')] }),
    [k('totl')]: el('Text', { text: 'Total', variant: 'label', tone: 'accent' }),
    [k('totv')]: el('Price', { amount: S('/totals/total'), currency: S('/totals/currency'), size: 'xl' }),
    [k('actions')]: el('Box', { direction: 'row', gap: 'sm', align: 'center' }, { children: [k('cta')] }),
    // The closing CTA reads from state (mapQuoteCard sets it per commerce mode:
    // "Checkout" for a retail bag, "Approve & pay securely" for a trade quote);
    // the literal is only the fallback when a tenant template omits it.
    [k('cta')]: el('Button', { label: S('/ctaLabel'), variant: 'primary', size: 'lg', iconRight: 'chevron-right', loading: S('/ordering') }, { on: { press: { action: 'checkout' } } }),
  };
};

/* ---------- templates ---------- */
export const DEFAULT_TEMPLATES: Record<CardType, Spec> = {
  hero: spec('root', {
    root: el('Box', { gap: 'lg', pad: 'xl', align: 'start', maxWidth: '760px' }, { children: ['eyebrow', 'headline', 'sub', 'chips'] }),
    eyebrow: el('Text', { text: 'Start here', variant: 'eyebrow' }),
    headline: el('Text', { text: S('/headline'), variant: 'display' }),
    sub: el('Text', { text: S('/sub'), variant: 'body', tone: 'muted' }, { visible: [S('/sub')] }),
    chips: el('Chips', { items: S('/chips'), action: 'sendMessage', valueKey: 'text' }, { visible: [S('/chips')] }),
  }),

  // Every question is independently answerable; a tapped chip stays lit
  // (`answer`) and the footer counts progress — nothing submits until the
  // last one is picked (the storefront owns that, see CardStage/ChatPanel).
  clarify: spec('root', {
    root: el('Box', { gap: '0', maxWidth: '760px' }, { children: ['head', 'qs', 'foot'] }),
    head: el('Box', { gap: 'xs', pad: 'md' }, { children: ['eyebrow', 'title'] }),
    eyebrow: el('Text', { text: 'A couple of quick questions', variant: 'eyebrow' }),
    title: el('Text', { text: 'Help me narrow it down', variant: 'heading' }),
    qs: el('Box', { gap: '0' }, { children: ['q'], repeat: { statePath: '/questions', key: 'id' } }),
    q: el('Box', { pad: 'md', gap: 'sm' }, { children: ['qt', 'qopts'] }),
    qt: el('Text', { text: I('text'), variant: 'subheading' }),
    qopts: el('Chips', { items: I('options'), selected: I('answer'), action: 'chooseOption', valueKey: 'value', params: { questionId: I('id') } }),
    foot: el('Box', { pad: 'sm', bg: 'surface-alt' }, { children: ['prog'], visible: [S('/progress')] }),
    prog: el('Text', { text: S('/progress'), variant: 'small', tone: 'muted' }),
  }),

  products: spec('root', {
    root: el('Box', { gap: 'md', pad: 'md' }, { children: ['head', 'grid', 'foot'] }),
    head: el('Box', { gap: 'xs' }, { children: ['eyebrow', 'title', 'intro'] }),
    eyebrow: el('Text', { text: 'Recommended for you', variant: 'eyebrow' }),
    title: el('Text', { text: S('/heading'), variant: 'title' }, { visible: [S('/heading')] }),
    intro: el('Text', { text: S('/intro'), variant: 'body', tone: 'muted' }, { visible: [S('/intro')] }),
    grid: el('Grid', { minItemWidth: '170px', gap: 'sm' }, { children: ['p-card'], repeat: { statePath: '/products', key: 'sku' } }),
    ...productTile('p', { cta: 'addToCart' }),
    foot: el('Box', { direction: 'row', justify: 'end', gap: 'sm' }, { children: ['addall'] }),
    addall: el('Button', { label: { $template: 'Add all to ${/closing}' }, variant: 'secondary', icon: 'cart' }, { on: { press: { action: 'addAllToCart', params: { items: S('/products') } } } }),
  }),

  productDetail: spec('root', {
    root: el('Box', { pad: 'md', direction: 'row', gap: 'lg', wrap: true }, { children: ['gallery', 'info'] }),
    gallery: el('Box', { flex: '1 1 320px', gap: 'sm' }, { children: ['hero'] }),
    hero: el('Image', { src: S('/product/imageUrl'), alt: S('/product/title'), ratio: '1:1', radius: 'md', fallbackIcon: 'box' }),
    info: el('Box', { flex: '1 1 360px', gap: 'md' }, { children: ['brand', 'title', 'price', 'stock', 'desc', 'specs', 'actions'] }),
    brand: el('Text', { text: S('/product/brand'), variant: 'eyebrow' }, { visible: [S('/product/brand')] }),
    title: el('Text', { text: S('/product/title'), variant: 'title' }),
    price: el('Price', { amount: S('/product/price'), currency: S('/product/currency'), compareAt: S('/product/compareAtPrice'), size: 'lg' }),
    stock: el('StatusDot', { label: S('/product/stockLabel'), tone: 'success' }, { visible: [S('/product/stockLabel')] }),
    desc: el('Markdown', { text: S('/product/description') }, { visible: [S('/product/description')] }),
    specs: el('Box', { gap: 'xs' }, { children: ['spec'], repeat: { statePath: '/product/specList', key: 'label' } }),
    spec: el('KeyValue', { label: I('label'), value: I('value'), inline: true }),
    actions: el('Box', { direction: 'row', gap: 'sm', wrap: true }, { children: ['add', 'handoff', 'ask'] }),
    add: el('Button', { label: { $template: 'Add to ${/closing}' }, variant: 'primary', icon: 'cart' }, { on: { press: { action: 'addToCart', params: { sku: S('/product/sku'), qty: 1 } } } }),
    // A configured hand-off (e.g. "Design it in The Forge") — a product whose
    // sale closes in the tenant's own tool, not in the bag. Present only when
    // the storefront matched a `handoffs` rule to this product.
    handoff: el('Button', { label: S('/handoff/label'), variant: 'primary', iconRight: 'chevron-right' }, { visible: [S('/handoff')], on: { press: { action: 'openUrl', params: { url: S('/handoff/url') } } } }),
    ask: el('Button', { label: 'Ask about this', variant: 'secondary' }, { on: { press: { action: 'sendMessage', params: { text: { $template: 'Tell me more about ${/product/title}' } } } } }),
  }),

  comparison: spec('root', {
    root: el('Box', { pad: 'md', gap: 'md' }, { children: ['eyebrow', 'title', 'table', 'verdict'] }),
    eyebrow: el('Text', { text: 'Side by side', variant: 'eyebrow' }),
    title: el('Text', { text: 'Comparison', variant: 'title' }),
    table: el('Table', { columns: S('/columns'), rows: S('/rows') }),
    verdict: el('Alert', { title: 'My take', text: S('/verdict'), tone: 'success', icon: 'spark' }, { visible: [S('/verdict')] }),
  }),

  bundle: spec('root', {
    root: el('Box', { pad: 'md', gap: 'md' }, { children: ['eyebrow', 'title', 'why', 'grid', 'foot'] }),
    eyebrow: el('Text', { text: 'Everything you need', variant: 'eyebrow' }),
    title: el('Text', { text: S('/heading'), variant: 'title' }),
    why: el('Text', { text: S('/why'), variant: 'body', tone: 'muted' }, { visible: [S('/why')] }),
    grid: el('Grid', { minItemWidth: '220px', gap: 'md' }, { children: ['b-card'], repeat: { statePath: '/items', key: 'sku' } }),
    ...productTile('b', { cta: 'addToCart' }),
    foot: el('Box', { direction: 'row', justify: 'between', align: 'center', gap: 'md', wrap: true }, { children: ['tot', 'addall'] }),
    tot: el('Price', { amount: S('/totals/total'), currency: S('/totals/currency'), size: 'lg', note: 'bundle total' }, { visible: [S('/totals/total')] }),
    addall: el('Button', { label: { $template: 'Add all to ${/closing}' }, variant: 'primary', icon: 'cart', size: 'lg' }, { on: { press: { action: 'addAllToCart', params: { items: S('/items') } } } }),
  }),

  quote: spec('root', {
    root: el('Box', { pad: 'md', gap: 'lg', maxWidth: '900px' }, { children: ['head', 'fulfil', 'notes', 'bomLabel', 'lines', 'totals'] }),
    head: el('Box', { direction: 'row', justify: 'between', align: 'start', gap: 'md', wrap: true }, { children: ['headL', 'compliance'] }),
    headL: el('Box', { gap: 'xs' }, { children: ['eyebrow', 'title', 'sub'] }),
    eyebrow: el('Text', { text: S('/eyebrow'), variant: 'eyebrow' }, { visible: [S('/eyebrow')] }),
    title: el('Text', { text: S('/heading'), variant: 'title' }),
    sub: el('Text', { text: S('/sub'), variant: 'body', tone: 'muted' }, { visible: [S('/sub')] }),
    compliance: el('Badge', { text: S('/compliance'), tone: 'success', variant: 'outline', icon: 'check' }, { visible: [S('/compliance')] }),
    fulfil: el('Card', { pad: 'md', gap: 'sm', variant: 'flat' }, { children: ['fhead', 'fsel', 'fstatus'], visible: [S('/fulfilment/options')] }),
    fhead: el('Box', { direction: 'row', justify: 'between', align: 'center' }, { children: ['fl', 'fb'] }),
    fl: el('Text', { text: S('/fulfilment/label'), variant: 'label' }),
    fb: el('Badge', { text: S('/fulfilment/badge'), tone: 'success' }, { visible: [S('/fulfilment/badge')] }),
    fsel: el('Select', { value: S('/fulfilment/selected'), options: S('/fulfilment/options'), action: 'selectBranch', valueKey: 'branchId' }),
    fstatus: el('Text', { text: S('/fulfilment/status'), variant: 'small', tone: 'success', weight: 'semibold' }, { visible: [S('/fulfilment/status')] }),
    notes: el('Card', { pad: 'md', gap: 'sm', variant: 'outlined' }, { children: ['nt'], visible: [S('/notes')] }),
    nt: el('Box', { gap: 'sm' }, { children: ['n'], repeat: { statePath: '/notes', key: 'title' } }),
    n: el('Box', { gap: '0' }, { children: ['n1', 'n2'] }),
    n1: el('Text', { text: I('title'), variant: 'small', tone: 'success', weight: 'semibold' }),
    n2: el('Text', { text: I('text'), variant: 'small', tone: 'muted' }),
    bomLabel: el('Text', { text: 'Bill of materials', variant: 'label' }),
    lines: el('Box', { border: true, bg: 'surface', radius: 'md', overflow: 'hidden' }, { children: ['l-row'], repeat: { statePath: '/lines', key: 'sku' } }),
    ...quoteLine('l'),
    ...totalsBlock('t'),
    totals: el('Box', {}, { children: ['t-bar'] }),
  }),

  cart: spec('root', {
    root: el('Box', { pad: 'md', gap: 'lg', maxWidth: '900px' }, { children: ['title', 'lines', 'totals'] }),
    title: el('Text', { text: 'Your bag', variant: 'title' }),
    lines: el('Box', { border: true, bg: 'surface', radius: 'md', overflow: 'hidden' }, { children: ['c-row'], repeat: { statePath: '/lines', key: 'sku' } }),
    ...quoteLine('c'),
    ...totalsBlock('ct', 'Checkout'),
    totals: el('Box', {}, { children: ['ct-bar'] }),
  }),

  orderStatus: spec('root', {
    root: el('Box', { pad: 'md', gap: 'lg', maxWidth: '760px' }, { children: ['ok', 'title', 'meta', 'timeline', 'lines'] }),
    ok: el('Alert', { title: 'Order confirmed', text: S('/statusText'), tone: 'success' }),
    title: el('Text', { text: { $template: 'Order ${/orderId}' }, variant: 'title' }),
    meta: el('Box', { direction: 'row', gap: 'lg', wrap: true }, { children: ['st', 'pl', 'tt'] }),
    st: el('KeyValue', { label: 'Status', value: S('/status') }),
    pl: el('KeyValue', { label: 'Placed', value: S('/placedAt') }, { visible: [S('/placedAt')] }),
    tt: el('KeyValue', { label: 'Total', value: S('/totals/totalLabel') }, { visible: [S('/totals/totalLabel')] }),
    timeline: el('Steps', { items: S('/timeline') }, { visible: [S('/timeline')] }),
    lines: el('Box', { border: true, bg: 'surface', radius: 'md', overflow: 'hidden' }, { children: ['o-row'], repeat: { statePath: '/lines', key: 'sku' } }),
    ...quoteLine('o'),
  }),

  guide: spec('root', {
    root: el('Box', { pad: 'md', gap: 'lg', maxWidth: '760px' }, { children: ['eyebrow', 'title', 'safety', 'sections', 'products'] }),
    eyebrow: el('Text', { text: 'Guide', variant: 'eyebrow' }),
    title: el('Text', { text: S('/heading'), variant: 'title' }),
    safety: el('Alert', { title: 'Before you start', text: S('/safety'), tone: 'warning' }, { visible: [S('/safety')] }),
    sections: el('Box', { gap: 'md' }, { children: ['sec'], repeat: { statePath: '/sections', key: 'title' } }),
    sec: el('Card', { pad: 'md', gap: 'sm', variant: 'flat' }, { children: ['st', 'sb', 'ss'] }),
    st: el('Text', { text: I('title'), variant: 'heading' }),
    sb: el('Markdown', { text: I('body') }),
    ss: el('Steps', { items: I('steps') }, { visible: [{ $item: 'steps' }] }),
    products: el('Grid', { minItemWidth: '220px', gap: 'md' }, { children: ['g-card'], repeat: { statePath: '/products', key: 'sku' }, visible: [S('/products')] }),
    ...productTile('g', { cta: 'addToCart' }),
  }),

  plan: spec('root', {
    root: el('Box', { pad: 'md', gap: 'lg', maxWidth: '760px' }, { children: ['eyebrow', 'title', 'steps', 'tot'] }),
    eyebrow: el('Text', { text: 'Your plan', variant: 'eyebrow' }),
    title: el('Text', { text: S('/heading'), variant: 'title' }),
    steps: el('Steps', { items: S('/steps') }),
    tot: el('Price', { amount: S('/totals/total'), currency: S('/totals/currency'), size: 'lg', note: 'estimated total' }, { visible: [S('/totals/total')] }),
  }),

  accessories: spec('root', {
    root: el('Box', { pad: 'md', gap: 'lg' }, { children: ['eyebrow', 'title', 'groups'] }),
    eyebrow: el('Text', { text: 'Goes with it', variant: 'eyebrow' }),
    title: el('Text', { text: 'Accessories & add-ons', variant: 'title' }),
    groups: el('Box', { gap: 'lg' }, { children: ['grp'], repeat: { statePath: '/groups', key: 'key' } }),
    grp: el('Box', { gap: 'sm' }, { children: ['gl', 'gh', 'gg'] }),
    gl: el('Text', { text: I('label'), variant: 'heading' }),
    gh: el('Text', { text: I('hint'), variant: 'small', tone: 'muted' }, { visible: [{ $item: 'hint' }] }),
    gg: el('Grid', { minItemWidth: '200px', gap: 'md' }, { children: ['a-card'], repeat: { statePath: { $item: 'items' }, key: 'sku' } }),
    ...productTile('a', { cta: 'addToCart' }),
  }),

  warranty: spec('root', {
    root: el('Box', { pad: 'md', gap: 'md', maxWidth: '760px' }, { children: ['eyebrow', 'title', 'items'] }),
    eyebrow: el('Text', { text: 'Peace of mind', variant: 'eyebrow' }),
    title: el('Text', { text: 'Warranty & compliance', variant: 'title' }),
    items: el('Box', { gap: 'sm' }, { children: ['w'], repeat: { statePath: '/items', key: 'title' } }),
    w: el('Card', { pad: 'md', gap: 'xs', variant: 'flat' }, { children: ['wh', 'wt', 'wl'] }),
    wh: el('Box', { direction: 'row', gap: 'sm', align: 'center' }, { children: ['wi', 'wtitle'] }),
    wi: el('Icon', { name: 'shield', tone: 'success' }),
    wtitle: el('Text', { text: I('title'), variant: 'heading' }),
    wt: el('Markdown', { text: I('text') }),
    wl: el('Link', { label: 'View document', href: I('url'), external: true }, { visible: [{ $item: 'url' }] }),
  }),

  fitment: spec('root', {
    root: el('Box', { pad: 'md', gap: 'md', maxWidth: '640px' }, { children: ['eyebrow', 'rec', 'basis', 'alts'] }),
    eyebrow: el('Text', { text: 'Fit recommendation', variant: 'eyebrow' }),
    rec: el('Alert', { title: S('/recommendation'), text: S('/confidenceText'), tone: 'success', icon: 'ruler' }),
    basis: el('Box', { gap: 'xs' }, { children: ['b'], repeat: { statePath: '/basis', key: 'label' } }),
    b: el('KeyValue', { label: I('label'), value: I('value'), inline: true }),
    alts: el('Chips', { items: S('/alternatives'), action: 'sendMessage', valueKey: 'text' }, { visible: [S('/alternatives')] }),
  }),

  disclosure: spec('root', {
    root: el('Card', { pad: 'lg', gap: 'md' }, { children: ['title', 'text', 'accept'] }),
    title: el('Text', { text: S('/title'), variant: 'heading' }),
    text: el('Markdown', { text: S('/text'), tone: 'muted' }),
    accept: el('Button', { label: S('/acceptLabel'), variant: 'primary' }, { on: { press: { action: 'sendMessage', params: { text: 'I accept' } } } }),
  }),

  suggestions: spec('root', {
    root: el('Chips', { items: S('/chips'), action: 'sendMessage', valueKey: 'text' }),
  }),

  working: spec('root', {
    root: el('Box', { gap: 'sm', pad: 'md', bg: 'surface-alt', border: true, radius: 'md', shadow: 'md' }, { children: ['head', 'heard', 'steps', 'reply'] }),
    head: el('Box', { direction: 'row', gap: 'sm', align: 'center' }, { children: ['dot', 'lab', 'det'] }),
    dot: el('StatusDot', { label: '', tone: 'accent', pulse: true }),
    lab: el('Text', { text: { $template: 'Working for ${/elapsed}s' }, variant: 'small', weight: 'bold' }),
    det: el('Text', { text: S('/label'), variant: 'small', tone: 'muted' }),
    heard: el('Box', { direction: 'row', gap: 'sm', align: 'start' }, { children: ['hl', 'ht'], visible: [S('/heard')] }),
    hl: el('Badge', { text: 'Heard', tone: 'accent', uppercase: true }),
    ht: el('Text', { text: S('/heard'), variant: 'small', tone: 'muted' }),
    steps: el('Steps', { items: S('/steps') }, { visible: [S('/steps')] }),
    reply: el('Text', { text: S('/lastReply'), variant: 'body' }, { visible: [S('/lastReply')] }),
  }),
};

export function getDefaultTemplate(cardType: CardType): Spec {
  return DEFAULT_TEMPLATES[cardType];
}
