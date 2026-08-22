// ═══════════════════════════════════════════════════════════════════════
// Language.
//
// "Multilingual" in a shopping journey means two different things, and
// conflating them is the usual mistake:
//
//   1. The assistant *replies* in the shopper's language. That is a prompt
//      instruction and costs nothing.
//   2. The *panel* speaks it too. That is this file. A journey that answers
//      in Hindi while every button stays in English is not multilingual;
//      it is an English product with a translation layer bolted on the
//      chat bubble.
//
// So the language lives in journey state, not in the chat, and every panel
// reads from it. Switching language mid-journey must not reset anything —
// that is the "one continuous journey" requirement, and it is why language
// is state rather than a route or a reload.
//
// Only strings that appear in the apparel panels are here. Adding a language
// means adding one object; a missing key falls back to English rather than
// rendering blank, because a half-translated panel should degrade to
// readable, not to broken.
// ═══════════════════════════════════════════════════════════════════════

export type LanguageCode = 'en' | 'hi' | 'es' | 'fr' | 'de';

export interface LanguageOption {
  code: LanguageCode;
  /** The language's name in that language — never translated. */
  label: string;
  /** What to tell the model to reply in. */
  promptName: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'en', label: 'English', promptName: 'English' },
  { code: 'hi', label: 'हिन्दी', promptName: 'Hindi' },
  { code: 'es', label: 'Español', promptName: 'Spanish' },
  { code: 'fr', label: 'Français', promptName: 'French' },
  { code: 'de', label: 'Deutsch', promptName: 'German' },
];

export function isLanguageCode(value: string): value is LanguageCode {
  return LANGUAGES.some(l => l.code === value);
}

export function promptNameFor(code: LanguageCode): string {
  return LANGUAGES.find(l => l.code === code)?.promptName ?? 'English';
}

type Dict = Record<string, string>;

const en: Dict = {
  'lang.label': 'Language',

  'bag.eyebrow': 'Your bag',
  'bag.heading': 'Everything you have chosen',
  'bag.desc': 'Sizes stay with each item. Change anything here — nothing is ordered yet.',
  'bag.empty': 'Your bag is empty. Tell me what you are looking for and I will find it.',
  'bag.size': 'Size',
  'bag.needsSize': 'Needs a size',
  'bag.sizeThis': 'Check my size',
  'bag.remove': 'Remove',
  'bag.qty': 'Quantity',
  'bag.subtotal': 'Subtotal',
  'bag.items': 'items',
  'bag.checkout': 'Place order',
  'bag.blocked': 'One item still needs a size before you can order.',
  'bag.blockedPlural': 'Some items still need a size before you can order.',

  'tryon.eyebrow': 'Virtual try-on',
  'tryon.heading': 'See it before you decide',
  'tryon.desc': 'This shows how the garment sits at the size you chose.',
  'tryon.sizeShown': 'Showing size',
  'tryon.disclaimer':
    'This is a visual guide, not a fit measurement. Your size comes from the Fit Advisor.',
  'tryon.keep': 'Looks right — keep this size',
  'tryon.resize': 'Try a different size',

  'return.eyebrow': 'Returns and exchanges',
  'return.heading': 'What would you like to send back?',
  'return.desc': 'Choose the item, then tell me what went wrong.',
  'return.chooseReason': 'Why is it going back?',
  'return.reason.tooSmall': 'Too small',
  'return.reason.tooLarge': 'Too big',
  'return.reason.style': 'Not the style I wanted',
  'return.reason.quality': 'Quality was not right',
  'return.reason.other': 'Another reason',
  'return.refund': 'Refund me',
  'return.exchange': 'Send the next size',
  'return.resolved': 'Return arranged',
  'return.learned': 'I have noted this for your next size recommendation.',
  'return.notLearned': 'Noted. This one does not change your size recommendation.',
  'return.nothingToReturn': 'There is nothing to return yet.',
  'return.exchangeFor': 'Exchanging for size',
};

const hi: Dict = {
  'lang.label': 'भाषा',

  'bag.eyebrow': 'आपका बैग',
  'bag.heading': 'आपने जो चुना है',
  'bag.desc': 'हर वस्तु के साथ उसका साइज़ रहता है। यहाँ कुछ भी बदलें — अभी ऑर्डर नहीं हुआ है।',
  'bag.empty': 'आपका बैग खाली है। बताइए आपको क्या चाहिए, मैं ढूँढ देता हूँ।',
  'bag.size': 'साइज़',
  'bag.needsSize': 'साइज़ चाहिए',
  'bag.sizeThis': 'मेरा साइज़ देखें',
  'bag.remove': 'हटाएँ',
  'bag.qty': 'मात्रा',
  'bag.subtotal': 'कुल',
  'bag.items': 'वस्तुएँ',
  'bag.checkout': 'ऑर्डर करें',
  'bag.blocked': 'ऑर्डर करने से पहले एक वस्तु का साइज़ चुनना बाकी है।',
  'bag.blockedPlural': 'ऑर्डर करने से पहले कुछ वस्तुओं का साइज़ चुनना बाकी है।',

  'tryon.eyebrow': 'वर्चुअल ट्राई-ऑन',
  'tryon.heading': 'तय करने से पहले देखिए',
  'tryon.desc': 'आपने जो साइज़ चुना है, कपड़ा उस पर कैसा बैठता है।',
  'tryon.sizeShown': 'दिखाया जा रहा साइज़',
  'tryon.disclaimer':
    'यह केवल दृश्य मार्गदर्शन है, नाप नहीं। आपका साइज़ फ़िट सलाहकार से आता है।',
  'tryon.keep': 'ठीक लग रहा है — यही साइज़ रखें',
  'tryon.resize': 'दूसरा साइज़ आज़माएँ',

  'return.eyebrow': 'वापसी और बदलाव',
  'return.heading': 'आप क्या वापस भेजना चाहते हैं?',
  'return.desc': 'वस्तु चुनिए, फिर बताइए क्या दिक्कत हुई।',
  'return.chooseReason': 'वापस क्यों भेज रहे हैं?',
  'return.reason.tooSmall': 'बहुत छोटा',
  'return.reason.tooLarge': 'बहुत बड़ा',
  'return.reason.style': 'यह स्टाइल पसंद नहीं आई',
  'return.reason.quality': 'गुणवत्ता ठीक नहीं थी',
  'return.reason.other': 'कोई और कारण',
  'return.refund': 'पैसे वापस करें',
  'return.exchange': 'अगला साइज़ भेजें',
  'return.resolved': 'वापसी तय हो गई',
  'return.learned': 'अगली बार साइज़ बताते समय मैं इसका ध्यान रखूँगा।',
  'return.notLearned': 'ठीक है। इससे आपका साइज़ सुझाव नहीं बदलेगा।',
  'return.nothingToReturn': 'अभी वापस करने के लिए कुछ नहीं है।',
  'return.exchangeFor': 'बदलकर भेजा जाएगा साइज़',
};

const es: Dict = {
  'lang.label': 'Idioma',

  'bag.eyebrow': 'Tu bolsa',
  'bag.heading': 'Todo lo que has elegido',
  'bag.desc': 'Cada artículo conserva su talla. Cambia lo que quieras — aún no se ha pedido nada.',
  'bag.empty': 'Tu bolsa está vacía. Dime qué buscas y lo encuentro.',
  'bag.size': 'Talla',
  'bag.needsSize': 'Falta la talla',
  'bag.sizeThis': 'Ver mi talla',
  'bag.remove': 'Quitar',
  'bag.qty': 'Cantidad',
  'bag.subtotal': 'Subtotal',
  'bag.items': 'artículos',
  'bag.checkout': 'Realizar pedido',
  'bag.blocked': 'Un artículo todavía necesita talla antes de pedir.',
  'bag.blockedPlural': 'Algunos artículos todavía necesitan talla antes de pedir.',

  'tryon.eyebrow': 'Prueba virtual',
  'tryon.heading': 'Míralo antes de decidir',
  'tryon.desc': 'Así queda la prenda en la talla que has elegido.',
  'tryon.sizeShown': 'Mostrando talla',
  'tryon.disclaimer':
    'Es una guía visual, no una medida de talla. Tu talla viene del Asesor de Tallas.',
  'tryon.keep': 'Se ve bien — me quedo con esta talla',
  'tryon.resize': 'Probar otra talla',

  'return.eyebrow': 'Devoluciones y cambios',
  'return.heading': '¿Qué quieres devolver?',
  'return.desc': 'Elige el artículo y dime qué ha pasado.',
  'return.chooseReason': '¿Por qué lo devuelves?',
  'return.reason.tooSmall': 'Demasiado pequeño',
  'return.reason.tooLarge': 'Demasiado grande',
  'return.reason.style': 'No es el estilo que quería',
  'return.reason.quality': 'La calidad no era la adecuada',
  'return.reason.other': 'Otro motivo',
  'return.refund': 'Devolver el dinero',
  'return.exchange': 'Enviar la siguiente talla',
  'return.resolved': 'Devolución gestionada',
  'return.learned': 'Lo tendré en cuenta en tu próxima recomendación de talla.',
  'return.notLearned': 'Anotado. Esto no cambia tu recomendación de talla.',
  'return.nothingToReturn': 'Todavía no hay nada que devolver.',
  'return.exchangeFor': 'Cambio por la talla',
};

const fr: Dict = {
  'lang.label': 'Langue',

  'bag.eyebrow': 'Votre panier',
  'bag.heading': 'Tout ce que vous avez choisi',
  'bag.desc': 'Chaque article garde sa taille. Modifiez ce que vous voulez — rien n’est encore commandé.',
  'bag.empty': 'Votre panier est vide. Dites-moi ce que vous cherchez et je le trouve.',
  'bag.size': 'Taille',
  'bag.needsSize': 'Taille manquante',
  'bag.sizeThis': 'Voir ma taille',
  'bag.remove': 'Retirer',
  'bag.qty': 'Quantité',
  'bag.subtotal': 'Sous-total',
  'bag.items': 'articles',
  'bag.checkout': 'Commander',
  'bag.blocked': 'Un article a encore besoin d’une taille avant de commander.',
  'bag.blockedPlural': 'Certains articles ont encore besoin d’une taille avant de commander.',

  'tryon.eyebrow': 'Essayage virtuel',
  'tryon.heading': 'Voyez-le avant de décider',
  'tryon.desc': 'Voici le tombé du vêtement dans la taille choisie.',
  'tryon.sizeShown': 'Taille affichée',
  'tryon.disclaimer':
    'Ceci est un aperçu visuel, pas une mesure. Votre taille vient du Conseiller Taille.',
  'tryon.keep': 'Ça me va — je garde cette taille',
  'tryon.resize': 'Essayer une autre taille',

  'return.eyebrow': 'Retours et échanges',
  'return.heading': 'Que souhaitez-vous renvoyer ?',
  'return.desc': 'Choisissez l’article, puis dites-moi ce qui n’allait pas.',
  'return.chooseReason': 'Pourquoi le renvoyez-vous ?',
  'return.reason.tooSmall': 'Trop petit',
  'return.reason.tooLarge': 'Trop grand',
  'return.reason.style': 'Ce n’est pas le style voulu',
  'return.reason.quality': 'La qualité n’était pas au rendez-vous',
  'return.reason.other': 'Une autre raison',
  'return.refund': 'Me rembourser',
  'return.exchange': 'Envoyer la taille suivante',
  'return.resolved': 'Retour organisé',
  'return.learned': 'J’en tiendrai compte pour votre prochaine recommandation de taille.',
  'return.notLearned': 'Noté. Cela ne change pas votre recommandation de taille.',
  'return.nothingToReturn': 'Il n’y a rien à retourner pour l’instant.',
  'return.exchangeFor': 'Échange pour la taille',
};

const de: Dict = {
  'lang.label': 'Sprache',

  'bag.eyebrow': 'Ihre Tasche',
  'bag.heading': 'Alles, was Sie gewählt haben',
  'bag.desc': 'Jeder Artikel behält seine Größe. Ändern Sie hier alles — noch ist nichts bestellt.',
  'bag.empty': 'Ihre Tasche ist leer. Sagen Sie mir, was Sie suchen, und ich finde es.',
  'bag.size': 'Größe',
  'bag.needsSize': 'Größe fehlt',
  'bag.sizeThis': 'Meine Größe prüfen',
  'bag.remove': 'Entfernen',
  'bag.qty': 'Menge',
  'bag.subtotal': 'Zwischensumme',
  'bag.items': 'Artikel',
  'bag.checkout': 'Bestellung aufgeben',
  'bag.blocked': 'Ein Artikel braucht noch eine Größe, bevor Sie bestellen können.',
  'bag.blockedPlural': 'Einige Artikel brauchen noch eine Größe, bevor Sie bestellen können.',

  'tryon.eyebrow': 'Virtuelle Anprobe',
  'tryon.heading': 'Sehen Sie es, bevor Sie sich entscheiden',
  'tryon.desc': 'So sitzt das Kleidungsstück in der gewählten Größe.',
  'tryon.sizeShown': 'Gezeigte Größe',
  'tryon.disclaimer':
    'Dies ist eine visuelle Orientierung, keine Maßangabe. Ihre Größe kommt vom Größenberater.',
  'tryon.keep': 'Sieht gut aus — diese Größe behalten',
  'tryon.resize': 'Andere Größe probieren',

  'return.eyebrow': 'Rückgabe und Umtausch',
  'return.heading': 'Was möchten Sie zurücksenden?',
  'return.desc': 'Wählen Sie den Artikel und sagen Sie mir, was nicht gepasst hat.',
  'return.chooseReason': 'Warum geht er zurück?',
  'return.reason.tooSmall': 'Zu klein',
  'return.reason.tooLarge': 'Zu groß',
  'return.reason.style': 'Nicht der gewünschte Stil',
  'return.reason.quality': 'Die Qualität stimmte nicht',
  'return.reason.other': 'Ein anderer Grund',
  'return.refund': 'Geld zurück',
  'return.exchange': 'Nächste Größe senden',
  'return.resolved': 'Rücksendung veranlasst',
  'return.learned': 'Ich merke mir das für Ihre nächste Größenempfehlung.',
  'return.notLearned': 'Notiert. Das ändert Ihre Größenempfehlung nicht.',
  'return.nothingToReturn': 'Es gibt noch nichts zurückzugeben.',
  'return.exchangeFor': 'Umtausch in Größe',
};

const DICTS: Record<LanguageCode, Dict> = { en, hi, es, fr, de };

/**
 * Look up a string. Falls back to English, then to the key itself, so a
 * missing translation shows readable English rather than an empty button.
 */
export function translate(lang: LanguageCode, key: string): string {
  return DICTS[lang]?.[key] ?? en[key] ?? key;
}

/** Curried form, for panels that resolve many keys. */
export function translator(lang: LanguageCode) {
  return (key: string) => translate(lang, key);
}
