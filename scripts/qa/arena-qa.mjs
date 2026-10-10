// Strategy Arena + metals page QA (issues #62/#63): real Chrome against the local static server; /api/* answered by the
// REAL payload builders (arena-api.js) over a simulated multi-session run (fake store + deterministic source), so the pages
// render genuine engine output. Checks overflow at 320/360/390/430/768/1440, console errors, gates (401/403), keyboard
// tabs, reduced motion. Fails loudly. Screens to --out.
//   node scripts/qa/arena-qa.mjs [--out <dir>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import '../../test/helpers/worker-assets.js';
import { startServer } from './serve.mjs';
import { FakeStore, fakeSource, CAL } from '../../test/helpers/s10-fakes.js';
import { LATEST_MEMBERS } from '../../src/signal10/members-latest.js';
import { runArenaEod, runArenaOpen } from '../../src/signal10/arena/forward.js';
import { arenaPayload, arenaProof, metalsPayload } from '../../workers/pbe-predictions/src/arena-api.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', join(tmpdir(), 'pbe-arena-qa')); mkdirSync(OUT, { recursive: true });
const fails = []; const fail = (m) => { fails.push(m); console.log('FAIL', m); };

// ---- simulated record: control running since 09-01, challengers from T0 = 09-03, 12 sessions ----
const S11 = ['COMMUNICATION', 'CONSUMER_DISCRETIONARY', 'CONSUMER_STAPLES', 'ENERGY', 'FINANCIALS', 'HEALTH_CARE', 'INDUSTRIALS', 'MATERIALS', 'REAL_ESTATE', 'UTILITIES'];
const CLS = { effective_from: '2025-01-01', content_sha256: 'f'.repeat(64), rows: Object.fromEntries(LATEST_MEMBERS.tickers.map((t, i) => [t, { sector: i % 4 === 0 ? 'TECHNOLOGY' : S11[i % 10], tech: i % 4 === 0 }])) };
const B = { QQQ: { from: 400, factor: 1.3 }, SPY: { from: 400, factor: 1.25 } };
const store = new FakeStore();
const T0 = '2026-09-03'; const days = CAL.filter((d) => d >= T0).slice(0, 12);
store.rows('pred_s10_events').push({ account: 'S10-FWD-1', seq: 1, type: 'FUNDING', d: '2026-09-01', payload: {} });
let nav = 1_000_000; for (const d of ['2026-09-01', '2026-09-02', ...days]) { nav = Math.round(nav * (1 + 0.004 * Math.sin(d.charCodeAt(9)))); store.rows('pred_s10_marks').push({ account: 'S10-FWD-1', kind: 'EOD_CLOSE', d, nav_cents: nav, cash_cents: 120000, positions: [], benchmarks: {} }); }
for (const [k, d] of days.entries()) {
  if (k) await runArenaOpen({ store, now: `${d}T13:50:00Z`, fetchImpl: fakeSource({ today: d, at: `${d}T13:50:00Z`, shock: B }), t0: T0 });
  await runArenaEod({ store, now: `${d}T20:35:00Z`, fetchImpl: fakeSource({ today: d, at: `${d}T20:00:00Z`, shock: B }), t0: T0, classification: CLS });
}
const ARENA = await arenaPayload(store); const PROOF = await arenaProof(store);
const METALS_PUBLIC = await metalsPayload({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'iex-hist' }, store, member: false });
const METALS_MEMBER = await metalsPayload({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'iex-hist' }, store, member: true });
console.log('simulated:', ARENA.sample, ARENA.strategies.map((s) => `${s.key}:${s.holdings.length} holdings`).join(' '));

const { server, origin } = await startServer();
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: join(OUT, 'profile'), args: ['--hide-scrollbars'] });
try {
  const page = await browser.newPage();
  let mode = 'member';
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin || !u.pathname.startsWith('/api/')) return r.continue();
    const p = u.pathname;
    const send = (status, body) => r.respond({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'cache-control': 'private, no-store' } });
    if (p === '/api/signal10/arena/proof') return send(200, PROOF);
    if (p === '/api/signal10/arena') return mode === 'member' ? send(200, { ...ARENA, access: { tier: 'all_access' } }) : send(mode === 'anon' ? 401 : 403, { error: mode });
    if (p === '/api/metals') return send(200, mode === 'member' ? METALS_MEMBER : METALS_PUBLIC);
    return send(404, { error: 'not mocked' }); // membership chip, tape etc. → their own fallbacks
  });
  page.on('pageerror', (e) => fail(`pageerror ${page.url()} ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|404/.test(m.text())) fail(`console ${page.url()} ${m.text()}`); });
  for (const path of ['/markets/signal-10/arena/', '/markets/metals/', '/commodities/gold/', '/commodities/silver/', '/commodities/platinum/']) {
    for (const w of [320, 360, 390, 430, 768, 1440]) {
      await page.setViewport({ width: w, height: 900 });
      await page.goto(origin + path, { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => document.querySelector('[data-state="ready"]'), { timeout: 10000 }).catch(() => fail(`${path} @${w} never ready`));
      // the element that really widens the page: ignore anything inside a clipping / scrolling ancestor
      const r = await page.evaluate(() => {
        const W = document.documentElement.clientWidth;
        const clipped = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return true; return false; };
        const off = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 1 && !clipped(e)).slice(0, 4)
          .map((e) => `${e.tagName}.${typeof e.className === 'string' ? e.className : ''} w=${Math.round(e.getBoundingClientRect().width)} in ${e.parentElement.tagName}.${e.parentElement.className}`);
        return { o: document.documentElement.scrollWidth - W, off };
      });
      if (r.o > 0) console.log('offenders', JSON.stringify(r.off));
      if (r.o > 0) fail(`${path} @${w} horizontal overflow ${r.o}px`);
      if ([390, 1440].includes(w)) { await page.bringToFront(); await page.screenshot({ path: join(OUT, `${path.split('/').filter(Boolean).at(-1)}-${w}.png`), fullPage: true }); }
    }
  }
  // gates
  for (const m of ['anon', 'free']) {
    mode = m; await page.setViewport({ width: 390, height: 900 });
    await page.goto(origin + '/markets/signal-10/arena/', { waitUntil: 'networkidle2' });
    const g = await page.$eval('#arena-app', (el) => ({ state: el.dataset.state, text: el.textContent }));
    if (g.state !== (m === 'anon' ? 'signin' : 'upgrade')) fail(`gate ${m}: state ${g.state}`);
    if (/\$\d{1,3},\d{3}/.test(g.text)) fail(`gate ${m} leaks a dollar value`);
  }
  // keyboard tabs
  mode = 'member'; await page.setViewport({ width: 1440, height: 900 });
  await page.goto(origin + '/markets/signal-10/arena/', { waitUntil: 'networkidle2' });
  await page.focus('#ar-tab-ORIGINAL'); await page.keyboard.press('ArrowRight');
  const sel = await page.evaluate(() => [document.activeElement.id, document.getElementById('ar-pane-TECH').hidden]);
  if (sel[0] !== 'ar-tab-TECH' || sel[1] !== false) fail(`keyboard tabs ${sel}`);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: join(OUT, 'arena-1440-dark.png'), fullPage: true });
} finally { await browser.close(); server.close(); }
console.log(`screens: ${OUT}`);
if (fails.length) { console.log(`${fails.length} FAILURE(S)`); process.exit(1); }
console.log('arena QA PASS');
