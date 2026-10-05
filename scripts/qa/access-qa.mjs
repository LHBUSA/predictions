// All Access QA (owner contract 2026-10-05): renders the homepage and an event page in every membership state at every
// breakpoint and fails loudly on overflow, header overlap, console errors, failed requests or premium leakage.
//   node scripts/qa/access-qa.mjs --local  [--out DIR]   # repo files + locally rendered Worker pages, mocked membership
//   node scripts/qa/access-qa.mjs --prod   [--out DIR]   # production; mocked membership only for non-anonymous states
// In --local the event page is rendered by THIS checkout's Worker code from a real production record; membership,
// /api/desk and /api/premium/* are answered per state (anonymous/signed_in -> 401/403, unverified -> 503).
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import './../../test/helpers/worker-assets.js';
import { startServer } from './serve.mjs';
import { renderEvent, eventIntel } from '../../workers/pbe-predictions/src/pages.js';
import { publicEventShell, premiumEventView } from '../../workers/pbe-predictions/src/premium.js';

const args = process.argv.slice(2);
const PROD = args.includes('--prod');
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'qa-out';
const WIDTHS = [390, 430, 768, 1024, 1440, 1920];
const SITE = 'https://predictions.propbetedge.ai';
const STATES = {
  anonymous: { authenticated: false, membership: { state: 'anonymous', label: 'Sign in', entitled: false } },
  signed_in: { authenticated: true, membership: { state: 'signed_in', label: 'Upgrade', entitled: false, email: 'qa@example.com' } },
  all_access: { authenticated: true, membership: { state: 'all_access', label: 'ALL ACCESS ACTIVE', entitled: true, email: 'qa@example.com', manage_url: 'https://billing.example/manage' } },
  owner: { authenticated: true, membership: { state: 'owner', label: 'OWNER', entitled: true, email: 'owner@example.com' } },
  unverified: { authenticated: false, membership: { state: 'unverified', label: 'Access Check', entitled: false, degraded: true } },
};
const DENY = { anonymous: 401, signed_in: 403, unverified: 503 };
mkdirSync(OUT, { recursive: true });

// one real record + desk for the local renders (members only see them; the record is not written anywhere public)
const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text();
const slug = sitemap.match(/\/events\/([a-z0-9-]+)/g).map((s) => s.slice(8)).find((s) => /temperature|rain/.test(s)) || sitemap.match(/\/events\/([a-z0-9-]+)/)[1];
let record = null; let deskBody = null;
if (!PROD) {
  const tok = process.env.PBE_QA_RECORD_JSON; // optional: a member record captured by the owner; else the legacy public record
  record = tok ? JSON.parse(tok) : await (await fetch(`${SITE}/api/event/${slug}`)).json().catch(() => null);
  const d = await fetch(`${SITE}/api/desk`); deskBody = d.ok ? await d.text() : JSON.stringify({ events: [] });
  if (!record?.outcomes) throw new Error(`no record for ${slug} (production already gated? run with PBE_QA_RECORD_JSON)`);
}

const server = PROD ? null : await startServer({ port: 0 });
const BASE = PROD ? SITE : server.origin;
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--hide-scrollbars'], userDataDir: join(OUT, '.profile') });
const failures = []; const rows = [];
const json = (b, status = 200) => ({ status, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: typeof b === 'string' ? b : JSON.stringify(b) });

async function visit(state, width, path) {
  const page = await browser.newPage();
  await page.bringToFront();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
  const errors = []; const bad = []; const leaks = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (401|403|503)/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = new URL(r.url());
    const p = u.pathname;
    const mocked = state !== 'anonymous' || !PROD;
    if (mocked && p === '/api/membership') return r.respond(json(STATES[state]));
    if (!PROD && p.startsWith(`/events/${slug}`)) return r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: renderEvent(publicEventShell(record), { stories: [] }) });
    if (mocked && (p === '/api/desk' || p.startsWith('/api/premium/') || p.startsWith('/api/live/event/'))) {
      if (!STATES[state].membership.entitled) return r.respond(json({ error: state === 'unverified' ? 'entitlement_unavailable' : 'all_access_required' }, DENY[state]));
      if (PROD) return r.continue(); // production cannot serve member data without a real member session
      if (p === '/api/desk') return r.respond(json(deskBody));
      if (p.startsWith('/api/premium/event-page/')) return r.respond(json({ at: record.generated_at, ...eventIntel(premiumEventView(record), { multiVenue: true }) }));
      if (p.startsWith('/api/premium/event/')) return r.respond(json(premiumEventView(record)));
      if (p.startsWith('/api/live/event/')) return r.respond(json({ at: record.generated_at, regions: {} }));
    }
    return r.continue();
  });
  page.on('response', (res) => { const s = res.status(); const u = res.url(); if (s >= 400 && !/\/api\/(desk|premium|live\/event|membership)/.test(u)) bad.push(`${s} ${u}`); });
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 400));
  const m = await page.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    const chip = document.getElementById('mem-chip'); const pill = document.querySelector('.top-right .aa-pill');
    const boxes = [...document.querySelectorAll('.top-right > *, .topbar .brand')].filter(vis).map((e) => ({ c: e.className || e.id, r: e.getBoundingClientRect() }));
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i].r; const b = boxes[j].r; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${boxes[i].c} x ${boxes[j].c}`); }
    const text = document.body.innerText;
    return {
      acct: document.documentElement.dataset.acct || null, chip: chip?.textContent.trim(), chipVisible: vis(chip), pillVisible: vis(pill), pillText: pill?.textContent.trim(),
      gateVisible: vis(document.querySelector('[data-gate]')), gateCta: [...document.querySelectorAll('[data-gate-cta]')].filter(vis).map((e) => e.innerText.replace(/\s+/g, ' ').trim()).join(' | '),
      purchaseVisible: [...document.querySelectorAll('a[href="https://propbetedge.ai/pro"]')].filter((a) => vis(a) && !a.closest('footer') && /get all access|upgrade/i.test(a.textContent)).length,
      overflow: document.scrollingElement.scrollWidth - window.innerWidth, overlaps,
      freeBadge: /\bFREE\b/.test(text), freeCopy: /free (desk|predictions)/i.test(text),
      pbeNumbers: (text.match(/PBE[^\n]{0,40}?\d{1,2}%/g) || []).length,
      deskRows: document.querySelectorAll('#desk-list .row').length, intel: !!document.querySelector('[data-prem-intel] [data-live-region="call"]'),
      brokenImgs: [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getBoundingClientRect().width > 0).map((i) => i.src),
      cls: (performance.getEntriesByType('layout-shift') || []).reduce((a, e) => a + (e.hadRecentInput ? 0 : e.value), 0),
    };
  });
  const tag = `${path === '/' ? 'home' : 'event'}-${state}-${width}`;
  if ([390, 1440].includes(width)) await page.screenshot({ path: join(OUT, `${tag}.png`), fullPage: false });
  await page.close();
  const fail = (why) => failures.push(`${tag}: ${why}`);
  if (m.overflow > 0) fail(`horizontal overflow ${m.overflow}px`);
  if (m.overlaps.length) fail(`header overlap ${m.overlaps.join(', ')}`);
  if (errors.length) fail(`console ${errors.slice(0, 3).join(' / ')}`);
  if (bad.length) fail(`requests ${bad.slice(0, 3).join(' / ')}`);
  if (m.brokenImgs.length) fail(`broken images ${m.brokenImgs.slice(0, 2).join(', ')}`);
  if (m.freeBadge || m.freeCopy) fail('FREE badge / free copy visible');
  if (m.acct !== state) fail(`account state ${m.acct}`);
  if (m.chip !== STATES[state].membership.label) fail(`chip "${m.chip}"`);
  const entitled = STATES[state].membership.entitled;
  if (entitled && m.purchaseVisible) fail(`purchase CTA visible for ${state}`);
  if (state === 'anonymous' && !m.pillVisible) fail('Get All Access not visible');
  if (!entitled && m.pbeNumbers) fail(`premium numbers visible (${m.pbeNumbers})`);
  if (!entitled && !m.gateVisible) fail('gate missing');
  if (entitled && !PROD && path === '/' && !m.deskRows && JSON.parse(deskBody).events.length) fail('member desk did not render');
  if (entitled && !PROD && path !== '/' && !m.intel) fail('member event intelligence did not render');
  rows.push({ tag, ...m, errors: errors.length, bad: bad.length });
}

try {
  // production: member data needs a real member session, so headless prod covers the non-entitled states only
  const states = PROD ? ['anonymous', 'signed_in', 'unverified'] : Object.keys(STATES);
  for (const path of ['/', `/events/${slug}`]) for (const state of states) for (const w of WIDTHS) await visit(state, w, path);
} finally { await browser.close(); if (server) await new Promise((r) => server.server.close(r)); }
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ mode: PROD ? 'prod' : 'local', slug, rows, failures }, null, 1));
console.log(rows.map((r) => `${r.tag.padEnd(28)} acct=${r.acct} chip="${r.chip}" pill=${r.pillVisible} gate=${r.gateVisible} cta="${r.gateCta}" desk=${r.deskRows} intel=${r.intel} ovf=${r.overflow} cls=${r.cls.toFixed(3)}`).join('\n'));
console.log(failures.length ? `\nFAIL ${failures.length}\n${failures.join('\n')}` : '\nPASS');
process.exit(failures.length ? 1 : 0);
