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
    [k('img')]: el('Image', { src: I('imageUrl'), alt: I('title'), ratio: '4:3', radius: 'sm', fallbackIcon: 'box', fallbackSrc: S('/brandLogo'), fallbackLabel: 'Image coming soon' }),
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

/**
 * One product as a consultant would put it on the counter: a small picture, the name and price, WHY this one (the catalogue's
 * own feature that answers what the customer asked for), the other things worth knowing, a rating when the catalogue has one,
 * where it is held, and the actions: add, open the details, tick it to compare. Every line hides itself when there is nothing
 * true to say, so a thin catalogue record gives a short row, never an invented one.
 *
 * Words that depend on the numbers (the availability line, the compare label, the highlights joined into one line, the ask-for-price
 * sentence) are prepared by the storefront, which owns the wording; the template only decides where they go.
 */
/** One section of the pre-payment check: a heading with its status, then a row per finding with its one button. */
const reviewSection = (name: string): Record<string, El> => {
  const at = (field: string) => S(`/${name}/${field}`);
  return {
    [name]: el('Box', { gap: 'xs' }, { children: [`${name}-head`, `${name}-rows`] }),
    [`${name}-head`]: el('Box', { direction: 'row', gap: 'sm', align: 'center', wrap: true }, { children: [`${name}-ok`, `${name}-warn`, `${name}-sum`] }),
    [`${name}-ok`]: el('StatusDot', { label: at('title'), tone: 'success' }, { visible: [at('ok')] }),
    [`${name}-warn`]: el('StatusDot', { label: at('title'), tone: 'warning' }, { visible: [at('warn')] }),
    [`${name}-sum`]: el('Text', { text: at('summary'), variant: 'caption', tone: 'muted' }, { visible: [at('summary')] }),
    [`${name}-rows`]: el('Box', { gap: 'xs' }, { children: [`${name}-row`], repeat: { statePath: `/${name}/rows`, key: 'key' } }),
    [`${name}-row`]: el('Box', { direction: 'row', gap: 'sm', align: 'center', justify: 'between', wrap: true }, { children: [`${name}-text`, `${name}-msg`, `${name}-add`] }),
    [`${name}-text`]: el('Box', { gap: 'xs', style: { flex: 1, minWidth: 0 } }, { children: [`${name}-t`, `${name}-d`] }),
    [`${name}-t`]: el('Text', { text: I('title'), variant: 'small' }),
    [`${name}-d`]: el('Text', { text: I('detail'), variant: 'caption', tone: 'muted' }, { visible: [I('detail')] }),
    [`${name}-msg`]: el('Button', { label: I('actionLabel'), variant: 'ghost', size: 'sm' }, { visible: [I('hasMessage')], on: { press: { action: 'sendMessage', params: { text: I('actionText') } } } }),
    [`${name}-add`]: el('Button', { label: I('actionLabel'), variant: 'secondary', size: 'sm', icon: 'cart' }, { visible: [I('hasAdd')], on: { press: { action: 'addToCart', params: { sku: I('actionSku'), qty: 1, title: I('title') } } } }),
  };
};

const productRow = (prefix: string): Record<string, El> => {
  const k = (s: string) => `${prefix}-${s}`;
  const open = { press: { action: 'viewProduct', params: { sku: I('sku') } } };
  return {
    [k('card')]: el('Card', { pad: 'md', gap: 'sm', variant: 'outlined', interactive: true }, { children: [k('row')], on: open }),
    [k('row')]: el('Box', { direction: 'row', gap: 'md', align: 'start' }, { children: [k('img'), k('body')] }),
    [k('img')]: el('Image', { src: I('imageUrl'), alt: I('title'), width: '88px', height: '88px', ratio: '1:1', fit: 'contain', radius: 'sm', fallbackIcon: 'box', fallbackSrc: S('/brandLogo') }),
    [k('body')]: el('Box', { gap: 'xs', flex: 1, minWidth: '0' }, { children: [k('head'), k('badges'), k('why'), k('caution'), k('more'), k('meta'), k('actions')] }),
    [k('head')]: el('Box', { direction: 'row', gap: 'md', align: 'start', justify: 'between' }, { children: [k('title'), k('price')] }),
    [k('title')]: el('Text', { text: I('title'), variant: 'subheading', lines: 2, style: { flex: 1, minWidth: 0 } }),
    [k('price')]: el('Price', { amount: I('price'), currency: I('currency'), compareAt: I('compareAtPrice'), size: 'md', emptyText: 'Price on request' }),
    [k('badges')]: el('Box', { direction: 'row', gap: 'xs', wrap: true }, { children: [k('rec')], visible: [{ $item: 'recommended', eq: true }] }),
    [k('rec')]: el('Badge', { text: 'Recommended', tone: 'brand', icon: 'spark', uppercase: true }),
    [k('why')]: el('Box', { direction: 'row', gap: 'xs', align: 'start' }, { children: [k('whyIcon'), k('whyText')], visible: [{ $item: 'reason' }] }),
    [k('whyIcon')]: el('Icon', { name: 'check', size: 'sm', tone: 'success' }),
    [k('whyText')]: el('Text', { text: I('reason'), variant: 'small', lines: 3, style: { flex: 1, minWidth: 0 } }),
    [k('caution')]: el('Box', { direction: 'row', gap: 'xs', align: 'start' }, { children: [k('cautionIcon'), k('cautionText')], visible: [{ $item: 'cautionText' }] }),
    [k('cautionIcon')]: el('Icon', { name: 'warning', size: 'sm', tone: 'warning' }),
    [k('cautionText')]: el('Text', { text: I('cautionText'), variant: 'small', tone: 'warning', lines: 3, style: { flex: 1, minWidth: 0 } }),
    [k('more')]: el('Text', { text: I('highlightsText'), variant: 'small', tone: 'muted', lines: 2 }, { visible: [{ $item: 'highlightsText' }] }),
    [k('meta')]: el('Box', { direction: 'row', gap: 'sm', align: 'center', wrap: true }, { children: [k('rating'), k('stock'), k('sku')] }),
    [k('rating')]: el('Rating', { value: I('rating'), count: I('ratingCount'), size: 'sm' }, { visible: [{ $item: 'rating' }] }),
    [k('stock')]: el('StatusDot', { label: I('stockLabel'), tone: 'success' }, { visible: [{ $item: 'stockLabel' }] }),
    [k('sku')]: el('Text', { text: I('sku'), variant: 'mono', tone: 'muted' }),
    [k('actions')]: el('Box', { direction: 'row', gap: 'sm', align: 'center', wrap: true }, { children: [k('add'), k('added'), k('ask'), k('details'), k('compare')] }),
    [k('add')]: el('Button', { label: 'Add', variant: 'primary', size: 'sm', icon: 'cart' }, {
      on: { press: { action: 'addToCart', params: { sku: I('sku'), qty: 1, title: I('title') } } },
      visible: [{ $item: 'inBag', neq: true }],
    }),
    [k('added')]: el('Button', { label: 'Added ✓', variant: 'secondary', size: 'sm', icon: 'check' }, {
      on: { press: { action: 'openPanel', params: { panel: 'quote' } } },
      visible: [{ $item: 'inBag', eq: true }],
    }),
    [k('ask')]: el('Button', { label: 'Ask for price', variant: 'secondary', size: 'sm', icon: 'tag' }, {
      on: { press: { action: 'sendMessage', params: { text: I('askPriceText') } } },
      visible: [{ $item: 'priceMissing', eq: true }],
    }),
    [k('details')]: el('Button', { label: 'Details', variant: 'ghost', size: 'sm' }, { on: open }),
    [k('compare')]: el('Button', { label: I('compareLabel'), variant: 'ghost', size: 'sm', icon: 'plus' }, {
      on: { press: { action: 'toggleCompare', params: { sku: I('sku'), title: I('title') } } },
    }),
  };
};

const quoteLine = (prefix: string): Record<string, El> => {
  const k = (s: string) => `${prefix}-${s}`;
  return {
    [k('row')]: el('Box', { direction: 'row', gap: 'md', align: 'center', pad: 'md', border: false, bg: 'surface' }, { children: [k('img'), k('body'), k('right')], visible: undefined }),
    [k('img')]: el('Image', { src: I('imageUrl'), alt: I('title'), width: '64px', height: '64px', ratio: '1:1', radius: 'sm', fallbackIcon: 'box', fallbackSrc: S('/brandLogo') }),
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
    // The words above the questions come from the card's own state, written by the consultant in the customer's language;
    // a card that carries none shows the questions alone, right under the reply that introduced them.
    head: el('Box', { gap: 'xs', pad: 'md' }, { children: ['eyebrow', 'title'], visible: [S('/heading')] }),
    eyebrow: el('Text', { text: S('/eyebrow'), variant: 'eyebrow' }, { visible: [S('/eyebrow')] }),
    title: el('Text', { text: S('/heading'), variant: 'heading' }, { visible: [S('/heading')] }),
    qs: el('Box', { gap: '0' }, { children: ['q'], repeat: { statePath: '/questions', key: 'id' } }),
    q: el('Box', { pad: 'md', gap: 'sm' }, { children: ['qt', 'qinput'] }),
    qt: el('Text', { text: I('text'), variant: 'subheading' }),
    qinput: el('QuestionInput', {
      questionId: I('id'), label: I('text'), options: I('options'), selected: I('answer'),
      multi: I('multi'), inputType: I('inputType'), placeholder: I('placeholder'), unit: I('unit'), min: I('min'), max: I('max'),
      action: 'chooseOption', valueKey: 'value',
    }),
    foot: el('Box', { pad: 'sm', bg: 'surface-alt' }, { children: ['prog'], visible: [S('/progress')] }),
    prog: el('Text', { text: S('/progress'), variant: 'small', tone: 'muted' }),
  }),

  products: spec('root', {
    root: el('Box', { gap: 'md', pad: 'md' }, { children: ['head', 'grid'] }),
    head: el('Box', { gap: 'xs' }, { children: ['eyebrow', 'title', 'intro'] }),
    eyebrow: el('Text', { text: S('/eyebrow'), variant: 'eyebrow' }, { visible: [S('/eyebrow')] }),
    title: el('Text', { text: S('/heading'), variant: 'title' }, { visible: [S('/heading')] }),
    intro: el('Text', { text: S('/intro'), variant: 'body', tone: 'muted' }, { visible: [S('/intro')] }),
    grid: el('Carousel', { itemWidth: '370px', gap: 'sm', label: 'Recommended products' }, { children: ['p-card'], repeat: { statePath: '/products', key: 'sku' } }),
    ...productRow('p'),
  }),

  productDetail: spec('root', {
    // One product, read like a counter conversation: what it is and what it costs first, then what a customer checks before
    // buying (features, specifications, documents), then what goes with it. A section the product has nothing for is hidden
    // by its `has…` flag, so an unknown fact is never an empty heading.
    root: el('Box', { pad: 'md', gap: 'lg' }, { children: ['top', 'sections'] }),
    top: el('Box', { direction: 'row', gap: 'lg', wrap: true }, { children: ['gallery', 'info'] }),
    gallery: el('Box', { flex: '1 1 180px', maxWidth: '240px', gap: 'sm' }, { children: ['hero'] }),
    hero: el('Image', { src: S('/product/imageUrl'), alt: S('/product/title'), ratio: '1:1', radius: 'md', fallbackIcon: 'box', fallbackSrc: S('/brandLogo'), fallbackLabel: 'Image coming soon' }),
    info: el('Box', { flex: '1 1 340px', gap: 'md' }, { children: ['brand', 'title', 'price', 'rating', 'stock', 'stockWarn', 'desc', 'actions', 'site'] }),
    brand: el('Text', { text: S('/product/brand'), variant: 'eyebrow' }, { visible: [S('/product/brand')] }),
    title: el('Text', { text: S('/product/title'), variant: 'title' }),
    price: el('Price', { amount: S('/product/price'), currency: S('/product/currency'), compareAt: S('/product/compareAtPrice'), size: 'lg' }),
    rating: el('Rating', { value: S('/product/rating'), count: S('/product/ratingCount'), size: 'md' }, { visible: [S('/product/hasRating')] }),
    stock: el('StatusDot', { label: S('/product/stockLabel'), tone: 'success' }, { visible: [S('/product/stockOk')] }),
    stockWarn: el('StatusDot', { label: S('/product/stockLabel'), tone: 'warning' }, { visible: [S('/product/stockWarn')] }),
    desc: el('Markdown', { text: S('/product/description') }, { visible: [S('/product/description')] }),
    site: el('Link', { label: 'See it on the website', href: S('/product/productUrl'), external: true }, { visible: [S('/product/hasProductUrl')] }),
    sections: el('Box', { gap: 'lg' }, { children: ['features', 'specs', 'docs', 'suggested', 'related'] }),
    features: el('Box', { gap: 'xs' }, { children: ['featuresHead', 'featuresList'], visible: [S('/product/hasFeatures')] }),
    featuresHead: el('Text', { text: 'Key features', variant: 'subheading' }),
    featuresList: el('Markdown', { text: S('/product/featuresText') }),
    specs: el('Box', { gap: 'xs' }, { children: ['specsHead', 'specRows'], visible: [S('/product/hasSpecs')] }),
    specsHead: el('Text', { text: 'Specifications', variant: 'subheading' }),
    specRows: el('Box', { gap: 'xs' }, { children: ['spec'], repeat: { statePath: '/product/specList', key: 'label' } }),
    spec: el('KeyValue', { label: I('label'), value: I('value'), inline: true }),
    docs: el('Box', { gap: 'xs' }, { children: ['docsHead', 'docRows'], visible: [S('/product/hasDocuments')] }),
    docsHead: el('Text', { text: 'Documents', variant: 'subheading' }),
    docRows: el('Box', { gap: 'xs' }, { children: ['doc'], repeat: { statePath: '/product/documents', key: 'url' } }),
    // A document opens as a link, and the consultant can read it to the customer in plain words ("ask" is the line sent for that document).
    doc: el('Box', { direction: 'row', gap: 'sm', align: 'center', wrap: true }, { children: ['docLink', 'docExplain'] }),
    docLink: el('Link', { label: I('title'), href: I('url'), external: true }),
    docExplain: el('Button', { label: 'Explain it to me', variant: 'ghost', size: 'sm' }, { visible: [I('ask')], on: { press: { action: 'sendMessage', params: { text: I('ask') } } } }),
    // What the catalogue itself suggests alongside this product: suggestions only, never a statement that it fits.
    suggested: el('Box', { gap: 'sm' }, { children: ['suggestedHead', 'suggestedNote', 'suggestedGrid'], visible: [S('/product/hasSuggested')] }),
    suggestedHead: el('Text', { text: 'Have you considered?', variant: 'subheading' }),
    suggestedNote: el('Text', { text: 'These are suggestions only. They are not confirmed to be compatible with, or required for, this product.', variant: 'caption', tone: 'muted' }),
    suggestedGrid: el('Carousel', { itemWidth: '150px', gap: 'sm', label: 'Suggestions' }, { children: ['rel'], repeat: { statePath: '/product/suggested', key: 'sku' } }),
    related: el('Box', { gap: 'sm' }, { children: ['relatedHead', 'relatedGrid'], visible: [S('/product/hasRelated')] }),
    relatedHead: el('Text', { text: 'Similar products', variant: 'subheading' }),
    relatedGrid: el('Carousel', { itemWidth: '150px', gap: 'sm', label: 'Similar products' }, { children: ['rel'], repeat: { statePath: '/product/related', key: 'sku' } }),
    rel: el('Card', { pad: 'sm', gap: 'sm', interactive: true }, { children: ['relImg', 'relTitle', 'relPrice'], on: { press: { action: 'viewProduct', params: { sku: I('sku') } } } }),
    relImg: el('Image', { src: I('imageUrl'), alt: I('title'), ratio: '1:1', fit: 'contain', width: '88px', height: '88px', radius: 'sm', fallbackIcon: 'box', fallbackSrc: S('/brandLogo'), fallbackLabel: 'Image coming soon' }),
    relTitle: el('Text', { text: I('title'), variant: 'small', lines: 2 }),
    relPrice: el('Price', { amount: I('price'), currency: I('currency'), size: 'sm' }),
    actions: el('Box', { direction: 'row', gap: 'sm', wrap: true }, { children: ['add', 'handoff', 'ask', 'compare'] }),
    add: el('Button', { label: { $template: 'Add to ${/closing}' }, variant: 'primary', icon: 'cart' }, { on: { press: { action: 'addToCart', params: { sku: S('/product/sku'), qty: 1, title: S('/product/title') } } } }),
    // A configured hand-off (e.g. "Design it in The Forge") — a product whose
    // sale closes in the tenant's own tool, not in the bag. Present only when
    // the storefront matched a `handoffs` rule to this product.
    handoff: el('Button', { label: S('/handoff/label'), variant: 'primary', iconRight: 'chevron-right' }, { visible: [S('/handoff')], on: { press: { action: 'openUrl', params: { url: S('/handoff/url') } } } }),
    ask: el('Button', { label: 'Ask about this', variant: 'secondary' }, { on: { press: { action: 'sendMessage', params: { text: { $template: 'Tell me more about ${/product/title}' } } } } }),
    compare: el('Button', { label: 'Compare', variant: 'ghost', icon: 'plus' }, { on: { press: { action: 'toggleCompare', params: { sku: S('/product/sku'), title: S('/product/title') } } } }),
  }),

  review: spec('root', {
    // The last look before payment, section by section. Each row says what was found and offers at most one thing to do about it.
    // Everything is bound to the card's state, which the runtime builds from the order itself.
    root: el('Box', { pad: 'md', gap: 'md' }, { children: ['title', 'intro', 'summary', 'quantity', 'accessories', 'fulfilment', 'warranty', 'foot'] }),
    title: el('Text', { text: S('/heading'), variant: 'title' }),
    intro: el('Text', { text: S('/intro'), variant: 'small', tone: 'muted' }, { visible: [S('/intro')] }),
    summary: el('Text', { text: S('/summary'), variant: 'subheading' }),
    ...reviewSection('quantity'),
    ...reviewSection('accessories'),
    ...reviewSection('fulfilment'),
    ...reviewSection('warranty'),
    foot: el('Box', { direction: 'row', gap: 'sm', wrap: true }, { children: ['pay'] }),
    pay: el('Button', { label: S('/payLabel'), variant: 'primary', iconRight: 'chevron-right' }, { on: { press: { action: 'checkout' } } }),
  }),

  comparison: spec('root', {
    root: el('Box', { pad: 'md', gap: 'md' }, { children: ['eyebrow', 'title', 'intro', 'table', 'foot', 'verdict'] }),
    eyebrow: el('Text', { text: 'Side by side', variant: 'eyebrow' }),
    title: el('Text', { text: 'Comparison', variant: 'title' }),
    intro: el('Text', { text: S('/intro'), variant: 'small', tone: 'muted' }, { visible: [S('/intro')] }),
    table: el('Table', { columns: S('/columns'), rows: S('/rows') }),
    // After reading the table, acting on a choice: add either product, or open its full details.
    foot: el('Box', { gap: 'xs' }, { children: ['c-row'], repeat: { statePath: '/products', key: 'sku' } }),
    'c-row': el('Box', { direction: 'row', gap: 'sm', align: 'center', justify: 'between', wrap: true }, { children: ['c-name', 'c-btns'] }),
    'c-name': el('Text', { text: I('title'), variant: 'small', lines: 2, style: { flex: 1, minWidth: 0 } }),
    'c-btns': el('Box', { direction: 'row', gap: 'sm' }, { children: ['c-add', 'c-view'] }),
    'c-add': el('Button', { label: I('addLabel'), variant: 'primary', size: 'sm', icon: 'cart' }, { on: { press: { action: 'addToCart', params: { sku: I('sku'), qty: 1, title: I('title') } } } }),
    'c-view': el('Button', { label: 'Details', variant: 'ghost', size: 'sm' }, { on: { press: { action: 'viewProduct', params: { sku: I('sku') } } } }),
    verdict: el('Alert', { title: 'My take', text: S('/verdict'), tone: 'success', icon: 'spark' }, { visible: [S('/verdict')] }),
  }),

  bundle: spec('root', {
    root: el('Box', { pad: 'md', gap: 'md' }, { children: ['eyebrow', 'title', 'why', 'grid', 'foot'] }),
    eyebrow: el('Text', { text: 'Everything you need', variant: 'eyebrow' }),
    title: el('Text', { text: S('/heading'), variant: 'title' }),
    why: el('Text', { text: S('/why'), variant: 'body', tone: 'muted' }, { visible: [S('/why')] }),
    grid: el('Carousel', { itemWidth: '230px', gap: 'md', label: 'Everything you need' }, { children: ['b-card'], repeat: { statePath: '/items', key: 'sku' } }),
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
    bomLabel: el('Text', { text: S('/linesLabel'), variant: 'label' }, { visible: [S('/linesLabel')] }),
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
    root: el('Box', { pad: 'md', gap: 'lg', maxWidth: '760px' }, { children: ['ok', 'title', 'view', 'meta', 'timeline', 'lines'] }),
    ok: el('Alert', { title: 'Order confirmed', text: S('/statusText'), tone: 'success' }),
    title: el('Text', { text: { $template: 'Order #${/orderRef}' }, variant: 'title' }, { visible: [S('/orderRef')] }),
    // The order itself: items, billing, shipping and the summary, in the side panel.
    view: el('Button', { label: 'See the order details', variant: 'secondary' }, { visible: [S('/orderId')], on: { press: { action: 'openPanel', params: { panel: 'order', orderId: S('/orderId') } } } }),
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
    products: el('Carousel', { itemWidth: '230px', gap: 'md', label: 'Products for this job' }, { children: ['g-card'], repeat: { statePath: '/products', key: 'sku' }, visible: [S('/products')] }),
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
    root: el('Box', { pad: 'md', gap: 'lg' }, { children: ['eyebrow', 'title', 'note', 'groups'] }),
    eyebrow: el('Text', { text: S('/eyebrow'), variant: 'eyebrow' }, { visible: [S('/eyebrow')] }),
    title: el('Text', { text: S('/heading'), variant: 'title' }, { visible: [S('/heading')] }),
    note: el('Text', { text: S('/note'), variant: 'small', tone: 'muted' }, { visible: [S('/note')] }),
    groups: el('Box', { gap: 'lg' }, { children: ['grp'], repeat: { statePath: '/groups', key: 'key' } }),
    grp: el('Box', { gap: 'sm' }, { children: ['gl', 'gh', 'gg'] }),
    gl: el('Text', { text: I('label'), variant: 'heading' }),
    gh: el('Text', { text: I('hint'), variant: 'small', tone: 'muted' }, { visible: [{ $item: 'hint' }] }),
    gg: el('Grid', { minItemWidth: '200px', gap: 'md' }, { children: ['a-card'], repeat: { statePath: { $item: 'items' }, key: 'sku' } }),
    ...productTile('a', { cta: 'addToCart' }),
  }),

  quantity: spec('root', {
    root: el('Card', { pad: 'md', gap: 'md', variant: 'outlined', maxWidth: '640px' }, { children: ['head', 'row', 'working', 'note', 'actions'] }),
    head: el('Text', { text: S('/heading'), variant: 'heading' }, { visible: [S('/heading')] }),
    row: el('Box', { direction: 'row', gap: 'md', align: 'center' }, { children: ['img', 'info', 'big'] }),
    img: el('Image', { src: S('/product/imageUrl'), alt: S('/product/title'), width: '72px', height: '72px', ratio: '1:1', fit: 'contain', radius: 'sm', fallbackIcon: 'box', fallbackSrc: S('/brandLogo') }),
    info: el('Box', { gap: 'xs', flex: 1, minWidth: '0' }, { children: ['title', 'price'] }),
    title: el('Text', { text: S('/product/title'), variant: 'subheading', lines: 2 }),
    price: el('Price', { amount: S('/product/price'), currency: S('/product/currency'), size: 'md', emptyText: 'Price on request' }),
    big: el('Box', { gap: 'xs', align: 'end' }, { children: ['qty', 'unit'] }),
    qty: el('Text', { text: S('/quantity'), variant: 'display' }),
    unit: el('Text', { text: S('/unitLabel'), variant: 'small', tone: 'muted' }, { visible: [S('/unitLabel')] }),
    working: el('Box', { gap: 'xs' }, { children: ['w'], repeat: { statePath: '/working', key: 'label' } }),
    w: el('Box', { direction: 'row', justify: 'between', gap: 'md' }, { children: ['wl', 'wv'] }),
    wl: el('Text', { text: I('label'), variant: 'small', tone: 'muted' }),
    wv: el('Text', { text: I('value'), variant: 'small' }),
    note: el('Text', { text: S('/note'), variant: 'small', tone: 'muted' }, { visible: [S('/note')] }),
    actions: el('Box', { direction: 'row', gap: 'sm', align: 'center' }, { children: ['add'] }),
    add: el('Button', { label: S('/ctaLabel'), variant: 'primary', size: 'md', icon: 'cart' }, {
      on: { press: { action: 'addToCart', params: { sku: S('/product/sku'), qty: S('/quantity'), title: S('/product/title'), confirmed: true } } },
    }),
  }),

  visual: spec('root', {
    root: el('Card', { pad: 'md', gap: 'md', variant: 'outlined', maxWidth: '560px' }, { children: ['head', 'img', 'caption', 'disclaimer', 'products'] }),
    head: el('Text', { text: S('/heading'), variant: 'heading' }, { visible: [S('/heading')] }),
    img: el('Image', { src: S('/imageUrl'), alt: S('/caption'), ratio: '1:1', radius: 'md', fallbackIcon: 'box', fallbackLabel: 'Picture not available' }),
    caption: el('Text', { text: S('/caption'), variant: 'body' }, { visible: [S('/caption')] }),
    disclaimer: el('Box', { direction: 'row', gap: 'xs', align: 'start' }, { children: ['dIcon', 'dText'], visible: [S('/disclaimer')] }),
    dIcon: el('Icon', { name: 'info', size: 'sm', tone: 'muted' }),
    dText: el('Text', { text: S('/disclaimer'), variant: 'small', tone: 'muted', style: { flex: 1, minWidth: 0 } }),
    products: el('Box', { gap: 'xs' }, { children: ['p'], repeat: { statePath: '/products', key: 'sku' }, visible: [S('/products')] }),
    p: el('Button', { label: I('title'), variant: 'ghost', size: 'sm', icon: 'box' }, { on: { press: { action: 'viewProduct', params: { sku: I('sku') } } } }),
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

  confirm: spec('root', {
    root: el('Card', { pad: 'lg', gap: 'md', maxWidth: '560px' }, { children: ['title', 'summary', 'details', 'buttons', 'outcome'] }),
    title: el('Text', { text: S('/heading'), variant: 'heading' }, { visible: [S('/heading')] }),
    summary: el('Text', { text: S('/summary'), variant: 'body' }),
    details: el('Box', { gap: 'xs' }, { children: ['d'], repeat: { statePath: '/details', key: 'label' }, visible: [S('/details')] }),
    d: el('KeyValue', { label: I('label'), value: I('value'), inline: true }),
    buttons: el('Box', { direction: 'row', gap: 'sm', wrap: true }, { children: ['allow', 'deny'], visible: [S('/pending')] }),
    allow: el('Button', { label: S('/allowLabel'), variant: 'primary' }, { on: { press: { action: 'confirmTool', params: { confirmationId: S('/confirmationId'), decision: 'allow' } } } }),
    deny: el('Button', { label: S('/denyLabel'), variant: 'secondary' }, { on: { press: { action: 'confirmTool', params: { confirmationId: S('/confirmationId'), decision: 'deny' } } } }),
    outcome: el('Text', { text: S('/outcome'), variant: 'small', tone: 'muted' }, { visible: [S('/outcome')] }),
  }),

  form: spec('root', {
    root: el('Card', { pad: 'lg', gap: 'md', maxWidth: '560px' }, { children: ['title', 'intro', 'fields', 'sent'] }),
    title: el('Text', { text: S('/title'), variant: 'heading' }),
    intro: el('Text', { text: S('/intro'), variant: 'body' }, { visible: [S('/intro')] }),
    fields: el('Box', { gap: 'xs' }, { children: ['f'], repeat: { statePath: '/fields', key: 'id' } }),
    f: el('KeyValue', { label: I('label'), value: I('type'), inline: true }),
    sent: el('Text', { text: S('/sentText'), variant: 'small', tone: 'muted' }, { visible: [S('/sentText')] }),
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

  action_button_group: spec('root', {
    root: el('Box', { gap: 'sm', pad: 'sm', maxWidth: '600px' }, { children: ['head', 'desc', 'btnList', 'btnListAlt'] }),
    head: el('Text', { text: S('/heading'), variant: 'subheading' }, { visible: [S('/heading')] }),
    desc: el('Text', { text: S('/description'), variant: 'small', tone: 'muted' }, { visible: [S('/description')] }),
    btnList: el('Box', { direction: 'row', gap: 'sm', wrap: true }, {
      children: ['btnItem'],
      repeat: { statePath: '/actions', key: 'id' },
      visible: [S('/actions')],
    }),
    btnItem: el('Button', {
      label: I('label'),
      variant: I('variant'),
    }, {
      on: {
        press: {
          action: 'sendMessage',
          params: { text: I('label'), actionId: I('id') },
        },
      },
    }),
    btnListAlt: el('Box', { direction: 'row', gap: 'sm', wrap: true }, {
      children: ['btnItemAlt'],
      repeat: { statePath: '/buttons', key: 'id' },
      visible: [S('/buttons')],
    }),
    btnItemAlt: el('Button', {
      label: I('label'),
      variant: I('variant'),
    }, {
      on: {
        press: {
          action: 'sendMessage',
          params: { text: I('label'), actionId: I('id') },
        },
      },
    }),
  }),

  order_confirmation: spec('root', {
    root: el('Card', { pad: 'lg', gap: 'md', maxWidth: '640px' }, { children: ['header', 'meta', 'alert', 'linesList', 'foot'] }),
    header: el('Box', { gap: 'xs' }, { children: ['eyebrow', 'title'] }),
    eyebrow: el('Text', { text: 'Order Confirmed', variant: 'eyebrow', tone: 'brand' }),
    title: el('Text', { text: { $template: 'Order #${/orderId}' }, variant: 'title' }),
    meta: el('Box', { direction: 'row', gap: 'md', align: 'center', wrap: true }, { children: ['statusDot', 'date'] }),
    statusDot: el('StatusDot', { label: S('/status'), tone: 'success' }),
    date: el('Text', { text: S('/committedAt'), variant: 'small', tone: 'muted' }, { visible: [S('/committedAt')] }),
    alert: el('Alert', { title: 'Order placed successfully', text: 'Your order has been recorded and is being processed.', tone: 'success', icon: 'check' }),
    linesList: el('Box', { gap: 'sm' }, {
      children: ['lineItem'],
      repeat: { statePath: '/lines', key: 'sku' },
      visible: [S('/lines')],
    }),
    lineItem: el('Box', { direction: 'row', justify: 'between', align: 'center', pad: 'xs' }, {
      children: ['itemTitle', 'itemPrice'],
    }),
    itemTitle: el('Text', { text: I('title'), variant: 'body' }),
    itemPrice: el('Price', { amount: I('lineTotal'), currency: S('/currency'), size: 'sm' }),
    foot: el('Box', { direction: 'row', justify: 'between', align: 'center', pad: 'sm', border: true, radius: 'sm' }, {
      children: ['totalLabel', 'totalPrice'],
      visible: [S('/currency')],
    }),
    totalLabel: el('Text', { text: 'Total', variant: 'heading' }),
    totalPrice: el('Price', { amount: S('/total'), currency: S('/currency'), size: 'lg' }),
  }),
};

export function getDefaultTemplate(cardType: CardType): Spec {
  return DEFAULT_TEMPLATES[cardType];
}
