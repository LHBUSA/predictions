// Dedicated metal research views. One public/member /api/metals contract; no independent quote fetch or licensing bypass.
// Pure quotePresentation is exported for deterministic tests. All source-derived text enters the DOM via textContent.
export const METAL_PAGES = Object.freeze({
  gold: Object.freeze({ metal: 'GOLD', code: 'XAU', etf: 'GLD' }),
  silver: Object.freeze({ metal: 'SILVER', code: 'XAG', etf: 'SLV' }),
  platinum: Object.freeze({ metal: 'PLATINUM', code: 'XPT', etf: 'PPLT' })
});
const number = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const money = (n) => n === null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => n === null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n * 100).toFixed(2) + '%';
const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const displaySession = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31
    ? month[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : '—';
};
export function metalDetail(payload, slug) {
  const c = METAL_PAGES[slug];
  if (!c || payload?.contract !== 'metals/1' || !Array.isArray(payload.spot) || !Array.isArray(payload.etfs)) return null;
  const spot = payload.spot.find((x) => x?.metal === c.metal && x?.code === c.code && x.kind === 'SPOT');
  const etf = payload.etfs.find((x) => x?.metal === c.metal && x?.symbol === c.etf && x.kind === 'ETF');
  if (!spot || !etf) return null;
  return { c, spot, etf };
}
export function quotePresentation(payload, slug) {
  const match = metalDetail(payload, slug);
  if (!match) return null;
  const { spot, etf } = match;
  const rights = payload.rights || {};
  const spotQ = spot.quote || {};
  const spotCleared = rights.spot?.state === 'CLEARED' && spotQ.state !== 'SOURCE_RIGHTS_HOLD'
    && number(spotQ.value) !== null && spotQ.value > 0 && !!spotQ.observed_at && !!spotQ.source
    && spotQ.unit === 'USD/ozt' && spotQ.currency === 'USD';
  const spotView = spotCleared
    ? { price: money(spotQ.value), status: 'SOURCE-VERIFIED SPOT OBSERVATION', note: 'USD per troy ounce · source ' + spotQ.source, observed: spotQ.observed_at }
    : { price: '—', status: 'QUOTE UNAVAILABLE · SOURCE RIGHTS HOLD', note: rights.spot?.note || 'No licensed spot metal price may be displayed.', observed: null };
  const eq = etf.quote || {};
  const rightsMatch = payload.audience === 'member' ? eq.rights_scope === 'PAID' : eq.rights_scope === 'PUBLIC';
  const etfCleared = rights.etf?.state === 'CLEARED' && rightsMatch && eq.state === 'NEXT_DAY'
    && number(eq.value) !== null && eq.value > 0 && !!eq.session_date
    && eq.source === 'IEX Historical Data (TOPS)' && eq.unit === 'USD/share' && eq.currency === 'USD';
  let etfView;
  if (etfCleared) {
    const prior = eq.previous;
    const change = number(eq.change_pct);
    const hasPrior = change !== null && number(prior?.value) !== null && prior.value > 0 && displaySession(prior.session_date) !== '—';
    etfView = { price: money(eq.value), status: 'IEX NEXT-DAY · ' + displaySession(eq.session_date) + ' SESSION',
      note: 'IEX-venue last sale; not consolidated and not a spot metal price.', observed: eq.observed_at || null,
      change: hasPrior ? pct(change) + ' vs ' + displaySession(prior.session_date) : null };
  } else {
    etfView = { price: '—', status: rights.etf?.state !== 'CLEARED' ? 'PRICE WITHHELD · SOURCE RIGHTS HOLD'
      : 'AWAITING FIRST IEX OBSERVATION', note: 'ETF shares are not spot bullion. No supported price observation to display.', observed: null, change: null };
  }
  return { spot: spotView, etf: etfView, instrument: etf, sleeve: payload.audience === 'member' ? payload.diversified_sleeve ?? null : null };
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value ?? '—');
}
function observationTime(iso) {
  if (!iso) return 'No source observation on file';
  const dt = new Date(iso);
  if (!Number.isFinite(dt.getTime())) return 'No valid observation time on file';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(dt) + ' UTC';
}
function show(payload, slug) {
  const v = quotePresentation(payload, slug);
  if (!v) throw new Error('Contract missing or unsupported metal identity');
  setText('md-data-status', 'SOURCE RECORD LOADED · ' + (payload.audience === 'member' ? 'ALL ACCESS' : 'PUBLIC'));
  setText('md-spot-price', v.spot.price);
  setText('md-spot-state', v.spot.status);
  setText('md-spot-info', v.spot.note);
  setText('md-spot-time', observationTime(v.spot.observed));
  setText('md-etf-price', v.etf.price);
  setText('md-etf-state', v.etf.status);
  setText('md-etf-info', v.etf.note);
  setText('md-etf-time', observationTime(v.etf.observed));
  const movement = document.getElementById('md-etf-move');
  if (movement) {
    movement.hidden = !v.etf.change;
    movement.textContent = v.etf.change || '';
    movement.classList.remove('md-up', 'md-down');
    if (v.etf.change?.startsWith('+')) movement.classList.add('md-up');
    if (v.etf.change?.startsWith('−')) movement.classList.add('md-down');
  }
  setText('md-etf-name', v.instrument.label);
  setText('md-issuer', v.instrument.sponsor);
  setText('md-legal', v.instrument.legal_name);
  setText('md-fee', number(v.instrument.expense_ratio) !== null ? (v.instrument.expense_ratio * 100).toFixed(2) + '% / year' : '—');
  setText('md-benchmark', v.instrument.nav_basis || '—');
  setText('md-listed', displaySession(v.instrument.listed_on));
  setText('md-splits', Array.isArray(v.instrument.splits) && v.instrument.splits.length
    ? v.instrument.splits.map((x) => x.ratio + '-for-1 · ' + displaySession(x.d)).join('; ') : 'None recorded in the verified registry');
  const edgar = document.getElementById('md-edgar');
  if (edgar && /^\d{10}$/.test(String(v.instrument.sec_cik || ''))) {
    edgar.href = 'https://www.sec.gov/edgar/browse/?CIK=' + v.instrument.sec_cik;
    edgar.textContent = 'SEC filing record ↗';
    edgar.hidden = false;
  }
  const sv = v.sleeve;
  const candidate = sv?.candidates?.find((c) => c.symbol === v.instrument.symbol);
  const held = sv?.holdings?.find((h) => h.symbol === v.instrument.symbol);
  const memberBox = document.getElementById('md-member-research');
  if (sv && memberBox) {
    memberBox.hidden = false;
    setText('md-sleeve-asof', sv.as_of ? 'As of ' + displaySession(sv.as_of) : 'Awaiting prospective cohort start');
    setText('md-sleeve-status', !candidate ? 'NOT YET EVALUATED' : candidate.verified ? 'ELIGIBLE REGISTRY + HISTORY' : 'HELD · ' + (candidate.hold || 'not verified'));
    setText('md-sleeve-trend', candidate?.above_sma200 == null ? '—' : candidate.above_sma200 ? 'Above 200-day reference' : 'Below 200-day reference');
    setText('md-sleeve-weight', number(held?.weight) !== null ? (held.weight * 100).toFixed(1) + '% of simulated NAV' : 'No held position recorded');
    setText('md-sleeve-cap', number(sv.cap) !== null ? (sv.cap * 100).toFixed(0) + '% combined metals cap' : 'Cap unavailable');
  }
  setText('md-source-foot', 'IEX HIST is exchange-specific and published the next day. Last recorded source data, not a live quote. This page uses the same /api/metals feed as the overview.');
}
async function refresh(slug) {
  const b = document.getElementById('md-refresh');
  if (b) b.disabled = true;
  setText('md-data-status', 'CHECKING PERMITTED SOURCES…');
  try {
    const response = await fetch('/api/metals', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Source endpoint unavailable');
    show(await response.json(), slug);
  } catch {
    setText('md-data-status', 'SOURCE RECORD UNAVAILABLE · NO PRICE ESTIMATED');
    setText('md-etf-state', 'SOURCE RECORD UNAVAILABLE');
    setText('md-etf-price', '—');
    setText('md-spot-price', '—');
    setText('md-etf-move', '');
    const change = document.getElementById('md-etf-move');
    if (change) change.hidden = true;
  } finally {
    if (b) b.disabled = false;
  }
}
if (typeof document !== 'undefined') {
  const slug = document.body?.dataset?.metal;
  if (METAL_PAGES[slug]) {
    document.getElementById('md-refresh')?.addEventListener('click', () => refresh(slug));
    refresh(slug);
  }
}
