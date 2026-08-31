const pages = [
  ['Platform', 'platform.html'],
  ['Experience', 'experience.html'],
  ['Solutions', 'solutions.html'],
  ['Customers', 'customers.html'],
  ['Architecture', 'architecture.html'],
  ['Docs', 'docs.html'],
  ['Pricing', 'pricing.html'],
];

function currentFile() {
  const file = window.location.pathname.split('/').pop();
  return file || 'index.html';
}

function wordmark(inverse = true) {
  return `
    <a class="wordmark${inverse ? ' wordmark--inverse' : ''}" href="index.html" aria-label="JourneyAX home">
      <span class="wordmark__mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>Journey<span>AX</span></span>
    </a>`;
}

function headerMarkup() {
  const active = currentFile();
  const links = pages.map(([label, href]) => (
    `<a href="${href}"${active === href ? ' aria-current="page"' : ''}>${label}</a>`
  )).join('');

  return `
    <div class="site-header__inner shell">
      ${wordmark(true)}
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="primary-navigation">
        <span></span><span></span><span></span><span class="sr-only">Open navigation</span>
      </button>
      <nav class="primary-nav" id="primary-navigation" aria-label="Primary navigation">
        ${links}
      </nav>
      <div class="header-actions">
        <a class="text-link" href="docs.html">Sign in</a>
        <a class="button button--small button--outline-on-dark" href="contact.html">Talk to us</a>
        <a class="button button--small button--yellow" href="experience.html">Watch a live journey</a>
      </div>
    </div>`;
}

function footerMarkup() {
  return `
    <div class="footer-cta shell">
      <div>
        <span class="eyebrow eyebrow--dark">Your next customer journey</span>
        <h2>Show us where customers get stuck.</h2>
        <p>We’ll turn it into a conversational, visual and governed experience.</p>
      </div>
      <div class="footer-cta__actions">
        <a class="button button--yellow" href="contact.html">Design my journey <span>↗</span></a>
        <a class="button button--outline-on-dark" href="docs.html">Explore the docs</a>
      </div>
    </div>
    <div class="footer-main shell">
      <div class="footer-brand">
        ${wordmark(true)}
        <p>The AI journey platform for guided, visual and transactable customer experiences.</p>
        <div class="status-pill"><span></span> Platform operational</div>
      </div>
      <div class="footer-links">
        <div><strong>Platform</strong><a href="platform.html">Overview</a><a href="experience.html">Experience Canvas</a><a href="architecture.html">Architecture</a><a href="security.html">Security</a></div>
        <div><strong>Solutions</strong><a href="solutions.html#commerce">Guided commerce</a><a href="solutions.html#configuration">Product configuration</a><a href="solutions.html#service">Customer service</a><a href="solutions.html#assisted">Assisted selling</a></div>
        <div><strong>Resources</strong><a href="customers.html">Customer stories</a><a href="docs.html">Documentation</a><a href="docs.html#releases">Release notes</a><a href="contact.html">Journey workshop</a></div>
        <div><strong>Company</strong><a href="contact.html">About</a><a href="pricing.html">Pricing</a><a href="security.html">Trust center</a><a href="contact.html">Contact</a></div>
      </div>
    </div>
    <div class="footer-legal shell"><span>© 2026 JourneyAX. All rights reserved.</span><div><a href="security.html">Privacy</a><a href="security.html">Terms</a><a href="security.html">Accessibility</a></div></div>`;
}

function initShell() {
  const header = document.querySelector('[data-site-header]');
  const footer = document.querySelector('[data-site-footer]');
  if (header) header.innerHTML = headerMarkup();
  if (footer) footer.innerHTML = footerMarkup();

  const toggle = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.primary-nav');
  toggle?.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    nav?.classList.toggle('primary-nav--open', !open);
    document.body.classList.toggle('menu-open', !open);
  });
}

function initTabs() {
  document.querySelectorAll('[data-tabs]').forEach((tabs) => {
    const buttons = [...tabs.querySelectorAll('[data-tab]')];
    const panels = [...tabs.querySelectorAll('[data-tab-panel]')];
    buttons.forEach((button) => button.addEventListener('click', () => {
      const id = button.getAttribute('data-tab');
      buttons.forEach((item) => {
        const selected = item === button;
        item.classList.toggle('is-active', selected);
        item.setAttribute('aria-selected', String(selected));
      });
      panels.forEach((panel) => panel.classList.toggle('is-active', panel.getAttribute('data-tab-panel') === id));
    }));
  });
}

function initJourneyDemo() {
  const demo = document.querySelector('[data-journey-demo]');
  if (!demo) return;
  const steps = [...demo.querySelectorAll('[data-demo-step]')];
  const scenes = [...demo.querySelectorAll('[data-demo-scene]')];
  let active = 0;
  let timer;

  const select = (index, automatic = false) => {
    active = index;
    steps.forEach((step, i) => step.classList.toggle('is-active', i === index));
    scenes.forEach((scene, i) => scene.classList.toggle('is-active', i === index));
    demo.setAttribute('data-active-step', String(index));
    if (!automatic) restart();
  };
  const restart = () => {
    window.clearInterval(timer);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      timer = window.setInterval(() => select((active + 1) % steps.length, true), 4200);
    }
  };
  steps.forEach((step, i) => step.addEventListener('click', () => select(i)));
  select(0);
}

function initReveal() {
  const items = document.querySelectorAll('[data-reveal]');
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach((item) => item.classList.add('is-visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.14 });
  items.forEach((item) => observer.observe(item));
}

function initAccordions() {
  document.querySelectorAll('.accordion button').forEach((button) => {
    button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      button.closest('.accordion')?.classList.toggle('is-open', !expanded);
    });
  });
}

function initHeaderState() {
  const header = document.querySelector('.site-header');
  const update = () => header?.classList.toggle('site-header--scrolled', window.scrollY > 18);
  update();
  window.addEventListener('scroll', update, { passive: true });
}

document.addEventListener('DOMContentLoaded', () => {
  initShell();
  initTabs();
  initJourneyDemo();
  initReveal();
  initAccordions();
  initHeaderState();
});
