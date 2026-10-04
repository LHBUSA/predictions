// PropBetEdge Predictions — membership + All Access modules (browser side).
// The browser never decides entitlement: it asks /api/membership (the Worker asks the network authority) and members
// fetch premium data from /api/premium/* (private, no-store). Anonymous pages contain no premium data at all.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const utc = (iso) => (iso ? `${new Date(iso).toISOString().slice(5, 16).replace('T', ' ')}Z` : '—');
  const FREE = { state: 'free', label: 'FREE', entitled: false };

  async function membership() {
    try {
      const r = await fetch('/api/membership', { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) { const b = await r.json(); return { ...FREE, ...(b.membership || {}), authenticated: Boolean(b.authenticated) }; }
    } catch { /* network/authority failure -> FREE */ }
    return { ...FREE, authenticated: false };
  }

  function paintChip(m) {
    const chip = document.getElementById('mem-chip');
    if (!chip) return;
    chip.dataset.state = m.state;
    chip.querySelector('.mem-state').textContent = m.label;
    const action = chip.querySelector('.mem-action');
    if (m.entitled) { action.textContent = ''; chip.removeAttribute('data-pbe-signin'); chip.href = m.manage_url || 'https://propbetedge.ai/pro'; chip.title = m.email ? `Signed in as ${m.email}` : 'All Access active'; }
    else if (m.authenticated) { action.textContent = 'Get All Access'; chip.removeAttribute('data-pbe-signin'); chip.href = 'https://propbetedge.ai/pro'; chip.title = m.email ? `Signed in as ${m.email} — no All Access membership` : ''; }
  }

  function signInDialog() {
    let d = document.getElementById('pbe-signin');
    if (!d) {
      d = document.createElement('dialog');
      d.id = 'pbe-signin'; d.className = 'signin-dialog';
      d.innerHTML = `<form method="dialog" class="signin-form" novalidate>
<h2>Sign in to PropBetEdge</h2><p class="note">All Access members unlock the full Predictions archive with the same account used across all ten sports.</p>
<label for="signin-email">Email</label><input id="signin-email" name="email" type="email" autocomplete="email" required>
<div class="signin-actions"><button type="submit" class="cta-primary">Email me a sign-in link</button><button type="button" class="signin-close" data-close>Close</button></div>
<p class="signin-msg" role="status" aria-live="polite"></p>
<p class="note">No membership yet? <a href="https://propbetedge.ai/pro">All Access — 10 sports + PropBetEdge Predictions, $29/month</a>.</p></form>`;
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

  document.addEventListener('click', (ev) => { const a = ev.target.closest('[data-pbe-signin]'); if (a) { ev.preventDefault(); signInDialog(); } });

  membership().then((m) => {
    window.PBE_MEMBERSHIP = m;
    paintChip(m);
    document.dispatchEvent(new CustomEvent('pbe:membership', { detail: m }));
    if (m.entitled) document.querySelectorAll('[data-prem-body]').forEach((b) => { const box = b.closest('[data-slug]'); if (box) renderArchive(box, box.dataset.slug); });
  });
})();
