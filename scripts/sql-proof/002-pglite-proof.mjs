// Local proof of sql/002 on an in-process Postgres (PGlite): 001 -> seed -> 002 -> proofs -> rollback.
// Run: cd <dir with @electric-sql/pglite installed> && node <repo>/scripts/sql-proof/002-pglite-proof.mjs  (not part of npm test: needs PGlite)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const root = 'D:/Workers/predictions/sql/';
const sql001 = readFileSync(root + '001_predictions_ledger.sql', 'utf8').replace('create extension if not exists pgcrypto;', '');
const sql002 = readFileSync(root + '002_prediction_engine_v1.sql', 'utf8');
const rb = readFileSync(root + '002_prediction_engine_v1_ROLLBACK.sql', 'utf8');
const db = new PGlite();
const results = [];
const check = (name, ok, extra = '') => { results.push([ok ? 'PASS' : 'FAIL', name, extra]); };
async function rejects(sql, pattern) {
  try { await db.exec(sql); return false; } catch (e) { return pattern.test(e.message) ? true : e.message; }
}

await db.exec(sql001);
// seed like production: housing observations exist
for (let i = 0; i < 5; i += 1) {
  await db.query(`insert into pred_source_observations (observation_key, provider, source_id, source_class, observed_at, available_at, captured_at, value)
    values ($1,'FRED','MORTGAGE30US','official', now(), now(), now(), $2)`, [`k${i}`, JSON.stringify(6 + i / 10)]);
}
const fp = `select count(*)::int n, md5(string_agg(observation_key || coalesce(value::text,'') || coalesce(data::text,''), '|' order by observation_key)) f from pred_source_observations`;
const before = (await db.query(fp)).rows[0];

await db.exec(sql002);
const after = (await db.query(fp)).rows[0];
check('source observations unchanged', before.n === after.n && before.f === after.f, `${after.n}`);

const trig = (await db.query(`select tgname from pg_trigger where tgname like 'pred_%' and not tgisinternal order by 1`)).rows.map((r) => r.tgname);
check('001 triggers intact (6) + 3 new', trig.length === 9, trig.join(','));
check('update still rejected', await rejects(`update pred_source_observations set units='x' where observation_key='k0'`, /append-only/) === true);
check('delete still rejected', await rejects(`delete from pred_source_observations where observation_key='k0'`, /append-only/) === true);

const g = (await db.query(`select pred_features_market_free('{"clim_rate":0.3,"mos":{"p06":[10,20]}}') a, pred_features_market_free('{"kalshi_mid":0.4}') b,
  pred_features_market_free('{"a":{"b":{"yes_bid":0.4}}}') c, pred_features_market_free('{"inputs":[{"market_probability":0.4}]}') d`)).rows[0];
check('leakage guard function', g.a === true && g.b === false && g.c === false && g.d === false, JSON.stringify(g));

// end-to-end shaped inserts
await db.exec(`insert into pred_events (event_id, canonical_question, category, domain, venue, venue_event_id, lifecycle, model_state)
  values ('PBE-WX-KXRAIN-26OCT04','Where will it rain on Oct 4, 2026?','weather','WEATHER','kalshi','KXRAIN-26OCT04','ACTIVE','RESEARCH')`);
await db.exec(`insert into pred_contracts (contract_id, event_id, venue, market_id, normalizer_version, rules_sha256, normalization_status, domain, normalized_at, station_id, observation_start, observation_end)
  values ('kalshi:KXRAIN-26OCT04-MIA:wx/1:abcd','PBE-WX-KXRAIN-26OCT04','kalshi','KXRAIN-26OCT04-MIA','wx/1','abcd','NORMALIZED','WEATHER', now(), 'CLIMIA','2026-10-04T05:00Z','2026-10-05T05:00Z')`);
check('contract append-only', await rejects(`update pred_contracts set station_id='CLIFLL'`, /append-only/) === true);
check('unmodelable needs a reason', await rejects(`insert into pred_contracts (contract_id, event_id, venue, market_id, normalizer_version, rules_sha256, normalization_status, domain, normalized_at)
  values ('x','PBE-WX-KXRAIN-26OCT04','kalshi','m','wx/1','h','UNMODELABLE','WEATHER', now())`, /pred_contracts_reason_required/) === true);
check('market keys rejected in features', await rejects(`insert into pred_feature_snapshots (snapshot_id, event_id, model_id, cutoff_at, created_at, features)
  values ('fs1','PBE-WX-KXRAIN-26OCT04','m', now(), now(), '{"pop":0.4,"ctx":{"kalshi_yes_bid":0.3}}')`, /market_free/) === true);
await db.exec(`insert into pred_feature_snapshots (snapshot_id, event_id, model_id, cutoff_at, created_at, features)
  values ('fs2','PBE-WX-KXRAIN-26OCT04','m', now() - interval '1 min', now(), '{"pop":0.4,"clim":0.2}')`);
check('market observed after capture rejected', await rejects(`insert into pred_forecasts (record_id, event_id, model_id, model_version, probability, captured_at, contract_id, market_probability, market_observed_at)
  values ('r0','PBE-WX-KXRAIN-26OCT04','m','1',0.6, now(), 'kalshi:KXRAIN-26OCT04-MIA:wx/1:abcd', 0.4, now() + interval '1 min')`, /market_before_capture/) === true);
await db.exec(`insert into pred_forecasts (record_id, event_id, model_id, model_version, probability, captured_at, contract_id, market_probability, market_observed_at, data_cutoff_at, model_state, confidence, feature_snapshot_id)
  values ('r1','PBE-WX-KXRAIN-26OCT04','m','1',0.63, now(), 'kalshi:KXRAIN-26OCT04-MIA:wx/1:abcd', 0.41, now() - interval '30 s', now() - interval '1 min','RESEARCH','MEDIUM','fs2')`);
const div = (await db.query(`select divergence_points::float d from pred_forecasts where record_id='r1'`)).rows[0].d;
check('divergence generated = +22.0', div === 22, String(div));
check('forecast append-only', await rejects(`update pred_forecasts set probability=0.7 where record_id='r1'`, /append-only/) === true);
const fid = (await db.query(`select forecast_id from pred_forecasts where record_id='r1'`)).rows[0].forecast_id;
await db.query(`insert into pred_forecast_designations (contract_id, model_id, designation, forecast_id, rule_version) values ('kalshi:KXRAIN-26OCT04-MIA:wx/1:abcd','m','FIRST_PUBLISHED',$1,'designation/1')`, [fid]);
check('designation fixed once', await rejects(`insert into pred_forecast_designations (contract_id, model_id, designation, forecast_id, rule_version) values ('kalshi:KXRAIN-26OCT04-MIA:wx/1:abcd','m','FIRST_PUBLISHED','${fid}','designation/1')`, /pred_designation_unique/) === true);
check('designation model mismatch rejected', await rejects(`insert into pred_forecast_designations (contract_id, model_id, designation, forecast_id, rule_version) values ('kalshi:KXRAIN-26OCT04-MIA:wx/1:abcd','other','FINAL_PRE_RESOLUTION','${fid}','designation/1')`, /different contract/) === true);
await db.exec(`insert into pred_resolutions (event_id, resolved_at, authority, outcome, contract_id, official_outcome, official_value, venue_result, sources_agree)
  values ('PBE-WX-KXRAIN-26OCT04', now() - interval '1 hour', 'The Weather Company', '{"yes":true}', 'kalshi:KXRAIN-26OCT04-MIA:wx/1:abcd', 'YES', 0.12, 'yes', true)`);
await db.exec(`insert into pred_forecasts (record_id, event_id, model_id, model_version, probability, captured_at, contract_id) values ('r2','PBE-WX-KXRAIN-26OCT04','m','1',0.9, now(), 'kalshi:KXRAIN-26OCT04-MIA:wx/1:abcd')`);
const fid2 = (await db.query(`select forecast_id from pred_forecasts where record_id='r2'`)).rows[0].forecast_id;
check('post-resolution forecast cannot be designated', await rejects(`insert into pred_forecast_designations (contract_id, model_id, designation, forecast_id, rule_version) values ('kalshi:KXRAIN-26OCT04-MIA:wx/1:abcd','m','FINAL_PRE_RESOLUTION','${fid2}','designation/1')`, /after resolution/) === true);

await db.exec(rb);
const cols = (await db.query(`select count(*)::int n from information_schema.columns where table_name='pred_forecasts'`)).rows[0].n;
const t2 = (await db.query(`select tgname from pg_trigger where tgname like 'pred_%' and not tgisinternal`)).rows.length;
check('rollback restores 001 shape', cols === 13 && t2 === 6, `cols=${cols} triggers=${t2}`);
const final = (await db.query(fp)).rows[0];
check('source observations unchanged after rollback', final.f === before.f);

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] !== 'PASS').length;
console.log(`${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
