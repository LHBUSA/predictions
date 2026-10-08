// PRIVATE CPI V1 SHADOW report (GET /admin/cpi/shadow, ADMIN_TOKEN or DIAGNOSTICS_TOKEN). Read-only.
// PBE-only scoring of prospective runs. Market prices are deliberately absent: any venue benchmark is a separate,
// later comparison on timestamp-compatible prices and never feeds the model or this score.
import { calendarHorizon, CALENDAR_VERSION, KNOWN_INPUT_GAPS, RELEASE_DATES, releaseFor } from '../../../src/macro/cpi/calendar.js';
import { SHADOW_MODEL_ID, SHADOW_TARGETS } from '../../../src/macro/cpi/shadow.js';

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function reliability(pairs, bins = 10) {
  const b = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, p: 0, o: 0 }));
  for (const { p, o } of pairs) { const k = Math.min(bins - 1, Math.floor(p * bins)); b[k].n += 1; b[k].p += p; b[k].o += o; }
  return b.filter((x) => x.n).map((x) => ({ bin: `${x.lo.toFixed(1)}-${x.hi.toFixed(1)}`, n: x.n, mean_p: x.p / x.n, freq: x.o / x.n }));
}

export function summarize(runs, grades, { now }) {
  const gBy = new Map(grades.map((g) => [g.run_id, g]));
  const rows = runs.map((r) => {
    const g = gBy.get(r.run_id) || null;
    return {
      run_id: r.run_id, target: r.target, kalshi_series: r.kalshi_series, reference_month: r.reference_month, status: r.status, reason: r.reason,
      forecast_created_at: r.forecast_created_at, cutoff_at: r.cutoff_at, release_at: r.release_at,
      median: r.median === null ? null : Number(r.median), interval_80: r.q10 === null ? null : [Number(r.q10), Number(r.q90)],
      ladder: r.ladder, contracts: r.contracts, detail: r.status === 'OK' ? null : r.detail,
      actual: g ? Number(g.actual_value) : null,
      brier: g ? g.scores.brier : null, log_loss: g ? g.scores.log_loss : null, rps: g ? g.scores.rps : null, in_80: g ? g.scores.in_80 : null,
      kalshi_cross_check: g ? g.kalshi_cross_check : null,
    };
  }).sort((a, b) => b.reference_month.localeCompare(a.reference_month) || a.target.localeCompare(b.target));
  const byTarget = {};
  for (const t of SHADOW_TARGETS) {
    const tr = runs.filter((r) => r.target === t);
    const tg = tr.map((r) => gBy.get(r.run_id)).filter(Boolean);
    const pairs = tg.flatMap((g) => (g.scores.pairs || []).map(({ p, o }) => ({ p, o })));
    byTarget[t] = {
      runs: tr.length, ok: tr.filter((r) => r.status === 'OK').length, no_forecast: tr.filter((r) => r.status !== 'OK').length,
      prospective_observations: tg.length,
      mean_brier: mean(tg.map((g) => g.scores.brier)), mean_log_loss: mean(tg.map((g) => g.scores.log_loss)), mean_rps: mean(tg.map((g) => g.scores.rps)),
      mean_abs_error_median: mean(tg.map((g) => g.scores.abs_error_median)), interval_80_coverage: mean(tg.map((g) => (g.scores.in_80 ? 1 : 0))),
      calibration: reliability(pairs), pit: tg.map((g) => [g.scores.pit_low, g.scores.pit_high]),
    };
  }
  const horizon = calendarHorizon();
  const horizonRelease = releaseFor(horizon);
  const daysLeft = (Date.parse(horizonRelease.releaseAt) - Date.parse(now)) / 86400000;
  return {
    model: SHADOW_MODEL_ID, state: 'SHADOW', public: false, now,
    promotion: 'Not evaluable: CPI V1 stays SHADOW until enough prospective observations exist to judge edge survival, calibration, regime behavior, data freshness and reliability. Owner approval required.',
    market_benchmark: 'Not part of this report. Venue prices are captured separately and are never a model input.',
    by_target: byTarget, runs: rows,
    known_input_gaps: KNOWN_INPUT_GAPS,
    calendar: { version: CALENDAR_VERSION, months: Object.keys(RELEASE_DATES), horizon, warning: daysLeft < 45 ? `Calendar ends with ${horizon} (release ${horizonRelease.releaseDate}); add the next BLS schedule.` : null },
  };
}

export async function cpiShadowReport(store, { now = new Date().toISOString() } = {}) {
  const [runs, grades, eia, bls, rows] = await Promise.all([
    store.select('pred_cpi_shadow_runs', { select: '*' }, { order: 'run_id.asc' }),
    store.select('pred_cpi_shadow_grades', { select: '*' }, { order: 'run_id.asc' }),
    store.select('pred_macro_first_seen', { select: 'period,observed_at', source: 'eq.EIA' }, { order: 'observed_at.asc' }),
    store.select('pred_macro_first_seen', { select: 'period,observed_at,source_published_at,value', source: 'eq.BLS' }, { order: 'observed_at.asc' }),
    store.select('pred_forecasts_shadow', { select: 'record_id', model_id: `eq.${SHADOW_MODEL_ID}` }, { order: 'record_id.asc' }),
  ]);
  const weeks = [...new Set(eia.map((r) => r.period))].sort();
  return {
    ...summarize(runs, grades, { now }),
    first_seen: {
      eia: { rows: eia.length, weeks: weeks.length, last_week: weeks.at(-1) ?? null, first_observed_at: eia[0]?.observed_at ?? null, last_observed_at: eia.at(-1)?.observed_at ?? null },
      bls: bls.map((r) => ({ month: r.period, observed_at: r.observed_at, published_at: r.source_published_at, headline_mom: r.value === null ? null : Number(r.value) })),
    },
    shadow_contract_rows: rows.length,
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f3 = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(3));
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(Number(x) * 100)}%`);

export function renderCpiShadowHtml(rep) {
  const targets = Object.entries(rep.by_target).map(([t, s]) => `<tr><td>${esc(t)}</td><td>${s.prospective_observations}</td><td>${s.ok}</td><td>${s.no_forecast}</td><td>${f3(s.mean_brier)}</td><td>${f3(s.mean_log_loss)}</td><td>${f3(s.mean_rps)}</td><td>${s.interval_80_coverage === null ? '—' : pct(s.interval_80_coverage)}</td><td>${s.calibration.map((b) => `${esc(b.bin)}: ${pct(b.mean_p)}→${pct(b.freq)} (n${b.n})`).join('<br>') || '—'}</td></tr>`).join('');
  const runs = rep.runs.map((r) => `<tr><td>${esc(r.target)}</td><td>${esc(r.reference_month)}</td><td>${esc(r.status)}${r.reason ? `<br><small>${esc(r.reason)}</small>` : ''}</td><td><small>${esc(r.forecast_created_at)}</small></td><td>${r.median ?? '—'}</td><td>${r.interval_80 ? `${r.interval_80[0]} – ${r.interval_80[1]}` : '—'}</td><td><small>${(r.ladder || []).map((l) => `&gt;${l.threshold}: ${pct(l.p_above)}`).join(' · ')}</small></td><td><small>${(r.contracts || []).map((c) => `${esc(c.market_id)} ${pct(c.probability)}`).join('<br>') || '—'}</small></td><td>${r.actual ?? '—'}</td><td>${f3(r.brier)}</td><td>${f3(r.log_loss)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CPI V1 SHADOW</title>
<style>:root{--bg:#fbf8f3;--fg:#2b2620;--mut:#7a6f62;--line:#e4dccf}@media (prefers-color-scheme:dark){:root{--bg:#1d1a16;--fg:#efe7db;--mut:#a89c8c;--line:#3a342c}}body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px}table{border-collapse:collapse;width:100%;margin:12px 0 24px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--mut);font-weight:600}.wrap{overflow-x:auto}p{color:var(--mut);max-width:70ch}</style></head><body>
<h1>CPI V1 — private SHADOW report</h1><p>${esc(rep.model)} · state ${esc(rep.state)} · generated ${esc(rep.now)}. ${esc(rep.promotion)} ${esc(rep.market_benchmark)}</p>
${rep.calendar.warning ? `<p><strong>${esc(rep.calendar.warning)}</strong></p>` : ''}
<h2>By target</h2><div class="wrap"><table><tr><th>Target</th><th>Prospective n</th><th>OK runs</th><th>No forecast</th><th>Brier</th><th>Log loss</th><th>RPS</th><th>80% coverage</th><th>Calibration (pred→obs)</th></tr>${targets}</table></div>
<h2>Runs</h2><div class="wrap"><table><tr><th>Target</th><th>Ref month</th><th>Status</th><th>Frozen at</th><th>Median</th><th>80% interval</th><th>Model ladder P(&gt;t)</th><th>Contracts</th><th>Actual</th><th>Brier</th><th>Log loss</th></tr>${runs || '<tr><td colspan="11">No runs yet.</td></tr>'}</table></div>
<p>First-seen EIA: ${rep.first_seen ? `${rep.first_seen.eia.weeks} weeks, last ${esc(rep.first_seen.eia.last_week)}, last observed ${esc(rep.first_seen.eia.last_observed_at)}` : '—'} · BLS releases captured: ${rep.first_seen ? rep.first_seen.bls.map((b) => esc(b.month)).join(', ') || 'none yet' : '—'} · contract rows: ${rep.shadow_contract_rows ?? '—'}</p>
</body></html>`;
}
