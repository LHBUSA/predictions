// Production QA for the V4 event record + desk: screenshots at 390 and 1440, horizontal overflow, CLS, console errors.
// Usage: node scripts/qa/v4-shots.mjs <outDir> <path> [<path>...]   (paths on https://predictions.propbetedge.ai)
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const [out, ...paths] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--hide-scrollbars'] });
let failed = false;
for (const path of paths) {
  for (const width of [390, 1440]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
    await page.goto(`https://predictions.propbetedge.ai${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));
    const m = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, cls: +window.__cls.toFixed(4), wide: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('.tbl-wrap,.cats,.tape,.subnav-track')).slice(0, 5).map((el) => `${el.tagName}.${el.className}`) }));
    const name = `${path.replace(/[^a-z0-9]+/gi, '_') || 'home'}-${width}.png`;
    await page.screenshot({ path: `${out}/${name}`, fullPage: true });
    const bad = m.overflow > 0 || m.cls > 0.1 || errors.length;
    if (bad) failed = true;
    console.log(JSON.stringify({ path, width, ...m, errors: errors.slice(0, 3), shot: name, ok: !bad }));
    await page.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
