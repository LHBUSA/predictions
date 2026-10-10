// Forward SHADOW scorer for maxtemp pre-window v1.2 vs v1.1 (pre-registered gate, docs/research/TEMP_PREWINDOW_V12_PREREG.md).
// Both models are frozen artifacts; nothing is refit here. Only climate dates strictly AFTER --after count.
//
//   Kalshi ladders (exact production inputs): v1.2 is applied to the very NBM / GFS values and lead bucket that v1.1's
//   published FINAL_PRE_RESOLUTION forecast used, on the settled bucket ladder; v1.1 = the published probabilities.
//     node scripts/research/temp-audit/v12-forward.mjs --export <dir from export.ps1> --after 2026-10-10
//   All-station replay (31 CLI sites): point-in-time IEM archive cases (refresh with `node scripts/research/wx-fetch.mjs
//   <new-dir> GFS,NBS`), exact-degree log loss + 2 F bucket Brier, date-clustered CI and the forward gate.
//     node scripts/research/temp-audit/v12-forward.mjs --archive <dir> --after 2026-10-10
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCases } from './cases.mjs';
import { residualTable, bucketProbability } from '../../../src/weather/temp-model.js';
import { v12Probabilities, v12Center } from '../../../src/weather/temp-prewindow-v12.js';
import { orderBuckets, eventScores, temperatureSkillSummary, clusterBootstrap, modalIndex } from '../../../src/weather/temp-skill.js';
import v11 from '../../../src/weather/artifacts/temp-nbm-v1.1.json' with { type: 'json' };
import v12 from '../../../src/weather/artifacts/temp-prewindow-v1.2.json' with { type: 'json' };

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const AFTER = arg('--after');
if (!AFTER || !/^\d{4}-\d{2}-\d{2}$/.test(AFTER)) { console.error('--after YYYY-MM-DD is required (the freeze date; only later climate dates count)'); process.exit(2); }
const LEAD_OF = { le30h: 24, le54h: 48, gt54h: 60 };
const out = { after: AFTER, models: { baseline: 'v1.1.0', candidate: 'v1.2.0 SHADOW' }, gate: v12.forward_gate };

if (arg('--export')) {
  const dir = arg('--export');
  const L = (n) => JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8').replace(/^﻿/, ''));
  const ct = L('ct'); const rs = new Map(L('rs').map((r) => [r.contract_id, r])); const fc = new Map(L('fc').map((f) => [f.forecast_id, f]));
  const fin = new Map(L('ds').filter((d) => d.designation === 'FINAL_PRE_RESOLUTION').map((d) => [d.contract_id, fc.get(d.forecast_id)]));
  const byEv = new Map(); for (const c of ct) { if (!byEv.has(c.event_id)) byEv.set(c.event_id, []); byEv.get(c.event_id).push(c); }
  const rows = []; const skipped = {};
  for (const [, cs] of byEv) {
    const date = cs[0].detail?.climate_date; if (!(date > AFTER)) continue;
    const ob = orderBuckets(cs); const f = ob.buckets.map((c) => fin.get(c.contract_id)); const r = ob.buckets.map((c) => rs.get(c.contract_id));
    const skip = (k) => { skipped[k] = (skipped[k] || 0) + 1; };
    if (!ob.ok) { skip(ob.reason); continue; } if (f.some((x) => !x)) { skip('NO_FINAL'); continue; } if (r.some((x) => !x)) { skip('NOT_SETTLED'); continue; }
    const win = r.findIndex((x) => x.venue_result === 'yes'); if (win < 0 || r.filter((x) => x.venue_result === 'yes').length !== 1) { skip('NOT_ONE_WINNER'); continue; }
    const ex = f[0].explanation || {}; const ev = (l) => ex.evidence?.find((e) => String(e.label).startsWith(l))?.value ?? null;
    const nbm = ev('National Blend'); const gfs = ev('GFS MOS'); const lead = LEAD_OF[ex.error_table?.bucket];
    if (!Number.isFinite(nbm) || !lead || !String(ex.model_tier || '').startsWith('v1.1')) { skip('NOT_V11_NBM_INPUTS'); continue; }
    const p12 = v12Probabilities(v12, { stationCli: cs[0].station_id, runLeadH: lead, nbmF: nbm, gfsF: gfs, contracts: ob.buckets.map((c) => ({ comparator: c.comparator, low: c.threshold_low === null ? null : Number(c.threshold_low), high: c.threshold_high === null ? null : Number(c.threshold_high) })) });
    if (p12.state !== 'OK') { skip(p12.state); continue; }
    rows.push({ date, station: cs[0].station_id, y: Number(r[win].official_value), nbm, gfs, center: +p12.center.toFixed(2), v11: eventScores(f.map((x) => Number(x.probability)), win), v12: eventScores(p12.probabilities, win) });
  }
  const s11 = temperatureSkillSummary(rows.map((x) => ({ date: x.date, station: x.station, pbe: x.v11, market: x.v12 })));
  out.kalshi = { events: rows.length, dates: new Set(rows.map((x) => x.date)).size, skipped,
    v11: { hits: s11.market_paired?.pbe_hits ?? 0, expected: s11.market_paired?.pbe_expected ?? 0, log_loss: s11.pbe.log_loss, brier: s11.pbe.brier, rps: s11.pbe.rps },
    v12: { hits: s11.market_paired?.market_hits ?? 0, expected: s11.market_paired?.market_expected ?? 0 },
    v11_minus_v12: s11.market_paired ? { log_loss: s11.market_paired.log_loss, brier: s11.market_paired.brier, rps: s11.market_paired.rps } : null,
    not_worse_point_estimate: s11.market_paired ? s11.market_paired.log_loss.diff >= 0 && s11.market_paired.brier.diff >= 0 : null,
    rows: rows.map(({ v11: a, v12: b, ...x }) => ({ ...x, v11_p_win: +a.p_win.toFixed(3), v12_p_win: +b.p_win.toFixed(3), v11_hit: a.hit, v12_hit: b.hit })) };
}

if (arg('--archive')) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(AFTER + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const cases = await buildCases(arg('--archive'), { from, to: yesterday });
  const ladder = (n) => { const c0 = Math.round(n); return [[-999, c0 - 6], ...[c0 - 5, c0 - 3, c0 - 1, c0 + 1, c0 + 3].map((lo) => [lo, lo + 1]), [c0 + 5, 999]]; };
  const score = (art, center, r) => { const t = residualTable(art, r.s, r.runLeadH); const P = (lo, hi) => bucketProbability(art, t, center, { comparator: 'between', low: lo, high: hi });
    const lad = ladder(r.n); const win = lad.findIndex(([lo, hi]) => r.y >= lo && r.y <= hi); const ps = lad.map(([lo, hi]) => P(lo, hi));
    let br = 0; for (let i = 1; i < 6; i += 1) br += (ps[i] - (i === win ? 1 : 0)) ** 2; const s = ps.reduce((a, b) => a + b, 0); const k = modalIndex(ps);
    return { ll: -Math.log(P(r.y, r.y)), br: br / 5, hit: k === win ? 1 : 0, pm: ps[k] / s }; };
  const pts = cases.map((r) => ({ r, a: score(v11, r.n, r), b: score(v12, v12Center(v12, r.s, r.n, r.g), r) }));
  const dates = new Set(pts.map((x) => x.r.d)); const stations = new Set(pts.map((x) => x.r.s));
  const ll = clusterBootstrap(pts.map((x) => ({ cluster: x.r.d, a: x.a.ll, b: x.b.ll })));
  const br = clusterBootstrap(pts.map((x) => ({ cluster: x.r.d, a: x.a.br, b: x.b.br })));
  const ready = dates.size >= v12.forward_gate.min_resolved_dates && stations.size >= v12.forward_gate.min_stations;
  out.replay = { cases: pts.length, resolved_dates: dates.size, stations: stations.size, ready,
    v11: { log_loss: ll.mean_a, brier_2f: br.mean_a, hits: pts.reduce((a, x) => a + x.a.hit, 0), expected: pts.reduce((a, x) => a + x.a.pm, 0) },
    v12: { log_loss: ll.mean_b, brier_2f: br.mean_b, hits: pts.reduce((a, x) => a + x.b.hit, 0), expected: pts.reduce((a, x) => a + x.b.pm, 0) },
    v11_minus_v12: { log_loss: ll, brier_2f: br } };
  out.forward_gate_passed = ready && ll.ci[0] > 0 && br.ci[0] > 0 && (out.kalshi ? out.kalshi.not_worse_point_estimate === true : false);
  if (!ready) out.note = 'Descriptive only until the pre-registered sample is reached. Nobody may act on it.';
}
console.log(JSON.stringify(out, null, 1));
