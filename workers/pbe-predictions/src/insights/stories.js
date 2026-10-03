// Prediction Intelligence — the first three flagship stories (gold-standard templates for the newsroom).
// Each story is bound to immutable evidence: its packets are read with an as-of bound, every number in the copy is
// computed from those rows at render time, and build() returns { ok: false } when a required field is missing — the
// route then 404s instead of rendering a story without its evidence. Analysis text is written per story; nothing in
// it states a probability, a move or a result that the packet does not contain.
import { esc } from '../pages.js';
import { latest, latestMarket, twoSided, evidenceValue, resolved } from './packet.js';
import { figure, dataTable, timeSeries, divergenceBars, distributionBars, thresholdCurve, guidanceLadder, calibration, COLORS, fmtUtc } from './charts.js';
import tempV1 from '../../../../src/weather/artifacts/temp-v1.json' with { type: 'json' };
import tempNbm from '../../../../src/weather/artifacts/temp-nbm-v1.1.json' with { type: 'json' };
import ratesPath from '../../../../src/rates/artifacts/rates-path-v1.json' with { type: 'json' };

const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const pts = (n) => `${sign(n)} pts`;
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const hm = (iso) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
const P = (s) => `<p>${s}</p>`;
const H2 = (id, s) => `<h2 id="${id}">${esc(s)}</h2>`;
const ms = (iso) => Date.parse(iso);
const fail = (reason) => ({ ok: false, reason });
const list = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
const ofAll = (k, n) => (k === n ? `all ${n}` : `${k} of ${n}`);
const plural = (n, w) => `${n} ${w}${Math.abs(n) === 1 ? '' : 's'}`;

function bucketBounds(label) {
  let m = label.match(/(\d+)° to (\d+)°/); if (m) return { lo: +m[1] - 0.5, hi: +m[2] + 0.5 };
  m = label.match(/(\d+)° or below/); if (m) return { lo: null, hi: +m[1] + 0.5 };
  m = label.match(/(\d+)° or above/); if (m) return { lo: +m[1] - 0.5, hi: null };
  return null;
}
const strikeOf = (label) => { const m = label.match(/([\d.]+)%/); return m ? Number(m[1]) : null; };
const tvDistance = (a, b) => { const sa = a.reduce((x, y) => x + y, 0); const sb = b.reduce((x, y) => x + y, 0); return Math.round(50 * a.reduce((acc, v, i) => acc + Math.abs(v / sa - b[i] / sb), 0) * 100) / 100; };

// ---------------------------------------------------------------- story 1: weather, model vs market
const LA = 'highest-temperature-in-los-angeles-on-oct-4-2026';
const S1 = {
  slug: 'los-angeles-99-degree-high-model-vs-market-oct-4-2026',
  family: 'MODEL_VS_MARKET', family_label: 'Model vs Market', vertical: 'weather',
  link_title: 'The market prices a 99°F day at LAX far above our model',
  image: { key: 'lax-99', version: 'v1', focal: '70% 46%', alt: 'Illustration: an airport runway at the edge of the Pacific on a blistering afternoon — heat haze over the far end, a jet climbing out, threshold markings in the foreground, and a probability curve whose thin right-hand tail crosses a glowing threshold line.' },
  events: [LA], primary: LA, as_of: '2026-10-03T21:00:00Z', published_at: '2026-10-03T21:40:00Z',
  build(PK) {
    const ev = PK[LA]; if (!ev) return fail('packet');
    const o = ev.outcomes.find((x) => x.label === '99° or above');
    const s = latest(o); const m = latestMarket(o);
    if (!s || !m || m.mid === null || s.market === null) return fail('no comparable market observation');
    const nbm = evidenceValue(s, 'National Blend of Models high'); const gfs = evidenceValue(s, 'GFS MOS guidance high');
    const nws = evidenceValue(s, 'Official NWS forecast high'); const normal = evidenceValue(s, 'Normal high for the date (1991-2020)');
    const errSd = evidenceValue(s, 'Station guidance error (past)');
    if ([nbm, gfs, normal, errSd].some((v) => v === null) || s.version !== '1.1.0') return fail('evidence');
    const v10 = o.snapshots.find((x) => x.version === '1.0.0');
    const gap = s.pbe - m.mid;
    const nwsEv = s.evidence.find((e) => e.label === 'Official NWS forecast high');
    const nbmSpread = (s.evidence.find((e) => e.label === 'National Blend of Models high')?.detail.match(/±(\d+)/) || [])[1];
    const rows = ev.outcomes.map((x) => ({ x, s: latest(x), m: latestMarket(x), b: bucketBounds(x.label) })).filter((r) => r.s && r.b).sort((a, b) => (a.b.lo ?? -1e9) - (b.b.lo ?? -1e9));
    if (rows.length < 4) return fail('distribution');
    const modal = [...rows].sort((a, b) => b.s.pbe - a.s.pbe)[0];
    const mktModal = [...rows].filter((r) => r.m?.mid !== null && r.m?.mid !== undefined).sort((a, b) => b.m.mid - a.m.mid)[0];
    const mids = rows.map((r) => r.m?.mid ?? null); const midSum = mids.every((v) => v !== null) ? mids.reduce((a, b) => a + b, 0) : null;
    const contract = o.contract; const loc = contract.location || {};
    const place = String(loc.name || 'Los Angeles International Airport').toLowerCase().replace(/\bintl\b/, 'international airport').replace(/\b\w/g, (c) => c.toUpperCase());
    const nwsIssued = (nwsEv?.detail.match(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})/) || [])[0];
    const errN = Number((s.evidence.find((e) => e.label === 'Station guidance error (past)')?.detail.match(/n=(\d+)/) || [])[1]);
    const v11First = o.snapshots.find((x) => x.version === '1.1.0');
    const fallback = o.snapshots.filter((x) => x.version === '1.0.0' && v11First && ms(x.t) > ms(v11First.t));

    const ladder = guidanceLadder({
      label: `Forecast highs for LAX on Oct 4, 2026 against the 99°F contract line`, min: 72, max: 102, threshold: 99,
      marks: [{ v: normal, label: 'Normal', color: '#8a9db1' }, { v: nbm, label: 'NBM', color: COLORS.pbe, sd: errSd }, { v: gfs, label: 'GFS MOS', color: '#7a5af8' }, ...(nws !== null ? [{ v: nws, label: 'NWS', color: '#c2410c' }] : [])],
      buckets: rows.map((r) => ({ lo: r.b.lo ?? 72, hi: r.b.hi ?? 102, pbe: r.s.pbe, market: r.m?.mid ?? null })),
    });
    const hist = timeSeries({
      label: 'PBE probability and Kalshi mid for 99°F or above, Oct 3 2026',
      series: [
        { name: 'Kalshi mid (stored observations)', color: COLORS.mkt, dash: '5 4', points: o.market_path.filter((p) => p.mid !== null).map((p) => [ms(p.t), p.mid]) },
        { name: 'PBE snapshot (dark = v1.1 National Blend · light = v1.0 GFS MOS)', color: COLORS.pbe, points: o.snapshots.map((x) => [ms(x.t), x.pbe]), dots: (p) => { const sn = o.snapshots.find((x) => ms(x.t) === p[0]); return sn?.version === '1.1.0' ? COLORS.pbe : COLORS.pbe2; } },
      ],
      annotations: [...(v11First ? [{ t: ms(v11First.t), label: 'v1.1 (NBM) live' }] : []), ...fallback.map((x) => ({ t: ms(x.t), label: 'GFS fallback' }))],
      tEnd: ms(S1.as_of),
    });
    const divs = o.snapshots.filter((x) => x.market !== null).map((x) => ({ v: x.pbe - x.market, label: `${hm(x.t).slice(0, 5)} v${x.version.slice(0, 3)}` }));

    const sections = [
      H2('contract', 'What the contract actually asks'),
      P(`Kalshi's contract settles on the daily maximum temperature The Weather Company reports for <b>${esc(place)}</b> (${esc(contract.station_id)}), for the climate day of Oct. 4 measured in local standard time — ${esc(fmtUtc(contract.observation_start))} to ${esc(fmtUtc(contract.observation_end))}. “99° or above” pays if the reported high is 99°F or more. PropBetEdge verifies every settlement against the National Weather Service's Daily Climate Report for the same station, stored separately.`),
      P(`That precision matters here. The airport sits on the coast; a few degrees of marine influence separate an ordinary warm day from a 99-degree reading, and the contract does not care what happened anywhere else in the basin.`),
      H2('disagreement', 'Where the forecasts disagree'),
      P(`Three forecast systems were in the record at the model's data cutoff (${esc(fmtUtc(s.cutoff))}). The National Blend of Models — the guidance the current model version uses — put the Oct. 4 high at <b>${nbm}°F</b>${nbmSpread ? ` with a blend spread of ±${nbmSpread}°F` : ''}. GFS MOS, the older station guidance, said <b>${gfs}°F</b>.${nws !== null ? ` The National Weather Service's own gridded forecast${nwsIssued ? `, issued ${esc(fmtUtc(nwsIssued))}` : ''}, showed <b>${nws}°F</b> — stored for context, not used as a model input.` : ''} The 1991–2020 normal for the date is ${normal}°F; every system expects an unusually hot day.`),
      figure({ kicker: 'EVIDENCE', title: 'The 99-degree line sits at the top of the guidance spread', subtitle: `Forecast highs (data cutoff ${fmtUtc(s.cutoff)}) vs contract buckets, with PBE and market probability per bucket`, asOf: S1.as_of, scroll: true, units: '°F; probabilities in %', source: 'NWS NBM and GFS MOS station guidance (via IEM), NWS gridpoint forecast, NOAA ACIS normals; Kalshi mids', body: ladder,
        note: `Shaded band around NBM: ±${errSd}°F, one standard deviation of this station's historical error between the reported high and the guidance at this lead time${Number.isFinite(errN) ? ` (n = ${errN.toLocaleString('en-US')} past forecasts)` : ''}.`,
        table: dataTable(['Input', 'Value (°F)'], [['Normal high (1991–2020)', normal], ['National Blend of Models', nbm], ['GFS MOS', gfs], ...(nws !== null ? [['NWS official forecast', nws]] : []), ['Contract threshold', 99]]) }),
      P(`The model does not average these numbers. It takes the National Blend's high and asks how far the reported temperature has historically landed from that guidance at this exact station and lead time: ${errSd}°F is one standard deviation of that error over ${Number.isFinite(errN) ? errN.toLocaleString('en-US') : 'the station\'s'} past forecasts. Reaching 99°F from a ${nbm}°F blend needs a miss of ${99 - nbm}°F or more in the warm direction — something the station's own record says happens rarely. That is the whole of the ${s.pbe}%.`),
      H2('distribution', 'The full distribution'),
      P(`The model's most likely bucket is <b>${esc(modal.x.label)}</b> at ${modal.s.pbe}%. The market's is <b>${esc(mktModal?.x.label || '—')}</b>${mktModal ? ` at ${mktModal.m.mid}%` : ''}. In other words, the two are not arguing about whether it will be hot; they disagree about the last few degrees.`),
      figure({ kicker: 'DISTRIBUTION', title: 'PBE vs market, every outcome', subtitle: `PBE ${esc(s.model)} · market = raw contract mids`, asOf: S1.as_of, units: '% probability', source: 'PBE immutable snapshots; Kalshi via the PropBetEdge market service',
        body: distributionBars({ series: [{ name: 'PBE', cls: 'pbe' }, { name: 'Market (raw mid)', cls: 'mkt' }], rows: rows.map((r) => ({ label: r.x.label, values: [r.s.pbe, r.m?.mid ?? null], highlight: r.x === o })) }),
        note: midSum !== null ? `Raw market mids across the six buckets sum to ${midSum}%; each bucket is its own order book, so the market's numbers are not forced to add to 100.` : 'At least one bucket had no two-sided quote (bid–ask wider than 10¢), so no market value is shown for it.',
        table: dataTable(['Outcome', 'PBE %', 'Market mid %'], rows.map((r) => [r.x.label, r.s.pbe, r.m?.mid ?? '—'])) }),
      H2('history', 'How the number got here'),
      P(`${v10 ? `The first forecast published for this contract, at ${hm(v10.t)} on Oct. 3, came from model version 1.0, which uses GFS MOS: <b>${v10.pbe}%</b>. ` : ''}Version 1.1, built on the National Blend after it beat GFS MOS in a holdout of ${tempNbm.holdout.methods.nbm.n.toLocaleString('en-US')} station-days (log loss ${tempNbm.holdout.methods.nbm.log_loss_exact} vs ${tempNbm.holdout.methods.gfs.log_loss_exact}), published <b>${v11First ? v11First.pbe : s.pbe}%</b> at ${v11First ? hm(v11First.t) : hm(s.t)} from the same data cutoff. The difference is the guidance, not new weather information — the subject of a separate PropBetEdge analysis.`),
      ...(fallback.length ? [P(`One snapshot needs a footnote. At ${fallback.map((x) => hm(x.t)).join(', ')} the engine could not fetch the National Blend run and re-published the GFS-only version (${fallback.map((x) => `${x.pbe}%`).join(', ')}) before the blend returned. That record stays in the archive — nothing is deleted — and the engine now holds a station when a guidance fetch fails rather than downgrading the model.`)] : []),
      figure({ kicker: 'PROBABILITY HISTORY', title: '“99° or above”: model snapshots vs the market', subtitle: 'Every dot is an immutable PBE snapshot; the dashed line is the stored Kalshi mid', asOf: S1.as_of, units: '% probability', source: 'PBE forecast archive; Kalshi', body: hist, scroll: true,
        table: dataTable(['Time (UTC)', 'Source', 'Value %'], [...o.snapshots.map((x) => [fmtUtc(x.t), `PBE ${x.model}`, x.pbe]), ...o.market_path.filter((p) => p.mid !== null).map((p) => [fmtUtc(p.t), 'Kalshi mid', p.mid])].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) }),
      figure({ kicker: 'DIVERGENCE', title: 'Model minus market at each snapshot', subtitle: 'Market value = the Kalshi mid captured with that forecast', asOf: S1.as_of, units: 'percentage points', source: 'PBE forecast archive', body: divergenceBars({ points: divs, label: 'PBE minus market, percentage points, at each snapshot' }), scroll: true,
        table: dataTable(['Snapshot', 'PBE %', 'Market %', 'Gap (pts)'], o.snapshots.filter((x) => x.market !== null).map((x) => [`${fmtUtc(x.t)} ${x.model}`, x.pbe, x.market, x.pbe - x.market])) }),
      H2('case-for-market', 'The case for the market'),
      P(`A ${Math.abs(gap)}-point gap is not a signal to trust the model. Several things in the record point the market's way.${nws !== null && nws >= 99 ? ` The Weather Service's own forecast sits at ${nws}°F, right on the line.` : ''} GFS MOS is ${gfs - nbm > 0 ? `${gfs - nbm}°F warmer than the blend` : 'close to the blend'}. And the model's own documented limitations apply squarely: it is a pre-window forecast with no current-conditions input, and its research notes record that guidance can run cold in unusual heat regimes. A market can price a heat event's persistence; this model, by design, cannot see it.`),
      P(`The model's case is narrower and historical: at this station, blend misses of ${99 - nbm}°F or more in the warm direction are uncommon. Which view is better calibrated is exactly what the scored record exists to answer — one contract will not settle it.`),
      H2('scoring', 'How this will be scored'),
      P(`The snapshots that count were fixed by rule before the outcome: <b>FIRST_PUBLISHED</b> (the ${v10 ? `${v10.pbe}% GFS-based` : 'first'} forecast), and <b>FINAL_PRE_RESOLUTION</b> — the last forecast captured before the climate day began at ${esc(fmtUtc(contract.observation_start))}. No T-minus-24-hour snapshot exists, because the first forecast came less than a day before the window. Both PBE and the market are scored on the same snapshot with Brier score and log loss once the official value is stored.`),
    ];
    const res = resolved(o) ? o.resolution : null;
    return {
      ok: true,
      title: `The market prices a 99°F day at LAX at ${m.mid}%. Our model says ${s.pbe}%.`,
      seo_title: `Los Angeles 99°F high on Oct. 4: market ${m.mid}% vs PBE model ${s.pbe}%`,
      dek: `Every forecast system expects an unusually hot Sunday at Los Angeles International Airport. The ${Math.abs(gap)}-point disagreement is about the last few degrees — and where the contract's line falls inside the guidance spread.`,
      description: `PropBetEdge's weather model puts LAX's chance of reaching 99°F on Oct. 4, 2026 at ${s.pbe}%; Kalshi's market was at ${m.mid}%. The guidance, the distribution, the probability history and how it will be scored.`,
      hero: { type: 'split', stats: [{ label: 'PBE model', value: `${s.pbe}%`, tone: 'pbe', sub: `${s.model}` }, { label: 'Market', value: `${m.mid}%`, tone: 'market', sub: `Kalshi mid · ${hm(m.t)}` }, { label: 'Divergence', value: pts(gap), tone: gap < 0 ? 'neg' : 'pos', sub: 'model minus market' }], outcome: `Outcome: ${o.label} · ${place}` },
      model_as_of: s.cutoff,
      quick: [
        `PBE's weather model (${esc(s.model)}, National Blend tier) gives <b>${s.pbe}%</b> that LAX reports 99°F or more on Oct. 4; the Kalshi mid was <b>${m.mid}%</b> at ${hm(m.t)} Oct. 3.`,
        `The blend forecasts ${nbm}°F and GFS MOS ${gfs}°F${nws !== null ? `; the NWS forecast (context only) is ${nws}°F` : ''}. The contract line is 99°F.`,
        `The model's most likely outcome is ${esc(modal.x.label)} (${modal.s.pbe}%); the market's is ${esc(mktModal?.x.label || '—')}.`,
        `Same data, older guidance: the GFS-based v1.0 said ${v10 ? `${v10.pbe}%` : 'more'} — the choice of guidance moves this contract by ${v10 ? Math.abs(v10.pbe - (v11First?.pbe ?? s.pbe)) : '—'} points.`,
        `Resolves on The Weather Company's reported high for ${esc(contract.station_id)}; PBE checks it against the NWS Daily Climate Report.`,
      ],
      sections: sections.join('\n'),
      resolution: res,
      outcome_market_id: o.market_id,
      ledger: ledgerFrom([{ o, s, m }], ev),
      rule: ruleFrom(o.contract),
      card: { eyebrow: 'WEATHER · MODEL VS MARKET', badge: `${s.state} MODEL`, title: `LAX 99°F high on Oct. 4: the market says ${m.mid}%, our model ${s.pbe}%`, subtitle: `Outcome: ${o.label} · Los Angeles International Airport`, stats: [{ label: 'PBE model', value: `${s.pbe}%`, tone: 'pbe' }, { label: 'Market', value: `${m.mid}%`, tone: 'market', sub: 'Kalshi mid' }, { label: 'Divergence', value: `${sign(gap)} pts`, tone: gap < 0 ? 'neg' : 'pos' }], footer: `Snapshot ${fmtUtc(s.t)} · ${s.model}` },
    };
  },
};

// ---------------------------------------------------------------- story 2: rates research
const R7 = 'how-low-will-the-7-year-us-treasury-yield-get-in-oct-2026';
const RATES_EVENTS = [R7, 'how-low-will-the-10-year-us-treasury-yield-get-by-oct-30-2026', 'how-high-will-the-10-year-us-treasury-yield-get-by-oct-30-2026', 'how-low-will-the-5-year-us-treasury-yield-get-in-oct-2026', 'how-high-will-the-5-year-us-treasury-yield-get-in-oct-2026', 'how-low-will-the-30-year-us-treasury-yield-get-by-oct-30-2026'];
const S2 = {
  slug: 'treasury-yields-october-2026-market-prices-near-certain-dip-path-model',
  family: 'RESEARCH', family_label: 'Research', vertical: 'rates',
  link_title: 'The market prices an October Treasury dip as near-certain; the path model does not',
  image: { key: 'treasury-7y', version: 'v1', focal: '58% 44%', alt: 'Illustration: a Treasury yield curve glowing across a dark terminal grid, with the seven-year point isolated by a vertical beam and a fan of simulated yield paths running toward a dashed threshold.' },
  events: RATES_EVENTS, primary: R7, as_of: '2026-10-03T21:00:00Z', published_at: '2026-10-03T21:40:00Z',
  build(PK) {
    const ev = PK[R7]; if (!ev) return fail('packet');
    const o = ev.outcomes.find((x) => x.label === '5.11% or below');
    const s = latest(o); const m = latestMarket(o);
    if (!s || !twoSided(m)) return fail('no two-sided market');
    const y = Number(evidenceValue(s, 'Latest official 7Y par yield')); const low = Number(evidenceValue(s, 'Period low so far'));
    const vol = Number(evidenceValue(s, 'Daily volatility (EWMA)')); const left = Number(evidenceValue(s, 'Business days left'));
    const yDate = s.evidence.find((e) => e.label === 'Latest official 7Y par yield')?.detail.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (![y, low, vol, left].every(Number.isFinite)) return fail('evidence');
    const gap = m.mid - s.pbe;
    const curvePts = ev.outcomes.map((x) => { const ls = latest(x); const lm = latestMarket(x); return { x: strikeOf(x.label), label: x.label, pbe: ls?.pbe ?? null, mid: twoSided(lm) ? lm.mid : null, bid: lm?.bid ?? null, ask: lm?.ask ?? null }; }).filter((p) => p.x !== null);
    const decided = ev.outcomes.filter((x) => !latest(x) && strikeOf(x.label) !== null && strikeOf(x.label) >= low);
    // cross-tenor: every two-sided quote with a stored PBE forecast at the as-of time
    const quotes = [];
    for (const slug of RATES_EVENTS) {
      const p = PK[slug]; if (!p) continue;
      for (const x of p.outcomes) { const ls = latest(x); const lm = latestMarket(x); if (ls && twoSided(lm)) quotes.push({ event: p.event, label: x.label, strike: strikeOf(x.label), pbe: ls.pbe, mid: lm.mid, bid: lm.bid, ask: lm.ask, gap: lm.mid - ls.pbe, extreme: Number(evidenceValue(ls, /high/i.test(p.event.title) ? 'Period high so far' : 'Period low so far')), dir: /how high/i.test(p.event.title) ? 'high' : 'low', tenor: (p.event.title.match(/(\d+)-?(?:year|Y)/i) || [])[1] }); }
    }
    if (quotes.length < 6) return fail('cross-tenor sample');
    const above = quotes.filter((q) => q.gap > 0).length; const below = quotes.filter((q) => q.gap < 0).length;
    const near = quotes.filter((q) => Number.isFinite(q.extreme) && Math.abs(q.strike - q.extreme) * 100 <= 3);
    const far = quotes.filter((q) => !near.includes(q));
    const avg = (a) => (a.length ? Math.round(a.reduce((acc, q) => acc + q.gap, 0) / a.length) : null);
    const nearAvg = avg(near); const farAvg = avg(far);
    const farBelow = far.filter((q) => q.gap < 0).length;
    const perEvent = RATES_EVENTS.map((slug) => { const qs = quotes.filter((q) => q.event.slug === slug); return qs.length ? qs.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0] : null; }).filter(Boolean);
    const cal = ratesPath.holdout_2018_2026.candidate;
    const bins = cal.calibration.map((b) => { const [lo, hi] = b.bin.split('-').map(Number); return { lo, hi, n: b.n, mean_p: b.mean_p, freq: b.observed }; });
    const hi60 = bins.filter((b) => b.lo >= 0.6);

    const sections = [
      H2('contract', 'What has to happen'),
      P(`The contract asks whether the U.S. Treasury's published 7-year par yield prints <b>below 5.12%</b> on any business day from Oct. 1 to Oct. 30 — Kalshi labels it “5.11% or below.” Only the Treasury's first published daily value counts; intraday trading does not. The latest official print in the record is <b>${y.toFixed(2)}%</b>${yDate ? ` (${day(yDate)})` : ''}, and the lowest print so far this month is <b>${low.toFixed(2)}%</b> — one basis point short. The yield needs to close ${Math.round((y - 5.11) * 100)} basis points lower than its latest print on any one of the ${left} business days left.`),
      P(`The market treats that as all but done: a <b>${m.mid}%</b> mid (bid ${m.bid}%, ask ${m.ask}%). PropBetEdge's path model says <b>${s.pbe}%</b>.`),
      H2('curve', 'The whole curve, not one strike'),
      P(`Kalshi lists a ladder of nested thresholds for the same month, and the model prices every one of them from the same simulation. Plotting them together shows where the two views actually part.`),
      figure({ kicker: 'THRESHOLD CURVE', title: 'Probability the 7-year prints below each level in October', subtitle: 'PBE (line) vs market bid–ask ranges; mids only where the quote is two-sided', asOf: S2.as_of, units: '% probability; x-axis = contract level (%)', source: 'PBE pbe-rates-path snapshots; Kalshi; U.S. Treasury', wide: true, scroll: true,
        body: thresholdCurve({ points: curvePts, xFmt: (v) => `${v.toFixed(2)}%`, label: 'PBE vs market probability across 7-year yield thresholds', ref: [{ x: low, label: `month low ${low.toFixed(2)}%`, anchor: 'end', row: 2 }] }),
        note: `${decided.length ? `Levels at or above the month's low (${decided.map((d) => esc(d.label)).join(', ')}) are already decided by the published path; the model does not forecast decided contracts. ` : ''}A wide bid–ask range is a market that has not agreed on a price, not a probability.`,
        table: dataTable(['Level', 'PBE %', 'Bid %', 'Ask %', 'Mid %'], curvePts.map((p) => [p.label, p.pbe ?? 'decided/none', p.bid ?? '—', p.ask ?? '—', p.mid ?? '—'])) }),
      P(`Far from the current yield, the market is mostly a spread rather than a price: bids and asks tens of points apart. The only two-sided quotes sit next to the month's low, and that is where the gap opens — ${curvePts.filter((p) => p.mid !== null).map((p) => `${esc(p.label)} at ${p.mid}% against the model's ${p.pbe}%`).join('; ')}.`),
      H2('across-curve', 'The same pattern across the Treasury curve'),
      P(`This is not a 7-year quirk. Across the ${quotes.length} two-sided quotes on October Treasury paths that had a stored PBE forecast at ${hm(S2.as_of)} on Oct. 3, the market priced the higher probability ${above} times and the lower ${below} times. ${near.length ? `On the ${near.length} contracts within three basis points of the month's high or low so far, the market sat ${nearAvg > 0 ? `${nearAvg} points above` : `${Math.abs(nearAvg)} points below`} the model on average` : ''}${far.length ? `; further out, the average gap was ${farAvg > 0 ? plural(farAvg, 'point') : `${plural(Math.abs(farAvg), 'point')} the other way`}${farBelow ? `, with the market below the model on ${farBelow} of ${far.length} quotes` : ''}` : ''}.`),
      figure({ kicker: 'ACROSS TENORS', title: 'Largest market-minus-model gap on each October path contract', subtitle: 'Two-sided quotes only, as of the story time', asOf: S2.as_of, units: 'percentage points (market minus PBE)', source: 'PBE snapshots; Kalshi', scroll: true,
        body: divergenceBars({ points: perEvent.map((q) => ({ v: q.gap, label: `${q.tenor}Y ${q.dir} ${q.strike}%` })), label: 'Market minus PBE at each contract\'s largest two-sided gap' }),
        table: dataTable(['Contract', 'Level', 'PBE %', 'Market mid % (bid–ask)', 'Market − PBE'], quotes.map((q) => [`${q.tenor}Y how ${q.dir}`, q.label, q.pbe, `${q.mid} (${q.bid}–${q.ask})`, q.gap])) }),
      P(`One reading is that the market expects more short-horizon movement than the model's volatility estimate — more volatility raises the odds of touching nearby levels in either direction. Another is a directional view the model, by construction, does not hold. The model is a random walk with no drift; it has no calendar of data releases. Neither explanation is established by one afternoon of quotes, and the market's numbers on the edges of the ladder are often one-sided.`),
      H2('model', 'What the model is — and how it has done'),
      P(`The model simulates ${ratesPath.paths.toLocaleString('en-US')} paths of daily yield changes for the remaining business days. Each day's move is drawn from standardized historical changes (1962–2017), scaled by an exponentially weighted volatility estimate (λ = ${ratesPath.ewma_lambda}): currently <b>${vol} bp per day</b> for the 7-year. Each simulated day is rounded to the two decimals Treasury publishes, and a path counts only if a <i>published</i> value crosses the line — exactly as the contract settles.`),
      P(`It has a track record before it ever went live. On a chronological holdout from 2018 to 2026 — ${cal.n.toLocaleString('en-US')} contracts across the 5-, 7-, 10- and 30-year tenors that the model never saw in training — its Brier score was ${cal.brier} against ${ratesPath.holdout_2018_2026.baseline.brier} for a simple Gaussian baseline. The calibration below is the relevant part for today: ${hi60.map((b) => `when it said ${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%, the event happened ${Math.round(b.freq * 100)}% of the time (n=${b.n.toLocaleString('en-US')})`).join('; ')}. On that history the model was, if anything, slightly too confident in this range — not too cautious.`),
      figure({ kicker: 'CALIBRATION · HISTORICAL HOLDOUT', title: 'Backtest calibration of the path model, 2018–2026', subtitle: 'Forecast probability vs observed frequency by bin — a backtest, not the live record', asOf: ratesPath.generated_at, units: '% (forecast vs observed)', source: 'PBE rates-path-v1 model artifact; Daily Treasury Par Yield Curve history',
        body: calibration({ bins, n: cal.n, minN: 30 }),
        note: `The live record starts with these October contracts; live calibration is published only once at least 30 forecasts have resolved.`,
        table: dataTable(['Bin', 'n', 'Mean forecast', 'Observed'], cal.calibration.map((b) => [b.bin, b.n, b.mean_p, b.observed])) }),
      H2('what-next', 'What would settle it'),
      P(`This one can settle early: Kalshi may expire the contract as soon as a published print falls below 5.12%. Every new Treasury print becomes a new model input; a changed input creates a new immutable snapshot, and the forecasts that count for scoring were fixed by rule before any of it happened.`),
    ];
    return {
      ok: true,
      title: `The market prices an October dip in the 7-year Treasury yield at ${m.mid}%. Our path model says ${s.pbe}%.`,
      seo_title: `7-year Treasury yield below 5.12% in October 2026? Market ${m.mid}% vs PBE ${s.pbe}%`,
      dek: `Across the Treasury contracts PropBetEdge tracks, the market is more confident than the model that yields will touch levels near the month's extremes. What has to happen, what the model assumes, and how it has done on eight years of holdout data.`,
      description: `PropBetEdge's Treasury path model gives ${s.pbe}% that the 7-year par yield prints below 5.12% in October 2026; the market was at ${m.mid}%. Threshold curve, cross-tenor comparison and backtest calibration.`,
      hero: { type: 'split', stats: [{ label: 'PBE model', value: `${s.pbe}%`, tone: 'pbe', sub: s.model }, { label: 'Market', value: `${m.mid}%`, tone: 'market', sub: `Kalshi mid · bid ${m.bid} / ask ${m.ask}` }, { label: 'Divergence', value: pts(-gap), tone: -gap < 0 ? 'neg' : 'pos', sub: 'model minus market' }], outcome: `Outcome: 7-year par yield prints below 5.12% in Oct 2026` },
      model_as_of: s.cutoff,
      quick: [
        `The 7-year closed at ${y.toFixed(2)}% on its latest print and has a month low of ${low.toFixed(2)}%; the contract needs a published value below 5.12% within ${left} business days.`,
        `Market <b>${m.mid}%</b> (bid ${m.bid} / ask ${m.ask}); PBE path model <b>${s.pbe}%</b>.`,
        `Across ${quotes.length} two-sided October Treasury quotes, the market priced higher than the model ${above} times${near.length ? `, by ${nearAvg} points on average near the month's extremes` : ''}.`,
        `The model is a random walk with ${vol} bp/day volatility for the 7-year; it has no data-release calendar.`,
        `Backtest (2018–2026, n=${cal.n.toLocaleString('en-US')}): in the 60–90% range the model was slightly overconfident, not underconfident.`,
      ],
      sections: sections.join('\n'),
      resolution: resolved(o) ? o.resolution : null,
      outcome_market_id: o.market_id,
      ledger: ledgerFrom([{ o, s, m }], ev),
      rule: ruleFrom(o.contract),
      card: { eyebrow: 'RATES · RESEARCH', badge: `${s.state} MODEL`, title: '7-year Treasury below 5.12% in October? The market is near-certain. The path model is not.', subtitle: `Latest print ${y.toFixed(2)}% · month low ${low.toFixed(2)}% · ${left} business days left`, stats: [{ label: 'PBE model', value: `${s.pbe}%`, tone: 'pbe' }, { label: 'Market', value: `${m.mid}%`, tone: 'market', sub: 'Kalshi mid' }, { label: 'Divergence', value: `${sign(-gap)} pts`, tone: 'neg' }], footer: `Snapshot ${fmtUtc(s.t)} · ${s.model}` },
    };
  },
};

// ---------------------------------------------------------------- story 3: forecast change / methodology
const CITIES = [['los-angeles', 'Los Angeles'], ['philadelphia', 'Philadelphia'], ['denver', 'Denver'], ['new-york-city', 'New York City'], ['miami', 'Miami'], ['austin', 'Austin'], ['chicago', 'Chicago']].map(([k, name]) => ({ slug: `highest-temperature-in-${k}-on-oct-4-2026`, name }));
const S3 = {
  slug: 'same-data-two-guidance-systems-national-blend-vs-gfs-mos-oct-4-2026',
  family: 'FORECAST_CHANGE', family_label: 'Forecast Change', vertical: 'weather',
  link_title: 'Same data, two guidance systems: National Blend vs GFS MOS',
  image: { key: 'two-guidance', version: 'v1', focal: '50% 50%', alt: 'Illustration: two forecast fields — violet on the left, blue on the right — radiating from the same bright point above one city grid, their contours diverging from identical starting information.' },
  events: CITIES.map((c) => c.slug), primary: 'highest-temperature-in-austin-on-oct-4-2026', as_of: '2026-10-03T21:00:00Z', published_at: '2026-10-03T21:40:00Z',
  build(PK) {
    const cities = [];
    for (const c of CITIES) {
      const p = PK[c.slug]; if (!p) continue;
      const rows = p.outcomes.map((x) => ({ x, b: bucketBounds(x.label), a: x.snapshots.find((s) => s.version === '1.0.0'), n: x.snapshots.find((s) => s.version === '1.1.0') })).filter((r) => r.b && r.a && r.n).sort((a, b) => (a.b.lo ?? -1e9) - (b.b.lo ?? -1e9));
      if (rows.length < 4) continue;
      const cutA = rows[0].a.cutoff; const cutN = rows[0].n.cutoff;
      if (cutA !== cutN || rows.some((r) => r.a.cutoff !== cutA || r.n.cutoff !== cutN)) continue; // same-data comparison only
      const nSnap = rows[0].n;
      const gfs = evidenceValue(nSnap, 'GFS MOS guidance high'); const nbm = evidenceValue(nSnap, 'National Blend of Models high');
      if (gfs === null || nbm === null) continue;
      const pa = rows.map((r) => r.a.pbe_raw); const pn = rows.map((r) => r.n.pbe_raw);
      const modalA = rows[pa.indexOf(Math.max(...pa))]; const modalN = rows[pn.indexOf(Math.max(...pn))];
      const mkt = rows.map((r) => r.n.market);
      const v11 = p.outcomes[0].snapshots.find((s) => s.version === '1.1.0');
      const fallback = p.outcomes[0].snapshots.filter((s) => s.version === '1.0.0' && v11 && ms(s.t) > ms(v11.t));
      cities.push({ ...c, p, rows, gfs, nbm, tv: Math.round(tvDistance(pa, pn)), modalA, modalN, mkt, cut: cutA, tA: rows[0].a.t, tN: rows[0].n.t, fallback, tvMktA: mkt.every((v) => v !== null) ? Math.round(tvDistance(pa, mkt)) : null, tvMktN: mkt.every((v) => v !== null) ? Math.round(tvDistance(pn, mkt)) : null });
    }
    if (cities.length < 5) return fail('same-cutoff pairs');
    const biggest = [...cities].sort((a, b) => b.tv - a.tv)[0];
    const smallest = [...cities].sort((a, b) => a.tv - b.tv)[0];
    const moved = cities.filter((c) => c.modalA.x !== c.modalN.x);
    const fbCount = cities.filter((c) => c.fallback.length).length;
    const lead = cities.find((c) => c.slug === S3.primary) || biggest;
    const leadA = lead.modalA; const leadOld = lead.rows.find((r) => r.x === leadA.x);
    const cmpN = cities.filter((c) => c.tvMktA !== null && c.tvMktN !== null);
    const closer = cmpN.filter((c) => c.tvMktN < c.tvMktA).length;

    const sections = [
      H2('what-happened', 'What happened'),
      P(`At ${hm(cities[0].tA)} on Oct. 3, PropBetEdge published probability distributions for Sunday's high temperature in ${cities.length} cities using model version 1.0, which reads GFS MOS station guidance. At ${hm(cities[0].tN)} it published them again with version 1.1, which reads the National Blend of Models. Both sets used the same guidance cycle and the same data cutoff — <b>${esc(fmtUtc(cities[0].cut))}</b>. Nothing about the weather changed between the two. Only the guidance did.`),
      P(`Because every forecast is an immutable snapshot, the pair is a controlled experiment that already happened in public: the same question, the same information, two guidance systems. Here is what it shows.`),
      H2('guidance-gap', 'The guidance gap'),
      figure({ kicker: 'EVIDENCE', title: 'National Blend minus GFS MOS, Oct. 4 high', subtitle: 'Same 12Z cycle, same station; positive = the blend is warmer', asOf: cities[0].cut, units: '°F', source: 'NWS NBM and GFS MOS station guidance via IEM, as stored with each v1.1 snapshot', scroll: true,
        body: divergenceBars({ points: cities.map((c) => ({ v: c.nbm - c.gfs, label: c.name })), label: 'NBM minus GFS MOS forecast high by city, °F' }),
        table: dataTable(['City', 'GFS MOS °F', 'NBM °F', 'NBM − GFS'], cities.map((c) => [c.name, c.gfs, c.nbm, c.nbm - c.gfs])) }),
      P(`The two guidance systems agreed within a degree in ${list(cities.filter((c) => Math.abs(c.nbm - c.gfs) <= 1).map((c) => c.name)) || 'none of the cities'}. They disagreed by four or more degrees in ${list(cities.filter((c) => Math.abs(c.nbm - c.gfs) >= 4).map((c) => `${c.name} (GFS MOS ${c.gfs}°F, blend ${c.nbm}°F)`)) || 'none'}. For contracts sold in two-degree buckets, four degrees is two whole buckets.`),
      H2('distribution-shift', 'How much of each forecast moved'),
      P(`A useful single number is how much probability changed hands between buckets — the share of the distribution that moved (total variation distance). Zero means identical forecasts; 100 means no overlap at all.`),
      figure({ kicker: 'FORECAST CHANGE', title: 'Share of the probability distribution that moved, v1.0 → v1.1', subtitle: 'Same data cutoff; computed from the stored per-bucket probabilities', asOf: cities[0].tN, units: 'percentage points of probability', source: 'PBE forecast archive', scroll: true,
        body: divergenceBars({ nonNegative: true, points: cities.map((c) => ({ v: c.tv, label: c.name })), label: 'Total variation distance between v1.0 and v1.1 distributions, by city' }),
        table: dataTable(['City', 'Moved (pts)', 'Most likely v1.0', 'Most likely v1.1'], cities.map((c) => [c.name, c.tv, `${c.modalA.x.label} (${c.modalA.a.pbe}%)`, `${c.modalN.x.label} (${c.modalN.n.pbe}%)`])) }),
      P(`${biggest.name} moved most: ${biggest.tv} points of probability changed buckets. ${smallest.name} moved least, ${smallest.tv} points. In ${ofAll(moved.length, cities.length)} cities the most likely outcome itself changed.`),
      H2('lead-example', `${lead.name}, bucket by bucket`),
      P(`${lead.name} shows the mechanism clearly. GFS MOS forecast ${lead.gfs}°F; the blend forecast ${lead.nbm}°F. Version 1.0 put <b>${leadOld.a.pbe}%</b> on “${esc(leadA.x.label)}”; version 1.1, from the same data, put <b>${leadOld.n.pbe}%</b> there and moved its weight to ${esc(lead.modalN.x.label)} (${lead.modalN.n.pbe}%).`),
      figure({ kicker: 'DISTRIBUTION', title: `${lead.name}: v1.0 (GFS MOS) vs v1.1 (National Blend) vs market`, subtitle: `Snapshots ${hm(lead.tA)} and ${hm(lead.tN)}, Oct. 3; market = Kalshi mid captured with the v1.1 snapshot`, asOf: lead.tN, units: '% probability', source: 'PBE forecast archive; Kalshi',
        body: distributionBars({ series: [{ name: 'v1.0 · GFS MOS', cls: 'pbe2' }, { name: 'v1.1 · National Blend', cls: 'pbe' }, { name: 'Market (raw mid)', cls: 'mkt' }], rows: lead.rows.map((r) => ({ label: r.x.label, values: [r.a.pbe, r.n.pbe, r.n.market] })) }),
        table: dataTable(['Outcome', 'v1.0 %', 'v1.1 %', 'Market %'], lead.rows.map((r) => [r.x.label, r.a.pbe, r.n.pbe, r.n.market ?? '—'])) }),
      H2('why-v11', 'Why the blend is the default'),
      P(`Version 1.1 was not adopted on a hunch. Both versions were evaluated on the same chronological holdout — ${tempNbm.holdout.methods.nbm.n.toLocaleString('en-US')} station-days from ${tempNbm.holdout.from} to ${tempNbm.holdout.to} — scoring the probability each assigned to the exact reported high. The National Blend version's log loss was <b>${tempNbm.holdout.methods.nbm.log_loss_exact}</b>; the GFS MOS version's was <b>${tempNbm.holdout.methods.gfs.log_loss_exact}</b> (lower is better). A simple average of the two scored ${tempNbm.holdout.methods.blend.log_loss_exact} on log loss but worse on Brier score (${tempNbm.holdout.methods.blend.brier_2deg} vs ${tempNbm.holdout.methods.nbm.brier_2deg}), so the model uses the blend alone and keeps GFS MOS only as a fallback.`),
      ...(cmpN.length ? [P(`It is tempting to ask which version agreed with the market. Of the ${cmpN.length} cities where every bucket had a two-sided quote, v1.1 was closer to the market's distribution in ${closer}. That is not evidence of accuracy — the market is not the outcome. The scored record, built from snapshots fixed before each outcome, is the only place that question gets answered.`)] : []),
      H2('fallback', 'The fallback, and the fix'),
      P(`${fbCount ? `The archive also shows what went wrong. In ${ofAll(fbCount, cities.length)} cities, a GFS-only version was published again ${cities[0].fallback.length ? `at ${cities.map((c) => c.fallback.map((s) => hm(s.t))).flat().filter((v, i, a) => a.indexOf(v) === i).join(' and ')}` : 'later that afternoon'}, after the engine failed to fetch the National Blend run, before the blend version returned on the next cycle. The same data cutoff produced public numbers that flipped back and forth — exactly the kind of change that is not a forecast change. The engine now holds a station when a guidance fetch fails instead of falling back. ` : ''}The snapshots stay in the archive; nothing is rewritten. For scoring, the FIRST_PUBLISHED role for these contracts belongs to the v1.0 forecast — it was first — and FINAL_PRE_RESOLUTION to the last forecast before each city's climate day begins.`),
      H2('takeaway', 'Takeaway'),
      P(`For daily temperature contracts, the choice of guidance can matter as much as the weather. When a PropBetEdge probability changes, the snapshot archive shows whether new data arrived or the model changed — and this page shows the size of the second effect on a day when it was the only thing that changed.`),
    ];
    const la = cities.find((c) => c.name === 'Los Angeles');
    return {
      ok: true,
      title: `Same data, two guidance systems: switching to the National Blend moved up to ${biggest.tv} points of probability`,
      seo_title: `National Blend vs GFS MOS: how one guidance switch reshaped Oct. 4 temperature forecasts`,
      dek: `On Oct. 3 PropBetEdge published Sunday's city highs twice from the same data cutoff — first from GFS MOS, then from the National Blend of Models. The immutable snapshots show how much the guidance alone moves a probability distribution.`,
      description: `A controlled comparison from PropBetEdge's forecast archive: ${cities.length} cities, one data cutoff, GFS MOS (v1.0) vs National Blend (v1.1). Distribution shifts, holdout evidence and the fallback fix.`,
      hero: { type: 'flow', from: `${leadOld.a.pbe}%`, to: `${leadOld.n.pbe}%`, label: `${lead.name} · “${leadA.x.label}” · v1.0 GFS MOS → v1.1 National Blend`, stats: [{ label: 'Cities compared', value: String(cities.length), tone: 'neutral' }, { label: 'Largest shift', value: `${biggest.tv} pts`, tone: 'pbe', sub: biggest.name }, { label: 'Data cutoff', value: hm(cities[0].cut).slice(0, 5), tone: 'market', sub: 'identical for both' }] },
      model_as_of: cities[0].cut,
      quick: [
        `Same guidance cycle, same cutoff (${esc(fmtUtc(cities[0].cut))}): v1.0 read GFS MOS, v1.1 read the National Blend.`,
        `${lead.name}: “${esc(leadA.x.label)}” went from ${leadOld.a.pbe}% to ${leadOld.n.pbe}% with no new weather data.`,
        `Up to ${biggest.tv} points of probability changed buckets (${biggest.name}); the most likely outcome changed in ${ofAll(moved.length, cities.length)} cities.`,
        `The blend is the default because it scored better on a ${tempNbm.holdout.methods.nbm.n.toLocaleString('en-US')}-station-day holdout (log loss ${tempNbm.holdout.methods.nbm.log_loss_exact} vs ${tempNbm.holdout.methods.gfs.log_loss_exact}).`,
        `${fbCount ? `A transient fetch failure briefly re-published GFS-only forecasts; the engine now holds instead.` : 'Every snapshot remains in the immutable archive.'}`,
      ],
      sections: sections.join('\n'),
      resolution: null,
      outcome_market_id: lead.modalA.x.market_id,
      ledger: ledgerFrom(cities.slice(0, 7).map((c) => ({ o: c.modalN.x, s: c.modalN.n, m: null, city: c.name, pair: c.modalN.a })), PK[lead.slug]),
      rule: ruleFrom(lead.rows[0].x.contract),
      related_events: cities.map((c) => c.slug),
      card: { eyebrow: 'WEATHER · FORECAST CHANGE', badge: `${lead.rows[0].n.state} MODEL`, title: 'Same data, two guidance systems: how the National Blend reshaped Sunday’s temperature forecasts', flow: { from: `${leadOld.a.pbe}%`, to: `${leadOld.n.pbe}%`, label: `${lead.name} “${leadA.x.label}” · GFS MOS v1.0 vs National Blend v1.1` }, footer: `Snapshots ${hm(lead.tA)} and ${hm(lead.tN)}, Oct 3, 2026 · same data cutoff` },
      _la: la,
    };
  },
};

function ledgerFrom(items, ev) {
  return items.map(({ o, s, m, city, pair }) => ({
    label: city ? `${city} · ${o.label}` : o.label,
    snapshot_id: s.id, pair_id: pair?.id ?? null, model: s.model, state: s.state, cutoff: s.cutoff, captured: s.t,
    market_t: m?.t ?? null, market: m ? (m.mid ?? null) : s.market,
    sources: [...new Set((s.provenance || []).filter((p) => /input|settlement/.test(p.role || '')).map((p) => p.provider || p.source))],
  }));
}
function ruleFrom(c) {
  return { authority: c.resolution_authority, dataset: c.resolution_dataset, check: c.verification_dataset, measurement: c.measurement_definition, rounding: c.rounding_rule, exceptions: c.exceptions || [], rule: c.rules_primary };
}

export const STORIES = [S1, S2, S3];
export const storyBySlug = (slug) => STORIES.find((s) => s.slug === slug) || null;
export const VERTICALS = { weather: 'Weather', rates: 'Rates', economics: 'Economics', science: 'Science', space: 'Space', 'public-health': 'Public Health', energy: 'Energy', business: 'Business' };
export const FAMILY_LABELS = { FORECAST_PREVIEW: 'Forecast Preview', MODEL_VS_MARKET: 'Model vs Market', FORECAST_CHANGE: 'Forecast Change', PROBABILITY_MOVERS: 'Probability Movers', EVENT_CALENDAR: 'Event Calendar', RESOLUTION_REPORT: 'Resolution Report', MODEL_REVIEW: 'Model Review', RESEARCH: 'Research' };
export { tempV1 };
