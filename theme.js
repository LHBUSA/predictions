// Theme: Light (default) / Dark / System. Light-first editorial design; dark is an optional research-terminal
// treatment. The choice persists per browser (localStorage, per-viewer convenience only). The head carries a tiny
// inline script (THEME_BOOT) that applies a stored choice before first paint, so there is no flash.
(() => {
  const KEY = 'pbe-theme';
  const ORDER = ['light', 'dark', 'system'];
  const LABEL = { light: 'Light', dark: 'Dark', system: 'System' };
  const ICON = {
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z"/></svg>',
    system: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
  };
  const read = () => { try { const v = localStorage.getItem(KEY); return ORDER.includes(v) ? v : 'light'; } catch { return 'light'; } };
  const effective = (t) => (t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t);
  function apply(t) {
    const root = document.documentElement;
    if (t === 'light') delete root.dataset.theme; else root.dataset.theme = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', effective(t) === 'dark' ? '#0b1522' : '#0e2a4a');
    for (const b of document.querySelectorAll('[data-theme-toggle]')) {
      const next = ORDER[(ORDER.indexOf(t) + 1) % ORDER.length];
      b.innerHTML = `${ICON[t]}<span class="theme-label">${LABEL[t]}</span>`;
      b.setAttribute('aria-label', `Theme: ${LABEL[t]}. Switch to ${LABEL[next]}`);
      b.title = `Theme: ${LABEL[t]} (click for ${LABEL[next]})`;
    }
  }
  function set(t) { try { if (t === 'light') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* per-viewer convenience only */ } apply(t); }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-theme-toggle]');
    if (!b) return;
    ev.preventDefault();
    const cur = read();
    set(ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length]);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (read() === 'system') apply('system'); });
  apply(read());
})();
