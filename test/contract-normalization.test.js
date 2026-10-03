// Contract-parsing regressions on REAL Kalshi payloads captured 2026-10-03.
// A superficially correct forecast on the wrong station is a FAIL, so station identity is asserted exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeContract, parseEventTickerDate, parseRulesDate } from '../src/engine/contracts.js';
import { classifyContract } from '../src/engine/classify.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/kalshi/${name}.json`, import.meta.url)));
const rain = fx('KXRAIN-26OCT04');
const nyHigh = fx('KXHIGHNY-26OCT04');
const chiHigh = fx('KXHIGHCHI-26OCT04');
const now = '2026-10-03T17:30:00.000Z';
const norm = (f, suffix, patch = {}) => {
  const market = { ...f.markets.find((m) => m.ticker.endsWith(suffix)), ...patch };
  return normalizeContract({ series: f.series, event: f.event, market }, { now });
};

test('date helpers', () => {
  assert.equal(parseRulesDate('Oct 4, 2026'), '2026-10-04');
  assert.equal(parseEventTickerDate('KXHIGHNY-26OCT04-B63.5'), '2026-10-04');
  assert.equal(parseEventTickerDate('KXRAIN-26OCT04'), '2026-10-04');
  assert.equal(parseRulesDate('October 4 2026'), null);
});

test('KXRAIN Miami resolves at CLIMIA (Miami Intl, KMIA) over the EST climate day', async () => {
  const c = await norm(rain, '-MIA');
  assert.equal(c.normalization_status, 'NORMALIZED');
  assert.equal(c.domain, 'WEATHER');
  assert.equal(c.event_type, 'PRECIP_ANY');
  assert.equal(c.station_id, 'CLIMIA');
  assert.equal(c.location.icao, 'KMIA');
  assert.equal(c.location.ghcn, 'USW00012839');
  assert.equal(c.comparator, '>');
  assert.equal(c.threshold_low, 0);
  assert.equal(c.observation_start, '2026-10-04T05:00:00.000Z');
  assert.equal(c.observation_end, '2026-10-05T05:00:00.000Z');
  assert.match(c.resolution_authority, /Weather Company/);
  assert.match(c.verification_dataset, /CLIMIA/);
  assert.ok(c.exceptions.some((e) => /Missing daily precipitation value counts as 0/.test(e)));
  assert.match(c.rounding_rule, /trace \(T\) counts as 0/i);
  assert.match(c.contract_id, /^kalshi:KXRAIN-26OCT04-MIA:contract-norm\/1:[0-9a-f]{12}$/);
});

test('Chicago trap: KXRAIN Chicago = O\'Hare (CLIORD) but KXHIGHCHI = Midway (CLIMDW)', async () => {
  const r = await norm(rain, '-CHI');
  assert.equal(r.station_id, 'CLIORD');
  assert.equal(r.location.icao, 'KORD');
  assert.equal(r.observation_start, '2026-10-04T06:00:00.000Z'); // CST climate day
  const h = await norm(chiHigh, '-T70');
  assert.equal(h.station_id, 'CLIMDW');
  assert.equal(h.location.icao, 'KMDW');
  assert.notEqual(r.location.ghcn, h.location.ghcn);
});

test('KXRAIN DC resolves at Reagan National (CLIDCA), not Dulles or BWI', async () => {
  const c = await norm(rain, '-DC');
  assert.equal(c.station_id, 'CLIDCA');
  assert.equal(c.location.icao, 'KDCA');
});

test('KXHIGHNY is Central Park (CLINYC/KNYC), not LaGuardia/JFK; bucket semantics exact', async () => {
  const less = await norm(nyHigh, '-T63');
  assert.equal(less.station_id, 'CLINYC');
  assert.equal(less.location.icao, 'KNYC');
  assert.deepEqual([less.comparator, less.threshold_low, less.threshold_high], ['less', null, 63]);
  assert.equal(less.yes_condition, 'reported max <= 62°F');
  const between = await norm(nyHigh, '-B63.5');
  assert.deepEqual([between.comparator, between.threshold_low, between.threshold_high], ['between', 63, 64]);
  assert.equal(between.yes_condition, '63°F <= reported max <= 64°F');
  const greater = await norm(nyHigh, '-T70');
  assert.deepEqual([greater.comparator, greater.threshold_low], ['greater', 70]);
  assert.equal(greater.yes_condition, 'reported max >= 71°F');
  assert.equal(greater.units, 'degF');
});

test('fails closed: rules station changed to one outside the registry', async () => {
  const m = rain.markets.find((x) => x.ticker.endsWith('-MIA'));
  const c = await norm(rain, '-MIA', { rules_primary: m.rules_primary.replace('CLIMIA', 'CLIXYZ') });
  assert.equal(c.normalization_status, 'UNMODELABLE');
  assert.equal(c.status_reason, 'STATION_NOT_IN_CLI_REGISTRY');
});

test('fails closed: strike fields disagree with rules text', async () => {
  const c = await norm(nyHigh, '-B63.5', { floor_strike: 62 });
  assert.equal(c.normalization_status, 'HOLD_RESOLUTION_AMBIGUOUS');
  assert.equal(c.status_reason, 'STRIKE_FIELDS_DISAGREE_WITH_RULES');
});

test('fails closed: rules date disagrees with ticker date', async () => {
  const m = rain.markets.find((x) => x.ticker.endsWith('-NYC'));
  const c = await norm(rain, '-NYC', { rules_primary: m.rules_primary.replace('Oct 4, 2026', 'Oct 5, 2026') });
  assert.equal(c.status_reason, 'RULES_DATE_DISAGREES_WITH_TICKER');
});

test('fails closed: trace/missing rule removed from secondary rules', async () => {
  const c = await norm(rain, '-NYC', { rules_secondary: 'Resolves per the Weather Company.' });
  assert.equal(c.normalization_status, 'HOLD_RESOLUTION_AMBIGUOUS');
  assert.equal(c.status_reason, 'RAIN_SECONDARY_RULES_CHANGED');
});

test('fails closed: resolution authority switched away from the Weather Company', async () => {
  const m = nyHigh.markets.find((x) => x.ticker.endsWith('-T70'));
  const c = await norm(nyHigh, '-T70', { rules_primary: m.rules_primary.replace('according to The Weather Company', 'according to AccuWeather') });
  assert.equal(c.normalization_status, 'UNMODELABLE');
  assert.equal(c.status_reason, 'NO_WEATHER_CONTRACT_TEMPLATE');
});

test('unknown weather template (international TWC city) fails closed', async () => {
  const market = { ticker: 'KXHIGHTLFPG-26OCT04-T20', event_ticker: 'KXHIGHTLFPG-26OCT04', rules_primary: 'If the highest temperature recorded at Paris-Charles de Gaulle (LFPG) for Oct 4, 2026 is greater than 20°C according to The Weather Company, then the market resolves to Yes.', strike_type: 'greater', floor_strike: 20 };
  const c = await normalizeContract({ series: { ticker: 'KXHIGHTLFPG', title: 'Daily high temp Paris', category: 'Climate and Weather' }, event: {}, market }, { now });
  assert.equal(c.normalization_status, 'UNMODELABLE');
});

test('rules hash changes the contract id (append-only versioning, never edit)', async () => {
  const a = await norm(rain, '-NYC');
  const b = await norm(rain, '-NYC', { rules_secondary: `${rain.markets[0].rules_secondary} ` });
  assert.notEqual(a.contract_id, b.contract_id);
});

test('domain classifier routes without producing probabilities', () => {
  assert.equal(classifyContract({ series: { category: 'Climate and Weather', title: 'Rain Miami' } }), 'WEATHER');
  assert.equal(classifyContract({ series: { category: 'Climate and Weather', title: 'Hurricane landfall' } }), 'GEO_NATURAL');
  assert.equal(classifyContract({ series: { category: 'Economics', title: 'Fed decision' }, event: { title: 'Fed decision in Oct 2026?' } }), 'MACRO');
  assert.equal(classifyContract({ series: { category: 'Economics', title: 'Case-Shiller home price index' } }), 'HOUSING');
  assert.equal(classifyContract({ series: { category: 'Economics', title: 'Gas prices' } }), 'ENERGY');
  assert.equal(classifyContract({ series: { category: 'Elections', title: 'Senate race' } }), 'ELECTION_CIVIC');
  assert.equal(classifyContract({ series: { category: 'Sports', title: 'NBA game' } }), 'SPORTS');
  assert.equal(classifyContract({ series: { category: 'Entertainment', title: 'Box office' } }), 'OTHER');
});

test('unsupported domains are queued, never given a probability', async () => {
  const c = await normalizeContract({ series: { ticker: 'KXSENATE', title: 'Senate control', category: 'Elections' }, event: {}, market: { ticker: 'KXSENATE-26-R', rules_primary: 'If Republicans control the Senate...' } }, { now });
  assert.equal(c.normalization_status, 'UNSUPPORTED_DOMAIN');
  assert.equal(c.status_reason, 'MODEL_NOT_YET_ENABLED');
  assert.equal(c.domain, 'ELECTION_CIVIC');
});
