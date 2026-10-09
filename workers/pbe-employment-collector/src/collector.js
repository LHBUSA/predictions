// Employment Tier A collector, Cloudflare Workers runtime. A port of scripts/research/employment/collector/collect.mjs
// (employment-collector/2, verified on Windows 2026-10-08) with the infrastructure replaced: R2 instead of the local disk,
// a Durable Object instead of .state/ files and the lock, a hash-chained R2 audit ledger + R2 bucket locks instead of git
// history, pushes and branch protection (no GitHub at runtime), Cloudflare's clock instead of SNTP. The RULES are shared,
// not copied: slots, windows, MISSED/no-backfill, book derivation and fees come from the same lib.mjs the Windows collector runs. DATA AND PRICES ONLY: no fitting, no forecasts, no trading.
import { SERIES, TICK_GAP_MS, compactUtc, deriveBook, etParts, eventTicker, parseBlsSchedule, plan, slotTimes, takerFee } from '../../../scripts/research/employment/collector/lib.mjs';
import { clockCheck } from './http.js';
import { chainEntries } from './ledger.js';
import { dec, iso, sha256 } from './util.js';

export const COLLECTOR_VERSION = 'employment-collector/3-worker';
const CAL = 'calendar/bls-empsit-schedule.json';
const NL = String.fromCharCode(10);
const parseJ = (bytes) => JSON.parse(dec.decode(bytes));

// one capture directory: raw bodies exactly as received + a meta list with sha256 per file
class Capture {
  constructor(c, dir) { this.c = c; this.dir = dir; this.files = []; this.n = 0; }
  async get(label, ext, url) {
    const res = await this.c.get(url);
    const name = `${String(++this.n).padStart(3, '0')}_${label.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`;
    if (res.body && res.body.length) { await this.c.store.put(`${this.dir}/${name}`, res.body, res.meta.content_type || 'application/octet-stream'); res.meta.file = name; }
    this.files.push(res.meta);
    await this.c.sleep(120);
    return res;
  }
}

function clockRecord(c, files = []) {
  return { source: 'cloudflare-workers-runtime', check: clockCheck(files), note: 'Every *_utc is the Workers runtime clock (Cloudflare NTP-disciplined hosts; Date.now() advances at I/O boundaries, so request start and response completion are both observed values). Each response\'s server Date header is kept for independent comparison.' };
}

// ---------- captures ----------
export async function kalshiSnapshot(c, rel, slot, slotAt) {
  const started = c.now();
  const dir = `kalshi/${rel.release_date}/${slot}/${compactUtc(started)}`;
  const cap = new Capture(c, dir);
  const series = {}; const terms_seen = [];
  for (const s of SERIES) {
    const ev = eventTicker(s, rel.reference_month);
    const sr = await cap.get(`series_${s}`, 'json', `${c.kalshiBase}/series/${s}`);
    const srec = sr.ok ? parseJ(sr.body).series : null;
    const er = await cap.get(`event_${ev}`, 'json', `${c.kalshiBase}/events/${ev}`);
    if (!er.ok) { series[s] = { event_ticker: ev, status: er.meta.status === 404 ? 'EVENT_NOT_LISTED' : 'ERROR', http: er.meta.status ?? er.meta.error }; continue; }
    const markets = []; let cursor = ''; let page = 0; let listOk = true;
    do {
      const mr = await cap.get(`markets_${ev}_p${++page}`, 'json', `${c.kalshiBase}/markets?event_ticker=${ev}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!mr.ok) { listOk = false; break; }
      const j = parseJ(mr.body); markets.push(...(j.markets || [])); cursor = j.cursor || '';
    } while (cursor && page < 10);
    const terms = {};
    for (const [k, url] of [['contract_terms_url', srec?.contract_terms_url], ['contract_url', srec?.contract_url]]) {
      if (!url) { terms[k] = null; continue; }
      const r = await c.get(url);
      if (r.ok) { await c.store.put(`kalshi/terms/${r.meta.sha256}.pdf`, r.body, 'application/pdf'); terms_seen.push(r.meta.sha256); }
      terms[k] = { ...r.meta, stored_as: r.ok ? `kalshi/terms/${r.meta.sha256}.pdf` : null };
    }
    const contracts = [];
    for (const m of markets) {
      const ob = await cap.get(`orderbook_${m.ticker}`, 'json', `${c.kalshiBase}/markets/${m.ticker}/orderbook`);
      const book = ob.ok ? deriveBook(parseJ(ob.body)) : null;
      contracts.push({
        ticker: m.ticker, status: m.status, strike_type: m.strike_type, floor_strike: m.floor_strike ?? null, cap_strike: m.cap_strike ?? null,
        close_time: m.close_time, expected_expiration_time: m.expected_expiration_time ?? null,
        close_date_et: m.close_time ? etParts(Date.parse(m.close_time)).date : null,
        rules_primary_sha256: await sha256(String(m.rules_primary || '')), rules_secondary_sha256: await sha256(String(m.rules_secondary || '')),
        orderbook_file: ob.meta.file || null, orderbook_http: ob.meta.status ?? ob.meta.error, orderbook_completed_utc: ob.meta.response_completed_utc,
        book: book && { best_yes_bid: book.best_yes_bid, best_yes_bid_size: book.best_yes_bid_size, best_yes_ask: book.best_yes_ask, best_yes_ask_size: book.best_yes_ask_size, mid: book.mid, spread: book.spread, two_sided: book.two_sided, levels_yes_bid: book.yes_bids_desc.length, levels_no_bid: book.no_bids_desc.length, depth_yes_bid_contracts: book.depth_yes_bid_contracts, depth_no_bid_contracts: book.depth_no_bid_contracts },
        taker_fee_1_contract: book && { buy_yes_at_ask: takerFee(srec?.fee_type, srec?.fee_multiplier, book.best_yes_ask), buy_no_at_1_minus_bid: takerFee(srec?.fee_type, srec?.fee_multiplier, book.best_yes_bid === null ? null : +(1 - book.best_yes_bid).toFixed(4)) },
        market_record: { yes_bid_dollars: m.yes_bid_dollars, yes_ask_dollars: m.yes_ask_dollars, yes_bid_size_fp: m.yes_bid_size_fp, yes_ask_size_fp: m.yes_ask_size_fp, last_price_dollars: m.last_price_dollars, volume_24h_fp: m.volume_24h_fp, volume_fp: m.volume_fp, open_interest_fp: m.open_interest_fp },
      });
    }
    const complete = listOk && contracts.every((x) => x.orderbook_http === 200);
    series[s] = {
      event_ticker: ev, status: complete ? 'OK' : 'INCOMPLETE', markets_listed: markets.length, orderbooks_ok: contracts.filter((x) => x.orderbook_http === 200).length,
      fee: srec && { fee_type: srec.fee_type, fee_multiplier: srec.fee_multiplier, formula: 'ceil(100 * 0.07 * fee_multiplier * C * P * (1 - P)) / 100 (taker, quadratic*)' },
      terms, close_dates_et: [...new Set(contracts.map((x) => x.close_date_et))], close_matches_bls_release_date: contracts.every((x) => x.close_date_et === rel.release_date),
      contracts,
    };
  }
  const completed = c.now();
  const listed = Object.values(series).filter((x) => x.status !== 'EVENT_NOT_LISTED');
  const status = listed.length && listed.every((x) => x.status === 'OK') ? 'OK' : 'INCOMPLETE';
  const lastResponse = Math.max(...cap.files.map((f) => Date.parse(f.response_completed_utc)));
  const snap = {
    kind: 'KALSHI_SNAPSHOT', slot, release: rel, slot_at_utc: slotAt ? iso(slotAt) : null, started_utc: iso(started), completed_utc: iso(completed),
    completed_before_slot: slotAt ? lastResponse < slotAt : null, seconds_before_slot: slotAt ? +((slotAt - lastResponse) / 1000).toFixed(1) : null,
    status, series, clock: clockRecord(c, cap.files), code: c.code, host: c.host, mode: c.mode, files: cap.files,
    note: 'Research evidence only. Never a model input. Prices are executable top-of-book at fetch time; YES ask = 1 - best NO bid.',
  };
  await c.store.putJson(`${dir}/snapshot.json`, snap);
  // the index records the capture only after every byte is in R2; only OK + completed_before_slot satisfies a slot
  await c.state.addIndex(c.ns, [{ kind: 'KALSHI_SNAPSHOT', key: `${rel.release_date}/${slot}`, ok: status === 'OK' && snap.completed_before_slot === true, status, at: snap.completed_utc, path: dir }, ...terms_seen.map((h) => ({ kind: 'TERMS', key: h, ok: true, at: snap.completed_utc }))]);
  c.ledger('KALSHI_SNAPSHOT', { release_date: rel.release_date, slot, dir, status, completed_before_slot: snap.completed_before_slot, contracts: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.markets_listed ?? v.status])) });
  if (status !== 'OK') await c.alert('SNAPSHOT_INCOMPLETE', `${rel.release_date} ${slot}: ${JSON.stringify(Object.fromEntries(Object.entries(series).map(([k, v]) => [k, `${v.status} ${v.orderbooks_ok ?? ''}/${v.markets_listed ?? ''}`])))}`);
  for (const [k, v] of Object.entries(series)) if (v.status === 'OK' && !v.close_matches_bls_release_date) await c.alert('CALENDAR_MISMATCH', `${k} ${v.event_ticker} closes on ${v.close_dates_et.join(',')} but BLS schedules the release on ${rel.release_date}`);
  return snap;
}

export async function kalshiSettlement(c, rel, tag) {
  const at = c.now();
  const dir = `kalshi/${rel.release_date}/${tag}/${compactUtc(at)}`;
  const cap = new Capture(c, dir);
  const out = {};
  for (const s of SERIES) {
    const ev = eventTicker(s, rel.reference_month);
    const mr = await cap.get(`markets_${ev}`, 'json', `${c.kalshiBase}/markets?event_ticker=${ev}&limit=200`);
    const ms = mr.ok ? parseJ(mr.body).markets || [] : [];
    out[s] = { event_ticker: ev, http: mr.meta.status ?? mr.meta.error, markets: ms.map((m) => ({ ticker: m.ticker, status: m.status, result: m.result ?? null, expiration_value: m.expiration_value ?? null, settlement_ts: m.settlement_ts ?? null })), all_final: ms.length > 0 && ms.every((m) => m.result === 'yes' || m.result === 'no') };
  }
  const rec = { kind: 'KALSHI_SETTLEMENT', tag, release: rel, captured_utc: iso(at), series: out, note: 'Settlement facts only. Never an observation: truth is the BLS first print (protocol B2.2).', clock: clockRecord(c, cap.files), code: c.code, mode: c.mode, files: cap.files };
  await c.store.putJson(`${dir}/settlement.json`, rec);
  await c.state.addIndex(c.ns, [{ kind: 'KALSHI_SETTLEMENT', key: `${rel.release_date}/${tag}`, ok: true, at: iso(at), path: dir }]);
  c.ledger('KALSHI_SETTLEMENT', { release_date: rel.release_date, tag, final: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.all_final])) });
}

const blsMonthTag = (ref) => `${ref.slice(0, 4)} M${ref.slice(5, 7)}`;
export async function blsCapture(c, rel, which, late) {
  const [mm, dd, yyyy] = [rel.release_date.slice(5, 7), rel.release_date.slice(8, 10), rel.release_date.slice(0, 4)];
  const url = which === 'current' ? 'https://www.bls.gov/news.release/empsit.htm' : `https://www.bls.gov/news.release/archives/empsit_${mm}${dd}${yyyy}.htm`;
  const r = await c.get(url);
  const html = r.ok ? dec.decode(r.body) : '';
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
  const matches = !!title && title.includes(blsMonthTag(rel.reference_month));
  if (!r.ok || !matches) { if (late && which === 'current') await c.alert('BLS_LATE', `${rel.reference_month} not on ${url} (http ${r.meta.status ?? r.meta.error}, title ${title})`); return false; }
  const at = c.now();
  const dir = `bls/${rel.reference_month}/${which}/${compactUtc(at)}`;
  const name = which === 'current' ? 'empsit.htm' : `empsit_${mm}${dd}${yyyy}.htm`;
  await c.store.put(`${dir}/${name}`, r.body, 'text/html');
  const embargo = (html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').match(/embargoed until[^.]*?\d{4}/i) || [])[0] || null;
  await c.store.putJson(`${dir}/capture.json`, { kind: 'BLS_EMPSIT', which, status: 'OK', release: rel, title, embargo_text: embargo, seconds_after_scheduled_release: +((Date.parse(r.meta.response_completed_utc) - Date.parse(rel.release_at)) / 1000).toFixed(1), file: { ...r.meta, file: name }, clock: clockRecord(c, [r.meta]), code: c.code, mode: c.mode, note: 'As-published first print document. Parsed later by the frozen V1/extension parsers; never parsed here.' });
  await c.state.addIndex(c.ns, [{ kind: which === 'current' ? 'BLS_CURRENT' : 'BLS_ARCHIVE', key: rel.reference_month, ok: true, at: iso(at), path: dir }]);
  c.ledger('BLS_EMPSIT', { reference_month: rel.reference_month, which, sha256: r.meta.sha256 });
  return true;
}

export async function dolCheck(c, idx, enabledAt) {
  const r = await c.get('https://www.dol.gov/ui/data.pdf');
  if (r.ok) {
    const key = r.meta.sha256.slice(0, 16);
    if (!idx.has('DOL_WEEKLY', key)) {
      const dir = `dol/weekly-data-pdf/${key}`;
      await c.store.put(`${dir}/data.pdf`, r.body, 'application/pdf');
      await c.store.putJson(`${dir}/capture.json`, { kind: 'DOL_WEEKLY_CLAIMS', status: 'OK', first_seen_utc: r.meta.response_completed_utc, file: { ...r.meta, file: 'data.pdf' }, clock: clockRecord(c, [r.meta]), code: c.code, mode: c.mode, note: 'First time this exact document was seen at the current-release URL. Release identity is read later from its embargo line.' });
      await c.state.addIndex(c.ns, [{ kind: 'DOL_WEEKLY', key, ok: true, at: r.meta.response_completed_utc, path: dir }]);
      c.ledger('DOL_NEW', { sha256: r.meta.sha256, last_modified: r.meta.last_modified });
    }
  } else await c.alert('DOL_FETCH_FAILED', `data.pdf http ${r.meta.status ?? r.meta.error}`);
  // the dated archive copies, only for releases since collection began (older ones are already in the V1 raw archive)
  if (c.throttled('dol_listing', 6 * 3600000)) return;
  const year = etParts(c.now()).date.slice(0, 4);
  const listing = `https://oui.doleta.gov/press/${year}/`;
  const lr = await c.get(listing);
  if (!lr.ok) return;
  for (const name of [...new Set([...dec.decode(lr.body).matchAll(/href="(\d{6}\.pdf)"/gi)].map((m) => m[1]))]) {
    const ymd = `20${name.slice(4, 6)}-${name.slice(0, 2)}-${name.slice(2, 4)}`;
    if (ymd < iso(enabledAt).slice(0, 10)) continue;
    const key = `${year}/${name.replace('.pdf', '')}`;
    if (idx.has('DOL_PRESS', key)) continue;
    const f = await c.get(`https://oui.doleta.gov/press/${year}/${name}`);
    if (!f.ok) continue;
    const dir = `dol/press-archive/${key}`;
    await c.store.put(`${dir}/${name}`, f.body, 'application/pdf');
    await c.store.putJson(`${dir}/capture.json`, { kind: 'DOL_PRESS_ARCHIVE', status: 'OK', listing_url: listing, file: { ...f.meta, file: name }, clock: clockRecord(c, [f.meta]), code: c.code, mode: c.mode });
    await c.state.addIndex(c.ns, [{ kind: 'DOL_PRESS', key, ok: true, at: f.meta.response_completed_utc, path: dir }]);
    c.ledger('DOL_ARCHIVE', { name, sha256: f.meta.sha256 });
  }
}

export async function scheduleRefresh(c, st) {
  const r = await c.get('https://www.bls.gov/schedule/news_release/empsit.htm');
  if (!r.ok) { await c.alert('SCHEDULE_FETCH_FAILED', `BLS schedule http ${r.meta.status ?? r.meta.error}`); return; }
  const rows = parseBlsSchedule(dec.decode(r.body));
  if (rows.length < 3) { await c.alert('SCHEDULE_PARSE_FAILED', `parsed ${rows.length} rows`); return; }
  const prev = st.calendar || null;
  // releases already known are never dropped from the calendar if BLS rolls them off the page
  const merged = new Map((prev || []).map((x) => [x.reference_month, x]));
  const changes = [];
  for (const x of rows) { const o = merged.get(x.reference_month); if (!o || o.release_at !== x.release_at) changes.push({ reference_month: x.reference_month, from: o?.release_at ?? null, to: x.release_at }); merged.set(x.reference_month, x); }
  if (!prev || changes.length) {
    const raw = `calendar/raw/${compactUtc(c.now())}_empsit-schedule.htm`;
    await c.store.put(raw, r.body, 'text/html');
    st.calendar = [...merged.values()].sort((a, b) => a.reference_month.localeCompare(b.reference_month));
    await c.store.putJson(CAL, { source: r.meta.url, fetched: r.meta, raw_file: raw, releases: st.calendar });
    c.ledger('CALENDAR', { changes });
    if (prev && changes.some((x) => x.from)) await c.alert('CALENDAR_CHANGED', JSON.stringify(changes.filter((x) => x.from)));
  }
}

// ---------- index view ----------
export function indexView(rows) {
  const set = new Set(rows.map((r) => `${r.kind}|${r.key}`));
  const okSet = new Set(rows.filter((r) => r.ok).map((r) => `${r.kind}|${r.key}`));
  return {
    has: (kind, key) => set.has(`${kind}|${key}`),
    newest: (kind) => rows.filter((r) => r.kind === kind).map((r) => r.at).filter(Boolean).sort().at(-1),
    have: {
      slotOk: (key) => okSet.has(`KALSHI_SNAPSHOT|${key}`),
      missed: (key) => set.has(`MISSED|${key}`),
      settlement: (key) => set.has(`KALSHI_SETTLEMENT|${key}`),
      blsCurrent: (ref) => okSet.has(`BLS_CURRENT|${ref}`),
      blsArchive: (ref) => okSet.has(`BLS_ARCHIVE|${ref}`),
    },
  };
}

// ---------- one tick ----------
// c: { mode, ns, store, state, get, kalshiBase, now, sleep, code, host, deliver?, healthPing?, calendarOverride?, onlyKalshi? }
export async function tick(c) {
  const holder = `${c.mode}:${crypto.randomUUID()}`;
  if (!(await c.state.acquire(c.ns, holder, 10 * 60000, c.now()))) return { skipped: 'locked' };
  const st = await c.state.getState(c.ns);
  // idempotency: at most one tick per namespace per 5-minute bucket, whichever trigger (alarm, cron, manual) comes first
  const bucket = Math.floor(c.now() / 300000);
  if (st.last_bucket === bucket) { await c.state.release(c.ns, holder); return { skipped: 'bucket_already_ticked', bucket_utc: iso(bucket * 300000), trigger: c.trigger || null }; }
  st.last_bucket = bucket;
  st.alerts ||= {}; st.throttle ||= {};
  const entries = [];
  c.ledger = (type, data = {}) => { const e = { type, at_utc: iso(c.now()), collector: COLLECTOR_VERSION, mode: c.mode, ...data }; entries.push(e); };
  c.throttled = (key, ms) => { const last = st.throttle[key] || 0; if (c.now() - last < ms) return true; st.throttle[key] = c.now(); return false; };
  const deliveries = [];
  c.alert = async (kind, message) => {
    c.ledger('ALERT', { kind, message });
    const day = etParts(c.now()).date; const dedupe = `${kind}|${message.slice(0, 60)}`;
    if (st.alerts[dedupe] === day) return;
    st.alerts[dedupe] = day;
    const results = c.deliver ? await c.deliver(kind, message) : { external: 'disabled' };
    deliveries.push(kind);
    c.ledger('ALERT_DELIVERY', { kind, results });
  };
  const did = []; let error = null;
  const now = c.now();
  try {
    if (!st.enabled_at) { st.enabled_at = iso(now); c.ledger('INIT', { code: c.code, enabled_at: st.enabled_at, note: `${c.mode} namespace initialised` }); }
    const enabledAt = Date.parse(st.enabled_at);
    if (st.last_tick_utc && now - Date.parse(st.last_tick_utc) > TICK_GAP_MS) {
      const mins = Math.round((now - Date.parse(st.last_tick_utc)) / 60000);
      c.ledger('GAP', { from_utc: st.last_tick_utc, to_utc: iso(now), minutes: mins, note: 'no collector tick ran in this interval (Cron Trigger not delivered, Worker error, or collector disabled)' });
      did.push(`gap ${mins}m`);
      if (mins >= 60) await c.alert('OFFLINE_GAP', `no tick from ${st.last_tick_utc} to ${iso(now)} (${mins} min)`);
    }
    const day = etParts(now).date;
    if (!c.calendarOverride && (!st.calendar || (st.schedule_day !== day && etParts(now).hh >= 6))) { await scheduleRefresh(c, st); st.schedule_day = day; }
    const calendar = c.calendarOverride || st.calendar || [];
    let idx = indexView(await c.state.index(c.ns));
    for (const a of plan(now, { calendar, enabledAt, have: idx.have })) {
      if (c.onlyKalshi && !['KALSHI_SNAPSHOT', 'MISSED'].includes(a.type)) continue;
      if (a.type === 'KALSHI_SNAPSHOT') { const s = await kalshiSnapshot(c, a.release, a.slot, a.slot_at); did.push(`${a.key} ${s.status}`); }
      if (a.type === 'MISSED') {
        await c.store.putJson(`kalshi/${a.key}/MISSED.json`, { kind: 'MISSED', release: a.release, slot: a.slot, slot_at_utc: iso(a.slot_at), detected_utc: iso(now), reason: 'no complete snapshot finished inside [slot - 15 min, slot); never backfilled', clock: clockRecord(c), mode: c.mode });
        await c.state.addIndex(c.ns, [{ kind: 'MISSED', key: a.key, ok: false, at: iso(now), path: `kalshi/${a.key}` }]);
        c.ledger('MISSED', { key: a.key, slot_at_utc: iso(a.slot_at) });
        await c.alert('MISSED_SNAPSHOT', `${a.key} (slot ${iso(a.slot_at)}) has no on-time snapshot`);
        did.push(`${a.key} MISSED`);
      }
      if (a.type === 'KALSHI_SETTLEMENT' && !c.throttled(`settle ${a.release.release_date}/${a.tag}`, 3600000)) { await kalshiSettlement(c, a.release, a.tag); did.push(`${a.release.release_date}/${a.tag}`); }
      if ((a.type === 'BLS_CURRENT' || a.type === 'BLS_ARCHIVE') && !c.throttled(`${a.type} ${a.release.reference_month}`, 10 * 60000)) {
        if (await blsCapture(c, a.release, a.type === 'BLS_CURRENT' ? 'current' : 'archive', a.late)) did.push(`bls ${a.release.reference_month} ${a.type}`);
      }
    }
    if (!c.onlyKalshi) {
      idx = indexView(await c.state.index(c.ns));
      const e = etParts(now); const weekday = !['Sat', 'Sun'].includes(e.weekday); const mins = e.hh * 60 + e.mm;
      if (weekday && mins >= 8 * 60 + 31 && mins <= 20 * 60 && !c.throttled('dol', (e.weekday === 'Thu' && mins < 10 * 60) ? 4 * 60000 : 30 * 60000)) await dolCheck(c, idx, enabledAt);
      const newest = indexView(await c.state.index(c.ns)).newest('DOL_WEEKLY');
      if (now - enabledAt > 8 * 86400000 && (!newest || now - Date.parse(newest) > 8 * 86400000)) await c.alert('DOL_STALE', `no new DOL weekly release since ${newest}`);
    }
    if (st.heartbeat_day !== day) {
      const next = calendar.flatMap((r) => slotTimes(r).map((s) => ({ key: `${r.release_date}/${s.slot}`, at: iso(s.at) }))).filter((s) => Date.parse(s.at) > now).slice(0, 3);
      const integrity = await chainTailCheck(c, st);
      c.ledger('HEARTBEAT', { next_slots: next, ledger_chain: integrity, code: c.code });
      if (integrity.status === 'BROKEN') await c.alert('LEDGER_CHAIN_BROKEN', JSON.stringify(integrity).slice(0, 280));
      st.heartbeat_day = day; did.push('heartbeat');
      // daily OK digest (its absence is the human-visible dead-man signal); counts and keys only, no prices
      if (c.daily) {
        const recent = (await c.state.ticks(c.ns, 300)).filter((t) => Date.parse(t.at_utc) > now - 86400000);
        const by = recent.reduce((a, t) => ((a[t.trigger || 'unknown'] = (a[t.trigger || 'unknown'] || 0) + 1), a), {});
        const res = await c.daily([`Mode: ${c.mode}`, `Ticks in the last 24 h: ${recent.length} (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); errors: ${recent.filter((t) => t.error).length}`, `Ledger chain: ${integrity.status}${st.chain ? ` at seq ${st.chain.seq}` : ''}`, `Next slots: ${next.map((x) => `${x.key} ${x.at}`).join('; ') || 'none'}`, `Kalshi auth: ${c.code.kalshi_auth}`].join('\n'));
        c.ledger('DAILY_DIGEST', { results: res });
      }
    }
    const ck = clockCheck(c.lastFiles?.() || []);
    if (ck.median_server_minus_worker_ms !== null && Math.abs(ck.median_server_minus_worker_ms) > 2000) await c.alert('CLOCK', `server Date headers differ from the Workers clock by ${ck.median_server_minus_worker_ms} ms (median of ${ck.samples})`);
  } catch (e) {
    error = String(e?.stack || e).replace(/\s+/g, ' ').slice(0, 400);
    did.push('ERROR');
    try { await c.alert('TICK_ERROR', String(e?.message || e).slice(0, 300)); } catch { /* best effort */ }
  }
  // Audit ledger: every entry is hash-chained to the previous one (seq, prev, hash), and a TICK_SEAL entry binds the
  // sha256 of every evidence object written this tick into the chain. The chained lines become ONE write-once R2 object
  // per tick (R2 assigns its upload time; it cannot be backdated) and append-only Durable Object rows. If the R2 write
  // fails the chain does not advance and the entries are carried to the next tick, never dropped.
  let sealed = null;
  try {
    const evidence = c.store.written.map((w) => ({ path: w.path, sha256: w.sha256 }));
    const pending = [...(st.unsealed || []), ...entries];
    if (evidence.length || pending.length) {
      pending.push({ type: 'TICK_SEAL', at_utc: iso(c.now()), collector: COLLECTOR_VERSION, mode: c.mode, tick_utc: iso(now), files: evidence });
      const { out, chain } = await chainEntries(pending, st.chain);
      const key = `ledger-ticks/${iso(now).slice(0, 7)}/${compactUtc(now)}.jsonl`;
      await c.store.put(key, out.map((x) => JSON.stringify(x)).join(NL) + NL, 'application/x-ndjson');
      await c.state.appendLedger(c.ns, out);
      st.chain = chain; st.last_ledger_key = key; st.unsealed = [];
      sealed = { seq: chain.seq, head: chain.head.slice(0, 16), entries: out.length, files: evidence.length };
    }
  } catch (e) { st.unsealed = [...(st.unsealed || []), ...entries].slice(-500); error ||= `ledger write failed: ${String(e?.message || e).slice(0, 200)}`; }
  // External anchor (B3 V7): RFC 3161 token over the new chain head, stored write-once beside the ledger. A failure is
  // alerted but never blocks collection; the evidence without an anchor simply cannot satisfy V7.
  if (sealed && c.anchor) {
    try {
      const a = await c.anchor(st.chain.head);
      if (a.ok) {
        const key = `ledger-anchors/${iso(now).slice(0, 7)}/${compactUtc(now)}_seq${st.chain.seq}.tsr`;
        await c.store.put(key, a.bytes, 'application/timestamp-reply');
        sealed.anchor = { tsa: a.tsa, gen_time_utc: a.gen_time_utc, key };
        st.last_anchor = { seq: st.chain.seq, head: st.chain.head, tsa: a.tsa, gen_time_utc: a.gen_time_utc, key };
      } else {
        sealed.anchor = { failed: a.errors };
        if (c.deliver) await c.deliver('ANCHOR_FAILED', `RFC 3161 anchor for ledger seq ${st.chain.seq} failed at every TSA`);
      }
    } catch (e) { sealed.anchor = { failed: String(e?.message || e).slice(0, 160) }; }
  }
  st.last_tick_utc = iso(now);
  if (error) st.last_error = { at_utc: iso(now), error }; else st.last_ok_utc = iso(now);
  for (const [k, d] of Object.entries(st.alerts)) if (d < etParts(now - 3 * 86400000).date) delete st.alerts[k];
  await c.state.putState(c.ns, st);
  const rec = { at_utc: iso(now), trigger: c.trigger || null, scheduled_utc: c.scheduledTime ? iso(c.scheduledTime) : null, did: did.join('; ') || '-', files_written: c.store.written.length, ledger: sealed, alerts: deliveries, error };
  await c.state.addTick(c.ns, rec);
  await c.state.release(c.ns, holder);
  if (c.healthPing) await c.healthPing(!error);
  return rec;
}

// Daily: the last sealed ledger object in R2 must still end at the chain head held by the Durable Object.
async function chainTailCheck(c, st) {
  if (!st.chain) return { status: 'EMPTY' };
  try {
    const b = await c.store.getBytes(st.last_ledger_key);
    if (!b) return { status: 'BROKEN', reason: 'last ledger object missing', key: st.last_ledger_key };
    const last = JSON.parse(dec.decode(b).trim().split(NL).at(-1));
    return last.hash === st.chain.head && last.seq === st.chain.seq ? { status: 'OK', seq: st.chain.seq, head: st.chain.head } : { status: 'BROKEN', reason: 'tail mismatch', key: st.last_ledger_key, r2_seq: last.seq, do_seq: st.chain.seq };
  } catch (e) { return { status: 'CHECK_FAILED', error: String(e?.message || e).slice(0, 160) }; }
}
