// PropBetEdge Predictions — membership + All Access (browser side). Predictions is a premium product included with
// PropBetEdge All Access; there is no free tier. The browser never decides entitlement: it asks /api/membership (the
// Worker asks the network authority), and members fetch every piece of intelligence from private, no-store routes
// (/api/premium/*, /api/desk, /api/live/*). Public pages contain no premium data at all.
// Header states: loading "Account" · anonymous "Sign in" + "Get All Access" · signed in "Upgrade" ·
// All Access "ALL ACCESS ACTIVE" · owner "OWNER" · entitlement unverifiable "Access Check" (never shown as unsubscribed).
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const utc = (iso) => (iso ? `${new Date(iso).toISOString().slice(5, 16).replace('T', ' ')}Z` : '—');
  const PRO = 'https://propbetedge.ai/pro';
  // the membership route itself failed: we do not know, so we do not claim the reader is unsubscribed
  const UNVERIFIED = { state: 'unverified', label: 'Access Check', entitled: false, degraded: true };

  async function membership() {
    try {
      const r = await fetch('/api/membership', { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) { const b = await r.json(); if (b?.membership?.state) return { ...b.membership, authenticated: Boolean(b.authenticated) }; }
    } catch { /* network/authority failure -> unverified */ }
    return { ...UNVERIFIED, authenticated: false };
  }

  function paintChip(m) {
    document.documentElement.dataset.acct = m.state;
    const chip = document.getElementById('mem-chip');
    if (!chip) return;
    chip.dataset.state = m.state;
    chip.querySelector('.mem-state').textContent = m.label;
    chip.removeAttribute('data-pbe-signin'); chip.removeAttribute('data-acct-retry'); chip.removeAttribute('title');
    if (m.entitled) { chip.href = m.state === 'owner' ? 'https://propbetedge.ai/' : (m.manage_url || PRO); chip.setAttribute('aria-label', m.state === 'owner' ? 'Owner account' : 'All Access active — manage membership'); if (m.email) chip.title = `Signed in as ${m.email}`; }
    else if (m.state === 'signed_in') { chip.href = PRO; chip.setAttribute('aria-label', 'Upgrade to PropBetEdge All Access'); chip.title = `${m.email ? `Signed in as ${m.email}. ` : ''}Predictions is included with All Access.`; }
    else if (m.state === 'unverified') { chip.href = '#'; chip.setAttribute('data-acct-retry', ''); chip.setAttribute('aria-label', 'Membership could not be verified — check again'); chip.title = 'Your membership could not be verified right now. Click to check again.'; }
    else { chip.href = '#'; chip.setAttribute('data-pbe-signin', ''); chip.setAttribute('aria-label', 'Sign in'); }
  }

  // Gate actions follow the reader's state (All Access / owner: hidden by CSS; the gate itself is replaced).
  function paintGates(m) {
    document.querySelectorAll('[data-gate-cta]').forEach((el) => {
      if (!('base' in el.dataset)) el.dataset.base = el.innerHTML;
      const primary = el.querySelector('.cta-primary')?.outerHTML || `<a class="cta-primary" href="${PRO}">Get All Access</a>`;
      if (m.state === 'unverified') el.innerHTML = '<p class="gate-retry" role="status">We couldn’t verify your membership just now.<button type="button" data-acct-retry>Check again</button></p>';
      else if (m.state === 'signed_in') el.innerHTML = `${primary}<a class="cta-secondary" href="#" data-pbe-signin>Sign in with another account</a>`;
      else el.innerHTML = el.dataset.base;
    });
  }

  function signInDialog() {
    let d = document.getElementById('pbe-signin');
    if (!d) {
      d = document.createElement('dialog');
      d.id = 'pbe-signin'; d.className = 'signin-dialog';
      d.innerHTML = `<form method="dialog" class="signin-form" novalidate>
<h2>Sign in to PropBetEdge</h2><p class="note">PropBetEdge Predictions is included with All Access. Use the same account you use across all ten sports.</p>
<label for="signin-email">Email</label><input id="signin-email" name="email" type="email" autocomplete="email" required>
<div class="signin-actions"><button type="submit" class="cta-primary">Email me a sign-in link</button><button type="button" class="signin-close" data-close>Close</button></div>
<p class="signin-msg" role="status" aria-live="polite"></p>
<p class="note">No membership yet? <a href="${PRO}">Get All Access — 10 sports + PropBetEdge Predictions, $29/month</a>.</p></form>`;
      document.body.appendChild(d);
      d.querySelector('[data-close]').addEventListener('click', () => d.close());
      d.querySelector('form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const email = d.querySelector('#signin-email').value.trim();
        const msg = d.querySelector('.signin-msg');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Enter a valid email address.'; return; }
        msg.textContent = 'Sending…';
        try {
          const r = await fetch('https://auth.propbetedge.ai/magic/request', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, return_to: location.href.split('#')[0] }) });
          const b = await r.json().catch(() => ({}));
          msg.textContent = r.ok ? 'Check your inbox: if this email belongs to a PropBetEdge member, a sign-in link is on its way.' : (b.error || 'Sign-in is unavailable right now. Please try again shortly.');
        } catch { msg.textContent = 'Sign-in is unavailable right now. Please try again shortly.'; }
      });
    }
    d.showModal();
  }

  function stepChart(o) {
    const pts = o.history.map((h) => [Date.parse(h.t), h.pct]); const mk = o.market_path.filter((m) => m.pct !== null).map((m) => [Date.parse(m.t), m.pct]);
    const all = [...pts, ...mk]; if (all.length < 2) return '';
    const t0 = Math.min(...all.map((p) => p[0])); const t1 = Math.max(...all.map((p) => p[0])); const W = 640; const H = 200;
    const x = (t) => 36 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 48); const y = (v) => 10 + (1 - v / 100) * (H - 34);
    const path = (ps) => ps.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}${i < ps.length - 1 ? ` H${x(ps[i + 1][0]).toFixed(1)}` : ''}`).join(' ');
    const grid = [0, 50, 100].map((v) => `<line x1="36" x2="${W - 12}" y1="${y(v)}" y2="${y(v)}" stroke="#e9eff6"/><text x="4" y="${y(v) + 4}" font-size="11" fill="#5d7288">${v}%</text>`).join('');
    return `<div class="ix-scroll"><svg viewBox="0 0 ${W} ${H}" class="ix-svg" role="img" aria-label="Complete PBE and market path for ${esc(o.label)}">${grid}${mk.length > 1 ? `<path d="${path(mk)}" fill="none" stroke="#8a9db1" stroke-width="2" stroke-dasharray="4 4"/>` : ''}${pts.length ? `<path d="${path([...pts, [t1, pts.at(-1)[1]]])}" fill="none" stroke="#1f63b5" stroke-width="2.5"/>` : ''}${pts.map(([t, v]) => `<circle cx="${x(t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="#1f63b5"/>`).join('')}<text x="36" y="${H - 6}" font-size="11" fill="#5d7288">${utc(new Date(t0).toISOString())}</text><text x="${W - 12}" y="${H - 6}" font-size="11" fill="#5d7288" text-anchor="end">${utc(new Date(t1).toISOString())}</text></svg></div>
<div class="legend"><span><i style="background:#1f63b5"></i>PBE (every immutable snapshot)</span><span><i style="background:#8a9db1"></i>Kalshi mid (every stored observation)</span></div>`;
  }

  async function renderArchive(box, slug) {
    const body = box.querySelector('[data-prem-body]'); const lock = box.querySelector('[data-prem-lock]');
    try {
      const r = await fetch(`/api/premium/event/${encodeURIComponent(slug)}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return; // stays locked: the server said no
      const rec = await r.json();
      const outs = rec.outcomes.filter((o) => o.history.length);
      const head = [...outs].sort((a, b) => Math.abs(b.divergence_pts ?? 0) - Math.abs(a.divergence_pts ?? 0))[0];
      body.innerHTML = `<p class="prem-active">ALL ACCESS · full archive · <a href="/api/premium/event/${encodeURIComponent(slug)}.csv">Download CSV</a></p>
${head ? `<h3>Complete path — ${esc(head.label)}</h3>${stepChart(head)}` : ''}
${outs.map((o) => `<details class="snap"><summary>${esc(o.label)} — ${o.history.length} snapshots · ${o.market_path.length} market observations</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Published</th><th>PBE</th><th>Market then</th><th>Model</th><th>Data cutoff</th><th>Scoring role</th><th>What changed</th></tr></thead><tbody>${o.history.map((h) => `<tr><td class="num">${utc(h.t)}</td><td class="num"><b>${h.pct}%</b></td><td class="num">${h.market_pct ?? '—'}${h.market_pct !== null ? '%' : ''}</td><td>${esc(h.model)}</td><td class="num">${utc(h.cutoff)}</td><td>${esc(h.roles.join(', ').replace(/_/g, ' ').toLowerCase())}</td><td>${esc((h.changed || []).slice(0, 4).map((c) => `${c.feature}: ${typeof c.from === 'object' ? '…' : c.from} → ${typeof c.to === 'object' ? '…' : c.to}`).join('; '))}</td></tr>`).join('')}</tbody></table></div></details>`).join('')}`;
      body.hidden = false; if (lock) lock.hidden = true;
    } catch { /* stays locked */ }
  }
  const renderArchives = () => document.querySelectorAll('[data-prem-body]').forEach((b) => { const box = b.closest('[data-slug]'); if (box && !box.dataset.loaded) { box.dataset.loaded = '1'; renderArchive(box, box.dataset.slug); } });

  // Event page (members): the intelligence comes from the private event-page route and replaces the gate in place.
  async function loadEventIntel() {
    const root = document.querySelector('main[data-event-slug]');
    const slot = document.querySelector('[data-prem-intel]');
    if (!root || !slot || slot.dataset.loaded) return;
    try {
      const r = await fetch(`/api/premium/event-page/${encodeURIComponent(root.dataset.eventSlug)}`, { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 503) { paint({ ...UNVERIFIED, authenticated: true }); return; }
      if (!r.ok) return; // the gate stays: the server said no
      const d = await r.json();
      slot.dataset.loaded = '1'; slot.innerHTML = d.main;
      const aside = document.querySelector('[data-prem-aside]'); if (aside) aside.innerHTML = d.aside;
      renderArchives();
      if (d.multi_venue) import('/multivenue.js?v=20261004mv4').catch((e) => console.warn('multi-venue', e));
      window.PBE_INTEL_READY = true;
      document.dispatchEvent(new CustomEvent('pbe:intel'));
    } catch { /* the gate stays */ }
  }

  function paint(m) {
    window.PBE_MEMBERSHIP = m;
    paintChip(m); paintGates(m);
  }

  async function resolve() {
    const m = await membership();
    paint(m);
    document.dispatchEvent(new CustomEvent('pbe:membership', { detail: m }));
    if (m.entitled) { loadEventIntel(); renderArchives(); }
  }

  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-pbe-signin]'); if (a) { ev.preventDefault(); signInDialog(); return; }
    const retry = ev.target.closest('[data-acct-retry]'); if (retry) { ev.preventDefault(); resolve(); }
  });

  resolve();
})();
