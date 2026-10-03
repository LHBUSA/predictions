// Article / page QA against the LOCAL server (scripts/qa/serve.mjs), fail-loud by design: any problem — the server
// not starting, a page or same-origin asset not returning 2xx, horizontal overflow, layout shift above budget, a
// console error, Chrome missing — exits non-zero. Nothing is skipped silently.
//
//   node scripts/qa/article-qa.mjs [paths...] [--widths 390,430,768,1024,1440,1920] [--out D:/Workers/scratch/qa]
//   paths default to the homepage, /insights/ and every flagship story; "preview:<slug>" renders an unpublished
//   story through the Worker admin route; "admin:<route>" any admin page (both need PBE_ADMIN_TOKEN or PBE_ADMIN_TOKEN_FILE).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startServer } from './serve.mjs';
import { STORIES } from '../../workers/pbe-predictions/src/insights/stories.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const widths = opt('--widths', '390,430,768,1024,1440,1920').split(',').map(Number);
const out = opt('--out', join(process.env.TEMP || '.', 'pbe-article-qa', new Date().toISOString().replace(/[:.]/g, '-')));
const CLS_BUDGET = 0.1;
const paths = args.length ? args : ['/', '/insights/', ...STORIES.map((s) => `/insights/${s.slug}`)];
const CHROME = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);

const failures = [];
const fail = (msg) => { failures.push(msg); console.error(`FAIL ${msg}`); };
if (!CHROME) { console.error('FAIL Chrome not found (set CHROME_PATH). Article QA cannot run.'); process.exit(3); }

let server; let browser;
try {
  ({ server } = await startServer().then((s) => { server = s.server; return s; }).then(async (s) => {
    const h = await fetch(`${s.origin}/__health`).then((r) => r.json());
    if (!h.ok) throw new Error('health check failed');
    globalThis.ORIGIN = s.origin;
    return s;
  }));
  mkdirSync(out, { recursive: true });
  console.log(`local server ${globalThis.ORIGIN} · screenshots → ${out}`);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars'] });
  for (const raw of paths) {
    // "preview:<slug>" = unpublished flagship story; "admin:<route>" = any Worker admin page (e.g. admin:newsroom/preview/<id>).
    // Bare paths must start with "/" (Git Bash rewrites "/..." args into Windows paths unless MSYS_NO_PATHCONV=1).
    const path = raw.startsWith('preview:') ? `/__preview/insights/${raw.slice(8)}` : raw.startsWith('admin:') ? `/__preview/${raw.slice(6)}` : raw;
    if (!path.startsWith('/')) { fail(`${raw}: not a site path (use "/...", "preview:<slug>" or "admin:<route>")`); continue; }
    const name = raw.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
    for (const w of widths) {
      const page = await browser.newPage();
      const bad = [];
      page.on('response', (r) => { const u = r.url(); if (u.startsWith(globalThis.ORIGIN) && r.status() >= 400) bad.push(`${r.status()} ${u.slice(globalThis.ORIGIN.length)}`); });
      page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text().slice(0, 160)}`); });
      page.on('pageerror', (e) => bad.push(`pageerror: ${e.message.slice(0, 160)}`));
      await page.setViewport({ width: w, height: w < 800 ? 844 : 900, isMobile: w < 800, hasTouch: w < 800 });
      await page.evaluateOnNewDocument(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
      const resp = await page.goto(`${globalThis.ORIGIN}${path}`, { waitUntil: 'networkidle0', timeout: 60000 });
      if (!resp || resp.status() !== 200) fail(`${raw} @${w}: HTTP ${resp?.status()}`);
      await new Promise((r) => setTimeout(r, 800));
      const m = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, cls: window.__cls, h1: Boolean(document.querySelector('h1')) }));
      if (m.scrollW > m.clientW) fail(`${raw} @${w}: horizontal overflow ${m.scrollW} > ${m.clientW}`);
      if (m.cls > CLS_BUDGET) fail(`${raw} @${w}: CLS ${m.cls.toFixed(3)} > ${CLS_BUDGET}`);
      if (!m.h1) fail(`${raw} @${w}: no <h1>`);
      for (const b of bad) fail(`${raw} @${w}: ${b}`);
      await page.screenshot({ path: join(out, `${name}-${w}.png`), fullPage: true });
      console.log(`${raw.padEnd(70)} ${String(w).padStart(4)}  overflow=${m.scrollW > m.clientW} cls=${m.cls.toFixed(4)} assets_bad=${bad.length}`);
      await page.close();
    }
  }
} catch (e) {
  fail(`harness error: ${e.message}`);
} finally {
  await browser?.close().catch(() => {});
  await new Promise((r) => (server ? server.close(r) : r()));
}
if (failures.length) { console.error(`\nARTICLE QA FAILED (${failures.length})`); process.exit(1); }
console.log(`\nARTICLE QA PASSED · ${paths.length} pages × ${widths.length} widths`);
