// Automated story templates (Newsroom V1): FORECAST MOVER and RESOLUTION REPORT. Same contract as the flagship
// stories: a template receives an as-of-bounded evidence packet and returns { ok, ... } or { ok: false, reason }.
// Every probability a template displays is also returned in `claims` with the snapshot it came from, so the
// validator can prove it before anything is published.
import { esc } from '../pages.js';
import { figure, dataTable, timeSeries, distributionBars, COLORS, fmtUtc } from '../insights/charts.js';
import { INPUT_LABELS, PRIMARY_INPUTS, MOVER } from './config.js';
import { MIN_RESOLVED_FOR_METRICS } from '../../../../src/engine/registry.js';

const P = (s) => `<p>${s}</p>`;
const H2 = (id, s) => `<h2 id="${id}">${esc(s)}</h2>`;
const ms = (iso) => Date.parse(iso);
const hm = (iso) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const plain = (t) => String(t).replace(/\?$/, '');
const fail = (reason) => ({ ok: false, reason });
const fmtInput = (k, v) => {
  if (v === null || v === undefined) return '—';
  const [, unit] = INPUT_LABELS[k] || [k, ''];
  if (unit === 'prob') return `${Math.round(Number(v) * 100)}%`;
  if (unit === 'pp') return `${(Number(v) * 100).toFixed(1)} bp`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 40);
  return `${v}${unit && unit !== 'prob' ? unit : ''}`;
};

export function diffInputs(fa, fb, modelId) {
  const primary = new Set(PRIMARY_INPUTS[modelId] || []);
  return Object.keys({ ...fa, ...fb })
    .filter((k) => !/periods|guidance_error_table/.test(k) && JSON.stringify(fa?.[k]) !== JSON.stringify(fb?.[k]))
    .map((k) => ({ key: k, label: (INPUT_LABELS[k] || [k])[0], before: fa?.[k] ?? null, after: fb?.[k] ?? null, primary: primary.has(k) }));
}

// ---------------------------------------------------------------- FORECAST MOVER
export function buildMover({ packet, marketId, s0Id, s1Id, features }) {
  const o = packet.outcomes.find((x) => x.market_id === marketId);
  if (!o) return fail('outcome missing from packet');
  const s0 = o.snapshots.find((s) => s.id === s0Id); const s1 = o.snapshots.find((s) => s.id === s1Id);
  if (!s0 || !s1) return fail('mover snapshots not in the as-of packet');
  if (s0.model !== s1.model) return fail('mover snapshots are different model versions');
  const delta = s1.pbe - s0.pbe;
  const fa = features.get(s0.feature_snapshot_id); const fb = features.get(s1.feature_snapshot_id);
  if (!fa || !fb) return fail('feature snapshots missing');
  const changes = diffInputs(fa, fb, s1.model_id);
  const prim = changes.filter((c) => c.primary);
  if (!changes.length) return fail('NO_INPUT_CHANGE');
  if (Math.abs(delta) >= MOVER.large_jump_pts && !prim.length) return fail('LARGE_JUMP_UNEXPLAINED');
  const e = packet.event;
  const same = o.snapshots.filter((s) => s.model === s1.model);
  const runs = (s) => [...new Set((s.provenance || []).filter((p) => p.run).map((p) => `${p.source.replace(/ station guidance| \(.*\)/g, '')} ${p.run.slice(0, 13)}Z`))];
  const dir = delta > 0 ? 'up' : 'down';
  const mktNote = s0.market !== null && s1.market !== null ? `The Kalshi mid captured with each snapshot went from ${s0.market}% to ${s1.market}%.` : 'A comparable market observation was not captured with both snapshots, so no market move is stated.';
  const chart = timeSeries({
    label: `PBE ${s1.model} and Kalshi mid for ${o.label}`,
    series: [
      { name: 'Kalshi mid (stored observations)', color: COLORS.mkt, dash: '5 4', points: o.market_path.filter((p) => p.mid !== null).map((p) => [ms(p.t), p.mid]) },
      { name: `PBE ${s1.model} snapshots`, color: COLORS.pbe, points: same.map((s) => [ms(s.t), s.pbe]), dots: () => COLORS.pbe },
    ],
    annotations: [{ t: ms(s0.t), label: `${s0.pbe}%` }, { t: ms(s1.t), label: `${s1.pbe}%` }],
    tEnd: ms(packet.as_of),
  });
  const sections = [
    H2('what-changed', 'What changed in the inputs'),
    P(`Between the snapshot captured at ${esc(fmtUtc(s0.t))} (data cutoff ${esc(fmtUtc(s0.cutoff))}) and the one at ${esc(fmtUtc(s1.t))} (cutoff ${esc(fmtUtc(s1.cutoff))}), the same model version — <b>${esc(s1.model)}</b> — moved “${esc(o.label)}” from <b>${s0.pbe}%</b> to <b>${s1.pbe}%</b>. ${prim.length ? `The model inputs that changed: ${prim.map((c) => `${esc(c.label)} from ${esc(fmtInput(c.key, c.before))} to ${esc(fmtInput(c.key, c.after))}`).join('; ')}.` : 'Only secondary inputs changed.'}`),
    figure({ kicker: 'EVIDENCE', title: 'Stored model inputs, before and after', subtitle: 'From the immutable feature snapshots attached to each forecast', asOf: s1.t, units: 'as labeled', source: 'PBE feature snapshots',
      body: `<div class="tbl-wrap">${dataTable(['Input', 'Before', 'After', 'Primary'], changes.map((c) => [c.label, fmtInput(c.key, c.before), fmtInput(c.key, c.after), c.primary ? 'yes' : '—']))}</div>` }),
    P(`This page reports which stored inputs differ between two immutable forecasts. It does not claim why the underlying ${e.category === 'RATES' ? 'yields' : 'weather guidance'} changed.`),
    H2('path', 'The forecast path'),
    figure({ kicker: 'PROBABILITY HISTORY', title: `“${o.label}”: ${s1.model} snapshots vs the market`, subtitle: 'Same model version only; the dashed line is the stored Kalshi mid', asOf: packet.as_of, units: '% probability', source: 'PBE forecast archive; Kalshi', body: chart, scroll: true,
      table: dataTable(['Time (UTC)', 'Source', 'Value %'], [...same.map((s) => [fmtUtc(s.t), `PBE ${s.model}`, s.pbe]), ...o.market_path.filter((p) => p.mid !== null).map((p) => [fmtUtc(p.t), 'Kalshi mid', p.mid])].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) }),
    P(mktNote),
    H2('runs', 'The two snapshots'),
    `<div class="tbl-wrap">${dataTable(['', 'Earlier', 'Later'], [['Captured', fmtUtc(s0.t), fmtUtc(s1.t)], ['Data cutoff', fmtUtc(s0.cutoff), fmtUtc(s1.cutoff)], ['Guidance runs', runs(s0).join(', ') || '—', runs(s1).join(', ') || '—'], ['PBE', `${s0.pbe}%`, `${s1.pbe}%`], ['Market at capture', s0.market !== null ? `${s0.market}%` : '—', s1.market !== null ? `${s1.market}%` : '—']])}</div>`,
  ];
  return {
    ok: true,
    title: `${plain(e.title)}: PBE moves “${o.label}” ${dir} to ${s1.pbe}% from ${s0.pbe}%`,
    seo_title: `${plain(e.title)} — PBE forecast moved ${sign(delta)} pts`,
    dek: `New ${e.category === 'RATES' ? 'Treasury data' : 'forecast guidance'} reached the model between ${hm(s0.t)} and ${hm(s1.t)} on ${day(s1.t)}. Same model version, later data cutoff: here is exactly which inputs changed.`,
    description: `PropBetEdge's ${s1.model} forecast for “${o.label}” moved from ${s0.pbe}% to ${s1.pbe}% with new data. Inputs before and after, the forecast path and the market.`,
    hero: { type: 'flow', from: `${s0.pbe}%`, to: `${s1.pbe}%`, label: `${o.label} · ${s1.model} · ${hm(s0.t)} → ${hm(s1.t)}`, stats: [{ label: 'Move', value: `${sign(delta)} pts`, tone: delta > 0 ? 'pos' : 'neg' }, { label: 'Market at capture', value: s1.market !== null ? `${s1.market}%` : '—', tone: 'market' }, { label: 'Inputs changed', value: String(prim.length || changes.length), tone: 'neutral', sub: prim.length ? 'primary' : 'secondary' }] },
    model_as_of: s1.cutoff,
    quick: [
      `${esc(s1.model)} moved “${esc(o.label)}” from <b>${s0.pbe}%</b> to <b>${s1.pbe}%</b> (${sign(delta)} pts).`,
      `Later data cutoff: ${esc(fmtUtc(s0.cutoff))} → ${esc(fmtUtc(s1.cutoff))}; same model version, so the move reflects inputs, not a model change.`,
      prim.length ? `Primary inputs changed: ${prim.map((c) => esc(c.label)).join(', ')}.` : 'No primary input changed.',
      esc(mktNote),
    ],
    sections: sections.join('\n'),
    resolution: null,
    outcome_market_id: o.market_id,
    ledger: [{ label: o.label, snapshot_id: s1.id, pair_id: s0.id, model: s1.model, state: s1.state, cutoff: s1.cutoff, captured: s1.t, market_t: null, market: s1.market, sources: [...new Set((s1.provenance || []).filter((p) => /input|settlement/.test(p.role || '')).map((p) => p.provider || p.source))] }],
    rule: ruleOf(o.contract),
    card: { eyebrow: `${e.category_label.toUpperCase()} · FORECAST MOVE`, badge: `${s1.state} MODEL`, title: `${plain(e.title)}: “${o.label}”`, flow: { from: `${s0.pbe}%`, to: `${s1.pbe}%`, label: `${s1.model} · ${hm(s0.t)} vs ${hm(s1.t)} ${day(s1.t)}` }, footer: `Snapshots ${s0.id.slice(0, 8)} → ${s1.id.slice(0, 8)} · same model version, later data cutoff` },
    claims: [{ kind: 'pbe', snapshot_id: s0.id, value: s0.pbe }, { kind: 'pbe', snapshot_id: s1.id, value: s1.pbe }, ...(s1.market !== null ? [{ kind: 'market_at_snapshot', snapshot_id: s1.id, value: s1.market }] : []), ...(s0.market !== null ? [{ kind: 'market_at_snapshot', snapshot_id: s0.id, value: s0.market }] : [])],
  };
}

// ---------------------------------------------------------------- RESOLUTION REPORT
const CHECKPOINTS = ['FIRST_PUBLISHED', 'T_MINUS_24H', 'FINAL_PRE_RESOLUTION'];
const CP_LABEL = { FIRST_PUBLISHED: 'First published', T_MINUS_24H: 'T−24 h', FINAL_PRE_RESOLUTION: 'Final pre-resolution' };

export function buildResolution({ packet, familyResolved = null }) {
  const e = packet.event;
  const modeled = packet.outcomes.filter((o) => o.snapshots.length);
  if (!modeled.length) return fail('no public forecasts');
  for (const o of modeled) {
    const r = o.resolution;
    if (!r) return fail(`unresolved: ${o.market_id}`);
    if (!['yes', 'no'].includes(r.venue_result)) return fail(`venue result not yes/no (${r.venue_result}): ${o.market_id}`);
    if (!r.official_outcome) return fail(`official verification missing: ${o.market_id}`);
    if (r.sources_agree !== true) return fail(`venue and official disagree: ${o.market_id}`);
    if (!o.snapshots.some((s) => s.roles.includes('FINAL_PRE_RESOLUTION'))) return fail(`no FINAL_PRE_RESOLUTION designation: ${o.market_id}`);
    if (!o.scores.some((s) => s.designation === 'FINAL_PRE_RESOLUTION' && s.scoring_method === 'brier')) return fail(`final snapshot not scored: ${o.market_id}`);
  }
  const at = (o, d) => o.snapshots.find((s) => s.roles.includes(d)) || null;
  const yes = modeled.filter((o) => o.resolution.venue_result === 'yes');
  const head = e.kind === 'exclusive' || yes.length === 1 ? yes[0] || modeled[0] : [...modeled].sort((a, b) => Math.abs((at(b, 'FINAL_PRE_RESOLUTION').pbe) - (b.resolution.venue_result === 'yes' ? 100 : 0)) - Math.abs((at(a, 'FINAL_PRE_RESOLUTION').pbe) - (a.resolution.venue_result === 'yes' ? 100 : 0)))[0];
  const hf = at(head, 'FINAL_PRE_RESOLUTION');
  const mean = (d, m, key) => { const xs = modeled.flatMap((o) => o.scores.filter((s) => s.designation === d && s.scoring_method === m && s[key] !== null && s[key] !== undefined).map((s) => Number(s[key]))); return xs.length ? { v: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null; };
  const scoreRows = CHECKPOINTS.flatMap((d) => ['brier', 'log_loss'].map((m) => { const p = mean(d, m, 'score'); const k = mean(d, m, 'benchmark_score'); return p ? [CP_LABEL[d], m === 'brier' ? 'Brier' : 'Log loss', p.v.toFixed(3), k ? k.v.toFixed(3) : '—', p.n, k ? k.n : 0] : null; }).filter(Boolean));
  const fb = mean('FINAL_PRE_RESOLUTION', 'brier', 'score'); const fk = mean('FINAL_PRE_RESOLUTION', 'brier', 'benchmark_score');
  const r = head.resolution;
  const resultText = `${head.label}: ${r.venue_result.toUpperCase()}`;
  const official = `${r.official_value ?? ''} ${r.official_units ?? ''}`.trim();
  const chart = timeSeries({
    label: `PBE snapshots and Kalshi mid for ${head.label} until resolution`,
    series: [
      { name: 'Kalshi mid (stored observations)', color: COLORS.mkt, dash: '5 4', points: head.market_path.filter((p) => p.mid !== null && ms(p.t) <= ms(hf.t) + 6 * 3600000).map((p) => [ms(p.t), p.mid]) },
      { name: 'PBE snapshot (ringed = designated for scoring)', color: COLORS.pbe, points: head.snapshots.filter((s) => ms(s.t) <= ms(hf.t)).map((s) => [ms(s.t), s.pbe]), dots: (p) => { const s = head.snapshots.find((x) => ms(x.t) === p[0]); return s?.roles.length ? '#0f2033' : COLORS.pbe2; } },
    ],
    annotations: CHECKPOINTS.map((d) => at(head, d)).filter(Boolean).map((s) => ({ t: ms(s.t), label: s.roles.map((x) => CP_LABEL[x]).join(' + ') })),
  });
  const cpRows = modeled.map((o) => [o.label, o.resolution.venue_result.toUpperCase(), ...CHECKPOINTS.map((d) => { const s = at(o, d); return s ? `${s.pbe}%${s.market !== null ? ` (mkt ${s.market}%)` : ''}` : '—'; })]);
  const sections = [
    H2('result', 'What happened'),
    P(`${esc(plain(e.title))} resolved with <b>${esc(resultText)}</b>. The venue settled at ${esc(fmtUtc(r.venue_settled_at || r.resolved_at))}${r.venue_expiration_value ? ` (expiration value ${esc(r.venue_expiration_value)})` : ''}; PropBetEdge's independent check — ${esc(r.official_source || 'the official source')} — recorded <b>${esc(official || r.official_outcome)}</b>, which agrees with the settlement${r.source_url ? ` (<a href="${esc(r.source_url)}" rel="noopener" target="_blank">source</a>)` : ''}.`),
    H2('checkpoints', 'What PBE said before it happened'),
    P(`The snapshots that count were fixed by rule before the outcome: the first published forecast, the forecast in force 24 hours before the reference time (only if one existed), and the last forecast before it. Each is shown with the Kalshi mid captured at the same moment.`),
    figure({ kicker: 'CHECKPOINTS', title: 'Designated forecasts and the market at the same moment', subtitle: 'PBE % (market % captured with that snapshot)', asOf: hf.t, units: '% probability', source: 'PBE forecast archive; designations designation/1', body: `<div class="tbl-wrap">${dataTable(['Outcome', 'Result', ...CHECKPOINTS.map((d) => CP_LABEL[d])], cpRows)}</div>` }),
    ...(modeled.length > 1 && e.kind === 'exclusive' ? [figure({ kicker: 'DISTRIBUTION', title: 'Final pre-resolution distribution vs the market', asOf: hf.t, units: '% probability', source: 'PBE forecast archive; Kalshi',
      body: distributionBars({ series: [{ name: 'PBE (final)', cls: 'pbe' }, { name: 'Market at that snapshot', cls: 'mkt' }], rows: modeled.map((o) => ({ label: `${o.label}${o.resolution.venue_result === 'yes' ? ' ✓' : ''}`, values: [at(o, 'FINAL_PRE_RESOLUTION').pbe, at(o, 'FINAL_PRE_RESOLUTION').market], highlight: o.resolution.venue_result === 'yes' })) }) })] : []),
    figure({ kicker: 'FORECAST PATH', title: `“${head.label}” until resolution`, subtitle: 'Every public snapshot; designated snapshots ringed', asOf: hf.t, units: '% probability', source: 'PBE forecast archive; Kalshi', body: chart, scroll: true }),
    H2('score', 'How it scored'),
    P(`Scores compare PBE and the market on the same designated snapshot — a lower Brier score or log loss is better. ${fb ? `At the final pre-resolution checkpoint PBE's mean Brier score across ${fb.n} contract${fb.n > 1 ? 's' : ''} was <b>${fb.v.toFixed(3)}</b>${fk ? ` against <b>${fk.v.toFixed(3)}</b> for the market` : ''}.` : ''} One event is not evidence of skill in either direction.`),
    figure({ kicker: 'SCORE', title: 'PBE vs market on the designated snapshots', subtitle: 'Mean across this event’s contracts', asOf: r.resolved_at, units: 'Brier score / log loss (lower is better)', source: 'pred_scores', body: `<div class="tbl-wrap">${dataTable(['Checkpoint', 'Method', 'PBE', 'Market', 'n (PBE)', 'n (market)'], scoreRows)}</div>` }),
    ...(familyResolved !== null ? [P(`This event adds ${modeled.length} resolved contract${modeled.length > 1 ? 's' : ''} to the model's live record (${familyResolved} resolved in total). Live calibration is published once ${MIN_RESOLVED_FOR_METRICS} have resolved.`)] : []),
  ];
  const tone = (x) => (x < 0 ? 'neg' : 'pos');
  return {
    ok: true,
    title: `${plain(e.title)}: ${head.label} — ${r.venue_result === 'yes' ? 'it happened' : 'it did not happen'}. How PBE scored.`,
    seo_title: `${plain(e.title)} — result and PBE forecast score`,
    dek: `${resultText}. PBE's final pre-resolution forecast was ${hf.pbe}%${hf.market !== null ? ` against a ${hf.market}% market` : ''}. The designated forecasts, the market at the same moments, and the scores — fixed before the outcome.`,
    description: `Resolution report: ${plain(e.title)} resolved ${resultText}. PBE's designated forecasts, contemporaneous market prices and Brier/log-loss scores.`,
    hero: { type: 'split', four: true, stats: [{ label: 'Result', value: r.venue_result.toUpperCase(), tone: r.venue_result === 'yes' ? 'pos' : 'neg', sub: head.label }, { label: 'PBE at final', value: `${hf.pbe}%`, tone: 'pbe', sub: hf.model }, { label: 'Market at final', value: hf.market !== null ? `${hf.market}%` : '—', tone: 'market', sub: 'captured with the snapshot' }, ...(fb ? [{ label: 'Brier (PBE)', value: fb.v.toFixed(3), tone: fk && fb.v <= fk.v ? 'pos' : fk ? 'neg' : 'neutral', sub: fk ? `market ${fk.v.toFixed(3)}` : `n=${fb.n}` }] : [])], outcome: `Resolved ${fmtUtc(r.resolved_at)} · verified against ${r.official_source || 'the official source'}` },
    model_as_of: hf.cutoff,
    quick: [
      `Result: <b>${esc(resultText)}</b>; official check ${esc(official || r.official_outcome)} agrees with the venue.`,
      `PBE at the final pre-resolution snapshot: <b>${hf.pbe}%</b>${hf.market !== null ? `; market at that moment ${hf.market}%` : ''}.`,
      ...(fb ? [`Mean Brier at the final checkpoint: PBE ${fb.v.toFixed(3)}${fk ? `, market ${fk.v.toFixed(3)}` : ''} (n=${fb.n}).`] : []),
      `Scoring snapshots were fixed by rule (designation/1) before the outcome existed.`,
    ],
    sections: sections.join('\n'),
    resolution: null, // the whole story is the resolution; no separate update module
    outcome_market_id: head.market_id,
    ledger: modeled.slice(0, 12).map((o) => { const s = at(o, 'FINAL_PRE_RESOLUTION'); return { label: o.label, snapshot_id: s.id, pair_id: at(o, 'FIRST_PUBLISHED')?.id ?? null, model: s.model, state: s.state, cutoff: s.cutoff, captured: s.t, market_t: null, market: s.market, sources: [o.resolution.official_source].filter(Boolean) }; }),
    rule: ruleOf(head.contract),
    card: { eyebrow: `${e.category_label.toUpperCase()} · RESOLUTION REPORT`, badge: `RESULT ${r.venue_result.toUpperCase()}`, title: `${plain(e.title)}: ${head.label}`, subtitle: `Resolved ${fmtUtc(r.resolved_at)}`, stats: [{ label: 'PBE at final', value: `${hf.pbe}%`, tone: 'pbe' }, { label: 'Market at final', value: hf.market !== null ? `${hf.market}%` : '—', tone: 'market' }, ...(fb ? [{ label: 'Brier PBE', value: fb.v.toFixed(3), tone: tone(fk ? fk.v - fb.v : 0), sub: fk ? `market ${fk.v.toFixed(3)}` : undefined }] : [])], footer: `Designated snapshot ${hf.id.slice(0, 8)} · ${hf.model}` },
    claims: modeled.flatMap((o) => CHECKPOINTS.map((d) => at(o, d)).filter(Boolean).flatMap((s) => [{ kind: 'pbe', snapshot_id: s.id, value: s.pbe }, ...(s.market !== null ? [{ kind: 'market_at_snapshot', snapshot_id: s.id, value: s.market }] : [])])),
  };
}

function ruleOf(c) {
  return { authority: c.resolution_authority, dataset: c.resolution_dataset, check: c.verification_dataset, measurement: c.measurement_definition, rounding: c.rounding_rule, exceptions: c.exceptions || [], rule: c.rules_primary };
}
