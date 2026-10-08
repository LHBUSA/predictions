#!/usr/bin/env node
// Employment Tier A research collector (owner-approved 2026-10-08). DATA AND PRICES ONLY: no model fitting, no forecast,
// no trading, no production system. Writes append-only evidence to a private git repo (LHBUSA/pbe-employment-evidence).
// Runs from Windows Task Scheduler every 5 minutes (`tick`). Never touches the pbe-predictions Worker, tkmln or CPI SHADOW.
//   node collect.mjs tick [--no-push]       scheduled entry point
//   node collect.mjs adhoc-snapshot         labelled ADHOC Kalshi snapshot of the next release (validation only)
//   node collect.mjs verify                 re-hash every evidence file, re-derive every order book, check MISSED vs OK
//   node collect.mjs test-alert             exercise every alert channel
//   node collect.mjs status
// Timestamps: every *_utc field is the local clock corrected by the median SNTP offset measured in the same run
// (Windows Time is not running on this host and cannot be started without admin), with the raw offset recorded.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLECTOR_VERSION, SERIES, TICK_GAP_MS, compactUtc, deriveBook, etParts, eventTicker, parseBlsSchedule, plan, slotTimes, takerFee } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = process.env.EMP_EVIDENCE_DIR || 'E:\\Workers\\employment-evidence';
const REPO = process.env.EMP_EVIDENCE_REPO || 'LHBUSA/pbe-employment-evidence';
// secrets and the fallback log live on NTFS C: under a user-only ACL (D:/E: are exFAT and cannot be access-controlled)
const SECRET_DIR = process.env.EMP_SECRET_DIR || 'C:\\Users\\goodl\\.pbe-employment-collector';
const WEBHOOK_FILE = join(SECRET_DIR, 'alert-webhook-url'); // ntfy.sh topic URL or Slack-compatible incoming webhook
const HEALTHCHECK_FILE = join(SECRET_DIR, 'healthcheck-url'); // optional dead-man's switch (pinged every successful tick)
const FALLBACK_LOG = join(SECRET_DIR, 'fallback.log');
const STATE_DIR = join(EVIDENCE, '.state');
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const UA = 'Mozilla/5.0 (compatible; research-bot)';
const NTP_HOSTS = ['time.cloudflare.com', 'time.google.com', 'time.windows.com'];
const MIN_FREE_BYTES = 1.5e9;
const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const NO_PUSH = args.includes('--no-push');
const NO_EXTERNAL_ALERT = args.includes('--no-external-alert');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); };
const sh = (bin, a, cwd = EVIDENCE) => execFileSync(bin, a, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...a) => sh('git', ['-c', 'safe.directory=*', ...a]);

// ---------- clock ----------
function sntp(host, timeout = 2000) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4'); const msg = Buffer.alloc(48); msg[0] = 0x23; let t0 = 0; let done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(timer); try { s.close(); } catch { /* closed */ } resolve(v); };
    const timer = setTimeout(() => end(null), timeout);
    s.on('error', () => end(null));
    s.on('message', (b) => {
      const t3 = Date.now();
      const rd = (o) => (b.readUInt32BE(o) - 2208988800) * 1000 + (b.readUInt32BE(o + 4) * 1000) / 2 ** 32;
      const t1 = rd(32); const t2 = rd(40);
      end({ host, offset_ms: +(((t1 - t0) + (t2 - t3)) / 2).toFixed(1), rtt_ms: +((t3 - t0) - (t2 - t1)).toFixed(1), stratum: b[1] });
    });
    t0 = Date.now(); s.send(msg, 123, host, (e) => { if (e) end(null); });
  });
}
// Windows Time service status as reported by w32tm (works without admin while the service runs)
function windowsTime() {
  try {
    const out = sh('w32tm', ['/query', '/status'], HERE);
    const f = (k) => (out.match(new RegExp(`^${k}:\\s*(.*)$`, 'mi')) || [])[1]?.trim() ?? null;
    return { running: true, source: f('Source'), last_successful_sync: f('Last Successful Sync Time'), leap_indicator: f('Leap Indicator'), stratum: f('Stratum'), poll_interval: f('Poll Interval') };
  } catch (e) { return { running: false, error: String(e.stdout || e.message).trim().slice(0, 160) }; }
}
async function measureClock() {
  const samples = (await Promise.all(NTP_HOSTS.map((h) => sntp(h)))).filter((x) => x && x.stratum > 0 && x.stratum < 16);
  const offs = samples.map((x) => x.offset_ms).sort((a, b) => a - b);
  const offset = offs.length ? offs[Math.floor(offs.length / 2)] : 0;
  return { source: offs.length ? 'sntp-median' : 'local-unsynchronized', offset_ms: offset, samples, measured_at_local_clock_utc: new Date().toISOString(), windows_time: windowsTime(), now: () => Date.now() + offset };
}
let clock = { now: () => Date.now(), offset_ms: 0, source: 'uninitialized', samples: [] };
const iso = (ms) => new Date(ms).toISOString();
const clockRecord = () => ({ source: clock.source, offset_ms: clock.offset_ms, samples: clock.samples, measured_at_local_clock_utc: clock.measured_at_local_clock_utc, windows_time: clock.windows_time, note: 'Every *_utc = raw local clock + offset_ms (median SNTP, independent of Windows Time); raw local readings are kept as *_local_clock_utc.' });

// ---------- http ----------
async function get(url, { tries = 3, timeoutMs = 25000 } = {}) {
  for (let i = 1; ; i++) {
    const rawStart = Date.now(); const started = rawStart + clock.offset_ms;
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
      const body = Buffer.from(await r.arrayBuffer());
      const rawEnd = Date.now();
      const meta = { url, status: r.status, attempt: i, request_started_utc: iso(started), response_completed_utc: iso(rawEnd + clock.offset_ms), request_started_local_clock_utc: iso(rawStart), response_completed_local_clock_utc: iso(rawEnd), server_date: r.headers.get('date'), last_modified: r.headers.get('last-modified'), etag: r.headers.get('etag'), content_type: r.headers.get('content-type'), bytes: body.length, sha256: sha(body) };
      if ((r.status === 429 || r.status >= 500) && i < tries) { await sleep(1500 * i); continue; }
      return { ok: r.status === 200, body, meta };
    } catch (e) {
      if (i < tries) { await sleep(1500 * i); continue; }
      return { ok: false, body: null, meta: { url, error: String(e?.message || e), attempt: i, request_started_utc: iso(started), response_completed_utc: iso(clock.now()) } };
    }
  }
}
// one capture directory: raw bodies exactly as received + a meta list with sha256 per file
class Capture {
  constructor(dir) { this.dir = dir; this.files = []; this.n = 0; mkdirSync(dir, { recursive: true }); }
  async get(label, ext, url, opts) {
    const res = await get(url, opts);
    const name = `${String(++this.n).padStart(3, '0')}_${label.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`;
    if (res.body && res.body.length) { writeFileSync(join(this.dir, name), res.body); res.meta.file = name; }
    this.files.push(res.meta);
    await sleep(120);
    return res;
  }
}

// ---------- evidence index (derived from the repo, not from local state) ----------
const ls = (p) => (existsSync(p) ? readdirSync(p) : []);
const captures = (p, file) => ls(p).filter((d) => existsSync(join(p, d, file))).map((d) => ({ dir: join(p, d), ...readJson(join(p, d, file), {}) }));
const have = {
  slotOk: (key) => captures(join(EVIDENCE, 'kalshi', key), 'snapshot.json').some((c) => c.status === 'OK' && c.completed_before_slot === true),
  missed: (key) => existsSync(join(EVIDENCE, 'kalshi', key, 'MISSED.json')),
  settlement: (key) => captures(join(EVIDENCE, 'kalshi', key), 'settlement.json').length > 0,
  blsCurrent: (ref) => captures(join(EVIDENCE, 'bls', ref, 'current'), 'capture.json').some((c) => c.status === 'OK'),
  blsArchive: (ref) => captures(join(EVIDENCE, 'bls', ref, 'archive'), 'capture.json').some((c) => c.status === 'OK'),
};

// ---------- ledger, state, alerts ----------
function ledger(type, data = {}) {
  const at = clock.now();
  const p = join(EVIDENCE, 'ledger', `${iso(at).slice(0, 7)}.jsonl`);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ type, at_utc: iso(at), collector: COLLECTOR_VERSION, ...data }) + '\n');
}
const statePath = join(STATE_DIR, 'state.json');
const loadState = () => readJson(statePath, { alerts: {}, throttle: {} });
const saveState = (s) => writeJson(statePath, s);
let state;
function throttled(key, ms) { const last = state.throttle[key] || 0; if (clock.now() - last < ms) return true; state.throttle[key] = clock.now(); return false; }

// Off-machine delivery. ntfy.sh topics get a plain-text body with a Title header; anything else gets Slack-style JSON.
async function deliverWebhook(title, message) {
  if (!existsSync(WEBHOOK_FILE)) return 'not configured';
  const url = readFileSync(WEBHOOK_FILE, 'utf8').trim();
  const ntfy = /^https:\/\/ntfy\.sh\/[A-Za-z0-9_-]+$/.test(url);
  const r = await fetch(url, ntfy
    ? { method: 'POST', headers: { Title: title, Priority: 'high', Tags: 'warning' }, body: message, signal: AbortSignal.timeout(10000) }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${title}: ${message}` }), signal: AbortSignal.timeout(10000) });
  return r.status;
}
// Used when the evidence drive itself is unavailable: no ledger, no state, so de-dup and log live on C:
async function fallbackAlert(kind, message) {
  mkdirSync(SECRET_DIR, { recursive: true });
  appendFileSync(FALLBACK_LOG, `${new Date().toISOString()}\t${kind}\t${message}\n`);
  const mark = join(SECRET_DIR, `last-${kind}`); const day = etParts(Date.now()).date;
  if (existsSync(mark) && readFileSync(mark, 'utf8') === day) return;
  writeFileSync(mark, day);
  let res; try { res = await deliverWebhook(`Employment collector: ${kind}`, message); } catch (e) { res = `failed: ${e.message}`; }
  appendFileSync(FALLBACK_LOG, `${new Date().toISOString()}\t${kind}\twebhook=${res}\n`);
}

async function alert(kind, message) {
  ledger('ALERT', { kind, message });
  const day = etParts(clock.now()).date;
  // external delivery at most once per kind+subject per ET day; the ledger keeps every occurrence
  const dedupe = `${kind}|${message.slice(0, 60)}`;
  if (state.alerts[dedupe] === day) return;
  state.alerts[dedupe] = day;
  const title = `Employment collector: ${kind}`;
  const results = {};
  try {
    const q = (s) => s.replace(/'/g, "''");
    const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode('${q(title)}')) | Out-Null; $x.Item(1).AppendChild($t.CreateTextNode('${q(message.slice(0, 200))}')) | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
    sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], HERE);
    results.toast = 'ok';
  } catch (e) { results.toast = `failed: ${String(e.message).slice(0, 120)}`; }
  if (!NO_EXTERNAL_ALERT) {
    try { results.github_issue = sh('gh', ['issue', 'create', '-R', REPO, '-t', `${title} (${day})`, '-b', `${message}\n\nat ${iso(clock.now())} from ${hostname()} (${COLLECTOR_VERSION})`], HERE); } catch (e) { results.github_issue = `failed: ${String(e.message).slice(0, 120)}`; }
    try { results.webhook = await deliverWebhook(title, message); } catch (e) { results.webhook = `failed: ${String(e.message).slice(0, 120)}`; }
  }
  ledger('ALERT_DELIVERY', { kind, results });
}

// ---------- code identity ----------
function codeIdentity() {
  const files = ['collect.mjs', 'lib.mjs'].map((f) => [f, sha(readFileSync(join(HERE, f)))]);
  let commit = null; let dirty = null;
  try { commit = sh('git', ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'], HERE); dirty = sh('git', ['-c', 'safe.directory=*', 'status', '--porcelain', '--', '.'], HERE) !== ''; } catch { /* not a checkout */ }
  return { version: COLLECTOR_VERSION, commit, dirty, files: Object.fromEntries(files), path: HERE };
}

// ---------- captures ----------
async function kalshiSnapshot(rel, slot, slotAt) {
  const started = clock.now();
  const dir = join(EVIDENCE, 'kalshi', rel.release_date, slot, compactUtc(started));
  const cap = new Capture(dir);
  const series = {};
  for (const s of SERIES) {
    const ev = eventTicker(s, rel.reference_month);
    const sr = await cap.get(`series_${s}`, 'json', `${KALSHI}/series/${s}`);
    const srec = sr.ok ? JSON.parse(sr.body).series : null;
    const er = await cap.get(`event_${ev}`, 'json', `${KALSHI}/events/${ev}`);
    if (!er.ok) { series[s] = { event_ticker: ev, status: er.meta.status === 404 ? 'EVENT_NOT_LISTED' : 'ERROR', http: er.meta.status ?? er.meta.error }; continue; }
    const markets = []; let cursor = ''; let page = 0; let listOk = true;
    do {
      const mr = await cap.get(`markets_${ev}_p${++page}`, 'json', `${KALSHI}/markets?event_ticker=${ev}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!mr.ok) { listOk = false; break; }
      const j = JSON.parse(mr.body); markets.push(...(j.markets || [])); cursor = j.cursor || '';
    } while (cursor && page < 10);
    const terms = {};
    for (const [k, url] of [['contract_terms_url', srec?.contract_terms_url], ['contract_url', srec?.contract_url]]) {
      if (!url) { terms[k] = null; continue; }
      const r = await get(url);
      if (r.ok) { const p = join(EVIDENCE, 'kalshi', 'terms', `${r.meta.sha256}.pdf`); if (!existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, r.body); } }
      terms[k] = { ...r.meta, stored_as: r.ok ? `kalshi/terms/${r.meta.sha256}.pdf` : null };
    }
    const contracts = [];
    for (const m of markets) {
      const ob = await cap.get(`orderbook_${m.ticker}`, 'json', `${KALSHI}/markets/${m.ticker}/orderbook`);
      const book = ob.ok ? deriveBook(JSON.parse(ob.body)) : null;
      contracts.push({
        ticker: m.ticker, status: m.status, strike_type: m.strike_type, floor_strike: m.floor_strike ?? null, cap_strike: m.cap_strike ?? null,
        close_time: m.close_time, expected_expiration_time: m.expected_expiration_time ?? null,
        close_date_et: m.close_time ? etParts(Date.parse(m.close_time)).date : null,
        rules_primary_sha256: sha(String(m.rules_primary || '')), rules_secondary_sha256: sha(String(m.rules_secondary || '')),
        orderbook_file: ob.meta.file || null, orderbook_http: ob.meta.status ?? ob.meta.error, orderbook_completed_utc: ob.meta.response_completed_utc,
        book: book && { best_yes_bid: book.best_yes_bid, best_yes_bid_size: book.best_yes_bid_size, best_yes_ask: book.best_yes_ask, best_yes_ask_size: book.best_yes_ask_size, mid: book.mid, spread: book.spread, two_sided: book.two_sided, levels_yes_bid: book.yes_bids_desc.length, levels_no_bid: book.no_bids_desc.length, depth_yes_bid_contracts: book.depth_yes_bid_contracts, depth_no_bid_contracts: book.depth_no_bid_contracts },
        taker_fee_1_contract: book && { buy_yes_at_ask: takerFee(srec?.fee_type, srec?.fee_multiplier, book.best_yes_ask), buy_no_at_1_minus_bid: takerFee(srec?.fee_type, srec?.fee_multiplier, book.best_yes_bid === null ? null : +(1 - book.best_yes_bid).toFixed(4)) },
        market_record: { yes_bid_dollars: m.yes_bid_dollars, yes_ask_dollars: m.yes_ask_dollars, yes_bid_size_fp: m.yes_bid_size_fp, yes_ask_size_fp: m.yes_ask_size_fp, last_price_dollars: m.last_price_dollars, volume_24h_fp: m.volume_24h_fp, volume_fp: m.volume_fp, open_interest_fp: m.open_interest_fp },
      });
    }
    const complete = listOk && contracts.every((c) => c.orderbook_http === 200);
    series[s] = {
      event_ticker: ev, status: complete ? 'OK' : 'INCOMPLETE', markets_listed: markets.length, orderbooks_ok: contracts.filter((c) => c.orderbook_http === 200).length,
      fee: srec && { fee_type: srec.fee_type, fee_multiplier: srec.fee_multiplier, formula: 'ceil(100 * 0.07 * fee_multiplier * C * P * (1 - P)) / 100 (taker, quadratic*)' },
      terms, close_dates_et: [...new Set(contracts.map((c) => c.close_date_et))], close_matches_bls_release_date: contracts.every((c) => c.close_date_et === rel.release_date),
      contracts,
    };
  }
  const completed = clock.now();
  const listed = Object.values(series).filter((x) => x.status !== 'EVENT_NOT_LISTED');
  const status = listed.length && listed.every((x) => x.status === 'OK') ? 'OK' : 'INCOMPLETE';
  const lastResponse = Math.max(...cap.files.map((f) => Date.parse(f.response_completed_utc)));
  const snap = {
    kind: 'KALSHI_SNAPSHOT', slot, release: rel, slot_at_utc: slotAt ? iso(slotAt) : null, started_utc: iso(started), completed_utc: iso(completed),
    completed_before_slot: slotAt ? lastResponse < slotAt : null, seconds_before_slot: slotAt ? +((slotAt - lastResponse) / 1000).toFixed(1) : null,
    status, series, clock: clockRecord(), code: codeIdentity(), host: hostname(), files: cap.files,
    note: 'Research evidence only. Never a model input. Prices are executable top-of-book at fetch time; YES ask = 1 - best NO bid.',
  };
  writeJson(join(dir, 'snapshot.json'), snap);
  ledger('KALSHI_SNAPSHOT', { release_date: rel.release_date, slot, dir: dir.slice(EVIDENCE.length + 1).replace(/\\/g, '/'), status, completed_before_slot: snap.completed_before_slot, contracts: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.markets_listed ?? v.status])) });
  if (status !== 'OK') await alert('SNAPSHOT_INCOMPLETE', `${rel.release_date} ${slot}: ${JSON.stringify(Object.fromEntries(Object.entries(series).map(([k, v]) => [k, `${v.status} ${v.orderbooks_ok ?? ''}/${v.markets_listed ?? ''}`])))}`);
  for (const [k, v] of Object.entries(series)) if (v.status === 'OK' && !v.close_matches_bls_release_date) await alert('CALENDAR_MISMATCH', `${k} ${v.event_ticker} closes on ${v.close_dates_et.join(',')} but BLS schedules the release on ${rel.release_date}`);
  return snap;
}

async function kalshiSettlement(rel, tag) {
  const at = clock.now();
  const dir = join(EVIDENCE, 'kalshi', rel.release_date, tag, compactUtc(at));
  const cap = new Capture(dir);
  const out = {};
  for (const s of SERIES) {
    const ev = eventTicker(s, rel.reference_month);
    const mr = await cap.get(`markets_${ev}`, 'json', `${KALSHI}/markets?event_ticker=${ev}&limit=200`);
    const ms = mr.ok ? JSON.parse(mr.body).markets || [] : [];
    out[s] = { event_ticker: ev, http: mr.meta.status ?? mr.meta.error, markets: ms.map((m) => ({ ticker: m.ticker, status: m.status, result: m.result ?? null, expiration_value: m.expiration_value ?? null, settlement_ts: m.settlement_ts ?? null })), all_final: ms.length > 0 && ms.every((m) => m.result === 'yes' || m.result === 'no') };
  }
  const rec = { kind: 'KALSHI_SETTLEMENT', tag, release: rel, captured_utc: iso(at), series: out, note: 'Settlement facts only. Never an observation: truth is the BLS first print (protocol B2.2).', clock: clockRecord(), code: codeIdentity(), files: cap.files };
  writeJson(join(dir, 'settlement.json'), rec);
  ledger('KALSHI_SETTLEMENT', { release_date: rel.release_date, tag, final: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.all_final])) });
}

const blsMonthTag = (ref) => `${ref.slice(0, 4)} M${ref.slice(5, 7)}`;
async function blsCapture(rel, which, late) {
  const [mm, dd, yyyy] = [rel.release_date.slice(5, 7), rel.release_date.slice(8, 10), rel.release_date.slice(0, 4)];
  const url = which === 'current' ? 'https://www.bls.gov/news.release/empsit.htm' : `https://www.bls.gov/news.release/archives/empsit_${mm}${dd}${yyyy}.htm`;
  const r = await get(url);
  const html = r.ok ? r.body.toString('utf8') : '';
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
  const matches = !!title && title.includes(blsMonthTag(rel.reference_month));
  if (!r.ok || !matches) { if (late && which === 'current') await alert('BLS_LATE', `${rel.reference_month} not on ${url} (http ${r.meta.status ?? r.meta.error}, title ${title})`); return false; }
  const at = clock.now();
  const dir = join(EVIDENCE, 'bls', rel.reference_month, which, compactUtc(at));
  mkdirSync(dir, { recursive: true });
  const name = which === 'current' ? 'empsit.htm' : `empsit_${mm}${dd}${yyyy}.htm`;
  writeFileSync(join(dir, name), r.body);
  const embargo = (html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').match(/embargoed until[^.]*?\d{4}/i) || [])[0] || null;
  writeJson(join(dir, 'capture.json'), { kind: 'BLS_EMPSIT', which, status: 'OK', release: rel, title, embargo_text: embargo, seconds_after_scheduled_release: +((Date.parse(r.meta.response_completed_utc) - Date.parse(rel.release_at)) / 1000).toFixed(1), file: { ...r.meta, file: name }, clock: clockRecord(), code: codeIdentity(), note: 'As-published first print document. Parsed later by the frozen V1/extension parsers; never parsed here.' });
  ledger('BLS_EMPSIT', { reference_month: rel.reference_month, which, sha256: r.meta.sha256 });
  return true;
}

async function dolCheck() {
  const r = await get('https://www.dol.gov/ui/data.pdf');
  if (r.ok) {
    const dir = join(EVIDENCE, 'dol', 'weekly-data-pdf', r.meta.sha256.slice(0, 16));
    if (!existsSync(join(dir, 'capture.json'))) {
      mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'data.pdf'), r.body);
      writeJson(join(dir, 'capture.json'), { kind: 'DOL_WEEKLY_CLAIMS', status: 'OK', first_seen_utc: r.meta.response_completed_utc, file: { ...r.meta, file: 'data.pdf' }, clock: clockRecord(), code: codeIdentity(), note: 'First time this exact document was seen at the current-release URL. Release identity is read later from its embargo line.' });
      ledger('DOL_NEW', { sha256: r.meta.sha256, last_modified: r.meta.last_modified });
    }
  } else await alert('DOL_FETCH_FAILED', `data.pdf http ${r.meta.status ?? r.meta.error}`);
  // the dated archive copies, only for releases since collection began (older ones are already in the V1 raw archive)
  if (throttled('dol_listing', 6 * 3600000)) return;
  const year = etParts(clock.now()).date.slice(0, 4);
  const lr = await get(`https://oui.doleta.gov/press/${year}/`);
  if (!lr.ok) return;
  const enabled = readJson(join(EVIDENCE, 'collector.json'))?.enabled_at;
  for (const name of [...new Set([...lr.body.toString('utf8').matchAll(/href="(\d{6}\.pdf)"/gi)].map((m) => m[1]))]) {
    const ymd = `20${name.slice(4, 6)}-${name.slice(0, 2)}-${name.slice(2, 4)}`;
    if (!enabled || ymd < enabled.slice(0, 10)) continue;
    const dir = join(EVIDENCE, 'dol', 'press-archive', year, name.replace('.pdf', ''));
    if (existsSync(join(dir, 'capture.json'))) continue;
    const f = await get(`https://oui.doleta.gov/press/${year}/${name}`);
    if (!f.ok) continue;
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), f.body);
    writeJson(join(dir, 'capture.json'), { kind: 'DOL_PRESS_ARCHIVE', status: 'OK', listing_url: `https://oui.doleta.gov/press/${year}/`, file: { ...f.meta, file: name }, clock: clockRecord(), code: codeIdentity() });
    ledger('DOL_ARCHIVE', { name, sha256: f.meta.sha256 });
  }
}

async function scheduleRefresh() {
  const r = await get('https://www.bls.gov/schedule/news_release/empsit.htm');
  if (!r.ok) { await alert('SCHEDULE_FETCH_FAILED', `BLS schedule http ${r.meta.status ?? r.meta.error}`); return; }
  const rows = parseBlsSchedule(r.body.toString('utf8'));
  if (rows.length < 3) { await alert('SCHEDULE_PARSE_FAILED', `parsed ${rows.length} rows`); return; }
  const p = join(EVIDENCE, 'calendar', 'bls-empsit-schedule.json');
  const prev = readJson(p);
  // releases already known are never dropped from the calendar if BLS rolls them off the page
  const merged = new Map((prev?.releases || []).map((x) => [x.reference_month, x]));
  const changes = [];
  for (const x of rows) { const o = merged.get(x.reference_month); if (!o || o.release_at !== x.release_at) changes.push({ reference_month: x.reference_month, from: o?.release_at ?? null, to: x.release_at }); merged.set(x.reference_month, x); }
  if (!prev || changes.length) {
    const raw = join(EVIDENCE, 'calendar', 'raw', `${compactUtc(clock.now())}_empsit-schedule.htm`);
    mkdirSync(dirname(raw), { recursive: true }); writeFileSync(raw, r.body);
    writeJson(p, { source: r.meta.url, fetched: r.meta, raw_file: raw.slice(EVIDENCE.length + 1).replace(/\\/g, '/'), releases: [...merged.values()].sort((a, b) => a.reference_month.localeCompare(b.reference_month)) });
    ledger('CALENDAR', { changes });
    if (prev && changes.some((c) => c.from)) await alert('CALENDAR_CHANGED', JSON.stringify(changes.filter((c) => c.from)));
  }
}

// ---------- git ----------
function commitAndPush(summary) {
  if (git('status', '--porcelain') === '') return { committed: false };
  git('add', '-A');
  const code = codeIdentity();
  git('commit', '-q', '-m', `capture: ${summary}`, '-m', `collector ${code.version} code ${code.commit}${code.dirty ? ' (dirty)' : ''} host ${hostname()}`);
  const head = git('rev-parse', 'HEAD');
  if (NO_PUSH) return { committed: head, pushed: false };
  try {
    git('push', '-q', 'origin', 'HEAD:main'); state.push_failing_since = null;
    appendFileSync(join(STATE_DIR, 'pushed-heads.log'), `${new Date(clock.now()).toISOString()}\t${head}\n`);
    return { committed: head, pushed: true };
  } catch (e) {
    state.push_failing_since ||= clock.now();
    return { committed: head, pushed: false, error: String(e.message).slice(0, 200) };
  }
}

// The remote must still contain the last head this collector pushed (detects a rewritten or reset evidence branch).
function remoteHistory() {
  const log = join(STATE_DIR, 'pushed-heads.log');
  const last = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).at(-1)?.split('\t')[1] : null;
  if (!last) return { status: 'NO_PUSHED_HEADS' };
  try { git('fetch', '-q', 'origin'); } catch (e) { return { status: 'FETCH_FAILED', error: String(e.message).slice(0, 160) }; }
  try { git('merge-base', '--is-ancestor', last, 'origin/main'); return { status: 'OK', last_pushed: last, remote_head: git('rev-parse', 'origin/main') }; } catch { return { status: 'REWRITTEN', last_pushed: last, remote_head: git('rev-parse', 'origin/main') }; }
}

async function healthPing(ok) {
  if (!existsSync(HEALTHCHECK_FILE)) return;
  try { await fetch(`${readFileSync(HEALTHCHECK_FILE, 'utf8').trim()}${ok ? '' : '/fail'}`, { signal: AbortSignal.timeout(10000) }); } catch { /* the dead-man's switch alerts on silence anyway */ }
}

// ---------- commands ----------
async function tick() {
  if (!existsSync(join(EVIDENCE, '.git'))) { await fallbackAlert('EVIDENCE_DRIVE_MISSING', `evidence repo not found at ${EVIDENCE} (USB drive unplugged or letter changed); nothing collected`); process.exitCode = 1; return; }
  const lock = join(STATE_DIR, 'lock');
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(lock) && Date.now() - (readJson(lock)?.at || 0) < 10 * 60000) return;
  writeJson(lock, { pid: process.pid, at: Date.now() });
  state = loadState();
  try {
    clock = await measureClock();
    const now = clock.now();
    const did = [];
    const cfg = readJson(join(EVIDENCE, 'collector.json'));
    if (!cfg?.enabled_at) throw new Error('collector.json missing enabled_at: run init');
    if (Math.abs(clock.offset_ms) > 2000 || clock.source !== 'sntp-median') await alert('CLOCK', `clock ${clock.source}, offset ${clock.offset_ms} ms`);
    if (state.last_tick_utc && now - Date.parse(state.last_tick_utc) > TICK_GAP_MS) {
      const mins = Math.round((now - Date.parse(state.last_tick_utc)) / 60000);
      ledger('GAP', { from_utc: state.last_tick_utc, to_utc: iso(now), minutes: mins, note: 'no collector tick ran in this interval (machine off, asleep, logged off, or task not running)' });
      did.push(`gap ${mins}m`);
      if (mins >= 60) await alert('OFFLINE_GAP', `no tick from ${state.last_tick_utc} to ${iso(now)} (${mins} min)`);
    }
    const day = etParts(now).date;
    const calPath = join(EVIDENCE, 'calendar', 'bls-empsit-schedule.json');
    if (!existsSync(calPath) || (state.schedule_day !== day && etParts(now).hh >= 6)) { await scheduleRefresh(); state.schedule_day = day; }
    const calendar = readJson(calPath)?.releases || [];
    for (const a of plan(now, { calendar, enabledAt: Date.parse(cfg.enabled_at), have })) {
      if (a.type === 'KALSHI_SNAPSHOT') { const s = await kalshiSnapshot(a.release, a.slot, a.slot_at); did.push(`${a.key} ${s.status}`); }
      if (a.type === 'MISSED') {
        writeJson(join(EVIDENCE, 'kalshi', a.key, 'MISSED.json'), { kind: 'MISSED', release: a.release, slot: a.slot, slot_at_utc: iso(a.slot_at), detected_utc: iso(now), reason: 'no complete snapshot finished inside [slot - 15 min, slot); never backfilled', clock: clockRecord() });
        ledger('MISSED', { key: a.key, slot_at_utc: iso(a.slot_at) });
        await alert('MISSED_SNAPSHOT', `${a.key} (slot ${iso(a.slot_at)}) has no on-time snapshot`);
        did.push(`${a.key} MISSED`);
      }
      if (a.type === 'KALSHI_SETTLEMENT' && !throttled(`settle ${a.release.release_date}/${a.tag}`, 3600000)) { await kalshiSettlement(a.release, a.tag); did.push(`${a.release.release_date}/${a.tag}`); }
      if ((a.type === 'BLS_CURRENT' || a.type === 'BLS_ARCHIVE') && !throttled(`${a.type} ${a.release.reference_month}`, 10 * 60000)) {
        if (await blsCapture(a.release, a.type === 'BLS_CURRENT' ? 'current' : 'archive', a.late)) did.push(`bls ${a.release.reference_month} ${a.type}`);
      }
    }
    const e = etParts(now); const weekday = !['Sat', 'Sun'].includes(e.weekday); const mins = e.hh * 60 + e.mm;
    if (weekday && mins >= 8 * 60 + 31 && mins <= 20 * 60 && !throttled('dol', (e.weekday === 'Thu' && mins < 10 * 60) ? 4 * 60000 : 30 * 60000)) await dolCheck();
    const newest = ls(join(EVIDENCE, 'dol', 'weekly-data-pdf')).map((d) => readJson(join(EVIDENCE, 'dol', 'weekly-data-pdf', d, 'capture.json'))?.first_seen_utc).filter(Boolean).sort().at(-1);
    if (now - Date.parse(cfg.enabled_at) > 8 * 86400000 && (!newest || now - Date.parse(newest) > 8 * 86400000)) await alert('DOL_STALE', `no new DOL weekly release since ${newest}`);
    const free = statfsSync(EVIDENCE); const freeBytes = Number(free.bavail) * Number(free.bsize);
    if (freeBytes < MIN_FREE_BYTES) await alert('DISK_LOW', `${(freeBytes / 1e9).toFixed(2)} GB free on the evidence drive`);
    if (state.heartbeat_day !== day) {
      const next = calendar.flatMap((r) => slotTimes(r).map((s) => ({ key: `${r.release_date}/${s.slot}`, at: iso(s.at) }))).filter((s) => Date.parse(s.at) > now).slice(0, 3);
      const history = remoteHistory();
      ledger('HEARTBEAT', { clock: { source: clock.source, offset_ms: clock.offset_ms, windows_time: clock.windows_time }, disk_free_gb: +(freeBytes / 1e9).toFixed(2), remote_history: history, next_slots: next, code: codeIdentity() });
      if (history.status === 'REWRITTEN') await alert('HISTORY_REWRITTEN', `origin/main ${history.remote_head} no longer contains last pushed ${history.last_pushed}`);
      state.heartbeat_day = day; did.push('heartbeat');
    }
    if (!clock.windows_time?.running && !throttled('w32time-alert', 86400000)) await alert('WINDOWS_TIME_STOPPED', 'Windows Time service is not running; timestamps use SNTP correction. Owner admin step: Start-Service w32time.');
    if (state.push_failing_since && now - state.push_failing_since > 20 * 60000) await alert('PUSH_FAILING', `evidence push failing since ${iso(state.push_failing_since)}`);
    const g = commitAndPush(did.join('; ') || 'ledger');
    state.last_tick_utc = iso(now);
    appendFileSync(join(STATE_DIR, 'ticks.log'), `${iso(now)}\toffset_ms=${clock.offset_ms}\tw32time=${clock.windows_time?.running ? 'running' : 'stopped'}\t${did.join('; ') || '-'}\t${g.committed ? `commit ${String(g.committed).slice(0, 7)} pushed=${g.pushed}` : 'no-change'}\n`);
    await healthPing(g.pushed !== false || !g.committed);
  } catch (e) {
    appendFileSync(join(STATE_DIR, 'ticks.log'), `${new Date().toISOString()}\tERROR\t${String(e?.stack || e).replace(/\s+/g, ' ').slice(0, 400)}\n`);
    try { await alert('TICK_ERROR', String(e?.message || e).slice(0, 300)); commitAndPush('tick error'); } catch { /* best effort */ }
    await healthPing(false);
    process.exitCode = 1;
  } finally { saveState(state); rmSync(lock, { force: true }); }
}

function verify() {
  let files = 0; let bad = 0; let snaps = 0; let rederived = 0; const problems = [];
  const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []).flatMap((e) => (e.name === '.git' || e.name === '.state' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const p of walk(EVIDENCE).filter((f) => /(snapshot|capture|settlement)\.json$/.test(f))) {
    const j = readJson(p); const dir = dirname(p);
    const list = j.files || (j.file ? [j.file] : []);
    for (const m of list) {
      if (!m.file) continue;
      files += 1;
      const b = readFileSync(join(dir, m.file));
      if (sha(b) !== m.sha256) { bad += 1; problems.push(`hash ${p} ${m.file}`); }
    }
    if (j.kind === 'KALSHI_SNAPSHOT') {
      snaps += 1;
      for (const s of Object.values(j.series)) for (const c of s.contracts || []) {
        if (!c.orderbook_file) continue;
        const book = deriveBook(JSON.parse(readFileSync(join(dir, c.orderbook_file), 'utf8')));
        if (book.best_yes_bid !== c.book.best_yes_bid || book.best_yes_ask !== c.book.best_yes_ask || book.best_yes_ask_size !== c.book.best_yes_ask_size || book.mid !== c.book.mid) problems.push(`book ${p} ${c.ticker}`); else rederived += 1;
      }
    }
  }
  for (const m of walk(join(EVIDENCE, 'kalshi')).filter((f) => f.endsWith('MISSED.json'))) {
    const key = dirname(m).slice(join(EVIDENCE, 'kalshi').length + 1).replace(/\\/g, '/');
    if (have.slotOk(key)) problems.push(`MISSED and OK both present for ${key}`);
  }
  for (const f of ls(join(EVIDENCE, 'kalshi', 'terms'))) { files += 1; if (`${sha(readFileSync(join(EVIDENCE, 'kalshi', 'terms', f)))}.pdf` !== f) { bad += 1; problems.push(`terms ${f}`); } }
  let ledgerLines = 0; for (const f of ls(join(EVIDENCE, 'ledger'))) for (const l of readFileSync(join(EVIDENCE, 'ledger', f), 'utf8').split('\n').filter(Boolean)) { ledgerLines += 1; try { JSON.parse(l); } catch { problems.push(`ledger ${f}`); } }
  const remote = remoteHistory();
  if (remote.status === 'REWRITTEN') problems.push(`remote history rewritten: ${JSON.stringify(remote)}`);
  const out = { evidence: EVIDENCE, files_hashed: files, hash_mismatches: bad, kalshi_snapshots: snaps, order_books_rederived: rederived, ledger_lines: ledgerLines, remote_history: remote, problems };
  console.log(JSON.stringify(out, null, 1));
  if (problems.length) process.exitCode = 1;
}

async function main() {
  if (cmd === 'tick') return tick();
  if (cmd === 'verify') return verify();
  state = loadState(); clock = await measureClock();
  if (cmd === 'init') {
    const p = join(EVIDENCE, 'collector.json');
    if (existsSync(p)) { console.log('already initialised', readFileSync(p, 'utf8')); return; }
    writeFileSync(join(EVIDENCE, '.gitignore'), '.state/\n');
    writeJson(p, { collector: COLLECTOR_VERSION, enabled_at: iso(clock.now()), authorization: 'Owner authorization 2026-10-08: Tier A prospective data collection only (no fitting, no forecasts, no trading). Tier B HOLD.', owner_session: 'goodl-c0', host: hostname(), evidence_repo: REPO, schedule: 'Task Scheduler tick every 5 min (America/Chicago host; all slots computed in America/New_York)', slots: 'Kalshi T-7D/T-3D/T-1D at 20:00 ET, window [slot-15min, slot); settlement +1D/+3D; BLS on release; DOL weekdays', code: codeIdentity() });
    ledger('INIT', { code: codeIdentity(), clock: clockRecord() });
    console.log(JSON.stringify(commitAndPush('init')));
  } else if (cmd === 'adhoc-snapshot') {
    const cal = readJson(join(EVIDENCE, 'calendar', 'bls-empsit-schedule.json'))?.releases || [];
    const rel = cal.find((r) => Date.parse(r.release_at) > clock.now());
    const s = await kalshiSnapshot(rel, 'ADHOC', null);
    console.log(JSON.stringify({ status: s.status, release: rel, series: Object.fromEntries(Object.entries(s.series).map(([k, v]) => [k, { status: v.status, markets: v.markets_listed, orderbooks_ok: v.orderbooks_ok, close_ok: v.close_matches_bls_release_date, fee: v.fee }])), clock: s.clock, ms: Date.parse(s.completed_utc) - Date.parse(s.started_utc) }, null, 1));
    console.log(JSON.stringify(commitAndPush(`ADHOC validation snapshot ${rel.release_date}`)));
  } else if (cmd === 'test-alert') {
    await alert('TEST', 'Validation of alert delivery (expected; no action needed).');
    console.log(JSON.stringify(commitAndPush('alert test')));
  } else if (cmd === 'status') {
    console.log(JSON.stringify({ evidence: EVIDENCE, clock: clockRecord(), state, code: codeIdentity() }, null, 1));
  }
  saveState(state);
}
await main();
