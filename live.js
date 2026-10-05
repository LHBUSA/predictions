// Live pages (freshness pass): while the tab is visible, refresh the live regions of an event page / Insights article
// every 30 s from the canonical event, swap them in place (same server-rendered markup, so no layout shift), and keep
// "x min ago" labels current. Pauses when hidden; never runs when the page has no live source.
(() => {
  const root = document.querySelector('[data-live-src]');
  const POLL_MS = 30000;
  const ago = (iso) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min ago`; };
  const tickAgo = () => document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = ago(el.dataset.ago); });
  tickAgo(); setInterval(() => { if (document.visibilityState === 'visible') tickAgo(); }, 15000);
  if (!root) return;
  let timer = null; let busy = false;
  async function refresh() {
    if (busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const r = await fetch(root.dataset.liveSrc, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      for (const [k, html] of Object.entries(d.regions || {})) {
        if (html === null || html === undefined) continue;
        const el = document.querySelector(`[data-live-region="${k}"]`);
        if (el && el.innerHTML !== html) { el.innerHTML = html; el.dataset.updated = d.at; }
      }
      if (d.atmosphere) { const a = document.querySelector('[data-atmo]'); if (a) a.className = `wx-atmo wx-${d.atmosphere}`; }
      tickAgo();
      const stamp = document.querySelector('[data-live-stamp]');
      if (stamp && d.at) { stamp.dataset.ago = d.at; stamp.textContent = ago(d.at); }
    } catch { /* keep the current render; next tick retries */ } finally { busy = false; }
  }
  const start = () => { if (!timer) timer = setInterval(refresh, POLL_MS); };
  const stop = () => { clearInterval(timer); timer = null; };
  const go = () => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refresh(); start(); } else stop(); });
    if (document.visibilityState === 'visible') start();
  };
  // Event pages: the live route is All Access (private); polling starts only once access.js has loaded the member's
  // intelligence into the page. Anonymous and non-member readers never poll it.
  if (root.hasAttribute('data-event-slug')) { if (window.PBE_INTEL_READY) go(); else document.addEventListener('pbe:intel', go, { once: true }); } else go();
})();
