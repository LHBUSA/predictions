// Network shell QA (nav + Research menu + footer + /about/): real Chrome against the local server that mirrors vercel.json.
// Fails loudly (exit 1) on horizontal overflow, a header that collides with its controls, a missing icon, a menu
// that leaves the viewport, or a console error from our own origin. Screenshots go to --out (default: OS temp).
//   node scripts/qa/shell-qa.mjs [--out <dir>] [--chrome <path>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startServer } from './serve.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', join(tmpdir(), 'pbe-shell-qa'));
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
mkdirSync(OUT, { recursive: true });

const PAGES = ['/', '/about/', '/desk/', '/methodology/', '/track-record/', '/markets/signal-10/', '/crypto/'];
const WIDTHS = [2560, 1920, 1860, 1680, 1679, 1440, 1411, 1410, 1366, 1280, 1181, 1180, 1024, 768, 430, 390, 320];
import NET from '../../brand/network.json' with { type: 'json' };
const NAV_ICONS = NET.product.length + 1;
const fails = [];
const fail = (m) => { fails.push(m); console.log(`FAIL ${m}`); };

const { server, origin } = await startServer();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(OUT, 'profile'), args: ['--no-first-run', '--hide-scrollbars'] });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail(`console ${page.url()} :: ${m.text()}`); });
  page.on('pageerror', (e) => fail(`pageerror ${page.url()} :: ${e.message}`));

  for (const path of PAGES) {
    for (const w of WIDTHS) {
      await page.setViewport({ width: w, height: 900 });
      await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      await page.addStyleTag({ content: 'html,body{scroll-behavior:auto!important}' });
      await new Promise((r) => setTimeout(r, 250));
      const r = await page.evaluate(() => {
        const doc = document.documentElement;
        const vis = (el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
        const nav = document.querySelector('.topbar .nav'); const right = document.querySelector('.topbar .top-right'); const brand = document.querySelector('.topbar .brand');
        const out = { overflow: doc.scrollWidth - doc.clientWidth, navVisible: vis(nav), stripVisible: vis(document.querySelector('.topbar .subnav')) };
        if (vis(nav)) {
          // measure the ITEMS, not the nav box: a flex nav can shrink while its items overflow under the controls
          const n = { left: nav.firstElementChild.getBoundingClientRect().left, right: nav.lastElementChild.getBoundingClientRect().right };
          const t = right.getBoundingClientRect(); const b = brand.getBoundingClientRect();
          out.collide = Math.round(n.right - t.left); out.collideBrand = Math.round(b.right - n.left);
          out.wrappedControls = [...right.children].filter((c) => c.getBoundingClientRect().height > 40).map((c) => c.className.split(' ')[0]);
          out.navWrap = [...nav.children].some((c) => c.getBoundingClientRect().height > 40);
          out.icons = nav.querySelectorAll('svg.nav-ic').length;
        }
        out.topbarH = Math.round(document.querySelector('.topbar .wrap').getBoundingClientRect().height);
        return out;
      });
      const tag = `${path} @${w}`;
      // live tapes (crypto) lay out after first paint: re-measure once before calling it an overflow
      if (r.overflow > 0) { await new Promise((res) => setTimeout(res, 2000)); r.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); }
      if (r.overflow > 0) fail(`${tag} horizontal overflow ${r.overflow}px`);
      if (r.navVisible) {
        if (r.collide > -4) fail(`${tag} nav collides with controls (${r.collide}px)`);
        if (r.collideBrand > -4) fail(`${tag} nav collides with brand (${r.collideBrand}px)`);
        if (r.navWrap) fail(`${tag} a nav item wraps`);
        if (r.wrappedControls.length) fail(`${tag} header controls wrap: ${r.wrappedControls.join(', ')}`);
        if (r.icons !== NAV_ICONS) fail(`${tag} expected ${NAV_ICONS} nav icons (products + Research), got ${r.icons}`);
      } else if (!r.stripVisible) fail(`${tag} neither desktop nav nor mobile strip visible`);
      console.log(`${tag} overflow=${r.overflow} nav=${r.navVisible ? `desk gap=${-r.collide}` : 'strip'} h=${r.topbarH}`);
    }
  }

  // Research menu: open, inside the viewport, screenshot (light + dark)
  for (const [w, theme] of [[1920, 'light'], [1440, 'light'], [1366, 'dark'], [1181, 'light']]) {
    await page.setViewport({ width: w, height: 900 });
    await page.goto(origin + '/methodology/', { waitUntil: 'domcontentloaded' });
    if (theme === 'dark') await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.click('.topbar .nav-drop > summary');
    await new Promise((r) => setTimeout(r, 200));
    const box = await page.evaluate(() => { const b = document.querySelector('.nav-mega').getBoundingClientRect(); return { l: b.left, r: b.right, b: b.bottom }; });
    if (box.l < 0 || box.r > w) fail(`research menu @${w} outside viewport (${Math.round(box.l)}..${Math.round(box.r)})`);
    await page.bringToFront();
    await page.screenshot({ path: join(OUT, `menu-${w}-${theme}.png`), clip: { x: 0, y: 0, width: w, height: Math.min(900, Math.ceil(box.b) + 20) } });
  }

  // live-engine tooltip on keyboard focus
  await page.setViewport({ width: 1920, height: 600 });
  await page.goto(origin + '/desk/', { waitUntil: 'domcontentloaded' });
  await page.focus('#live-dot');
  await new Promise((r) => setTimeout(r, 250));
  const tip = await page.evaluate(() => { const t = document.getElementById('live-tip'); const s = getComputedStyle(t); const b = t.getBoundingClientRect(); return { op: s.opacity, vis: s.visibility, r: b.right, l: b.left, text: t.textContent }; });
  if (tip.vis !== 'visible' || Number(tip.op) < 0.9) fail(`live tooltip not shown on focus (${tip.vis}/${tip.op})`);
  if (tip.l < 0 || tip.r > 1920) fail('live tooltip outside viewport');
  console.log(`live tooltip: "${tip.text}"`);
  await page.bringToFront();
  await page.screenshot({ path: join(OUT, 'header-1920-tip.png'), clip: { x: 0, y: 0, width: 1920, height: 140 } });

  // header strips, footer and the full /about/ page at desktop / tablet / phone, light + dark
  for (const [w, theme] of [[1440, 'light'], [1440, 'dark'], [1280, 'light'], [768, 'light'], [390, 'light'], [390, 'dark']]) {
    await page.setViewport({ width: w, height: 900 });
    for (const path of ['/about/', '/']) {
      await page.goto(origin + path, { waitUntil: 'networkidle2' }).catch(() => {});
      if (theme === 'dark') await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.addStyleTag({ content: 'html,body{scroll-behavior:auto!important}' });
      await new Promise((r) => setTimeout(r, 300));
      const slug = path === '/' ? 'home' : 'about';
      await page.bringToFront();
      await page.screenshot({ path: join(OUT, `header-${slug}-${w}-${theme}.png`), clip: { x: 0, y: 0, width: w, height: 130 } });
      const f = await page.evaluate(() => { const b = document.querySelector('.net-footer').getBoundingClientRect(); return { y: b.top + scrollY, h: b.height }; });
      await page.screenshot({ path: join(OUT, `footer-${slug}-${w}-${theme}.png`), clip: { x: 0, y: f.y, width: w, height: f.h } });
      if (path === '/about/') await page.screenshot({ path: join(OUT, `about-${w}-${theme}.png`), fullPage: true });
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\nscreenshots: ${OUT}`);
if (fails.length) { console.log(`${fails.length} FAILURE(S)`); process.exit(1); }
console.log('shell QA PASS');
