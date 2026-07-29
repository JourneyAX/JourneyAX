/**
 * GET /embed.js — the drop-in loader for the JourneyAX agentic-commerce surface (AX).
 *
 * A customer pastes ONE tag onto their e-commerce site:
 *   <script src="https://<storefront>/embed.js" data-project="caroma" async></script>
 *
 * It injects a floating launcher + an iframe of the AX surface in embed mode
 * (?project=<id>&embed=1), themed per project. Attributes (all optional):
 *   data-project   required — which JourneyAX project/tenant
 *   data-label     launcher text (default "Ask our expert")
 *   data-position  "right" | "left" (default right)
 *   data-accent    launcher colour (default #FFD600)
 *   data-greeting-bubble "1" to show a one-time teaser bubble
 */
export const dynamic = "force-static";

export async function GET() {
  const js = `(function () {
  var s = document.currentScript;
  if (!s) { var all = document.getElementsByTagName('script'); s = all[all.length - 1]; }
  var project = (s && s.getAttribute('data-project')) || 'default';
  var label = (s && s.getAttribute('data-label')) || 'Ask our expert';
  var pos = ((s && s.getAttribute('data-position')) || 'right').toLowerCase() === 'left' ? 'left' : 'right';
  var accent = (s && s.getAttribute('data-accent')) || '#FFD600';
  // Derive the storefront origin from THIS script's own URL — reliable behind
  // proxies/CDNs, unlike a server-baked origin. Allow an explicit override.
  var origin = (s && s.getAttribute('data-origin')) || '';
  if (!origin && s && s.src) { try { origin = new URL(s.src).origin; } catch (e) {} }
  if (!origin) origin = window.location.origin;
  var id = 'jax-ax-' + project;
  if (document.getElementById(id)) return; // guard against double-inject

  var open = false;
  var wrap = document.createElement('div');
  wrap.id = id;
  wrap.style.cssText = 'position:fixed;bottom:20px;z-index:2147483000;' + pos + ':20px;font-family:system-ui,-apple-system,sans-serif;';

  // Panel (iframe) — hidden until launched
  var panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;bottom:88px;' + pos + ':20px;width:410px;max-width:calc(100vw - 40px);height:640px;max-height:calc(100vh - 120px);' +
    'background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.28);opacity:0;transform:translateY(12px) scale(.98);' +
    'pointer-events:none;transition:opacity .18s ease, transform .18s ease;';
  var frame = document.createElement('iframe');
  frame.title = 'Agent';
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
  frame.setAttribute('allow', 'clipboard-write');
  panel.appendChild(frame);

  // Launcher button
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.style.cssText = 'display:inline-flex;align-items:center;gap:9px;border:0;cursor:pointer;border-radius:999px;' +
    'padding:13px 20px;font-size:14px;font-weight:700;color:#0A0A0A;background:' + accent + ';box-shadow:0 8px 24px rgba(0,0,0,.22);' +
    'transition:transform .15s ease;';
  btn.onmouseenter = function () { btn.style.transform = 'translateY(-1px)'; };
  btn.onmouseleave = function () { btn.style.transform = 'none'; };
  btn.innerHTML = '<span style="font-size:16px;line-height:1">\\u2197</span><span class="jax-lbl">' + label.replace(/</g,'&lt;') + '</span>';

  function render() {
    if (open) {
      if (!frame.src) frame.src = origin + '/?project=' + encodeURIComponent(project) + '&embed=1';
      panel.style.opacity = '1'; panel.style.transform = 'translateY(0) scale(1)'; panel.style.pointerEvents = 'auto';
      btn.querySelector('.jax-lbl').textContent = 'Close';
      btn.firstChild.textContent = '\\u2715';
    } else {
      panel.style.opacity = '0'; panel.style.transform = 'translateY(12px) scale(.98)'; panel.style.pointerEvents = 'none';
      btn.querySelector('.jax-lbl').textContent = label;
      btn.firstChild.textContent = '\\u2197';
    }
  }
  btn.onclick = function () { open = !open; render(); };

  wrap.appendChild(btn);
  document.body.appendChild(panel);
  document.body.appendChild(wrap);
  render();

  // Let the AX surface ask to close itself (e.g. after checkout hand-off).
  window.addEventListener('message', function (e) {
    if (e.origin === origin && e.data && e.data.type === 'jax:close') { open = false; render(); }
  });
})();`;

  return new Response(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      // The loader is meant to be embedded cross-origin on customer sites.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
