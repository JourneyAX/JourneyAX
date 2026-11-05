/** Compare browser origins with the actual HTTP host, not Next's reconstructed internal URL. */
export function isSameOriginRequest(request: Request, configuredOrigin = process.env.STOREFRONT_PUBLIC_ORIGIN): boolean {
  const value = request.headers.get('origin');
  if (!value) return true; // Authenticated service clients do not send browser Origin.
  try {
    const origin = new URL(value);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
    if (configuredOrigin) {
      const configured = new URL(configuredOrigin);
      if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) return false;
      return origin.origin === configured.origin;
    }
    const url = new URL(request.url);
    const host = request.headers.get('host') ?? url.host;
    // Forwarded headers cannot grant an origin permission. Reject malformed or
    // compound Host values rather than letting URL parsing reinterpret them.
    if (!host || /[\s,@/\\?#]/.test(host)) return false;
    const actual = new URL(`${url.protocol}//${host}`);
    if (actual.username || actual.password) return false;
    return origin.origin === actual.origin;
  } catch { return false; }
}
