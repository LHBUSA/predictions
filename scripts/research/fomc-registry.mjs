// Builds data/fomc/scheduled-decisions.json: every SCHEDULED FOMC meeting 1994+ with its decision, from
// official sources only — meeting dates from federalreserve.gov (fomchistoricalYYYY.htm, fomccalendars.htm),
// decision = change in the federal funds target (FRED DFEDTAR to 2008-12-15, DFEDTARU after).
// Cross-checked against the hand-curated data/fomc/official-decisions.json (must agree on every overlap).
//   node scripts/research/fomc-registry.mjs [scratchDir]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const MONTH = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const text = (html) => html.replace(/<[^>]*>/g, '\n').replace(/&nbsp;/g, ' ').split('\n').map((s) => s.trim()).filter(Boolean);

const meetings = new Map(); // decision date -> { date, source }
for (let y = 1994; y <= 2020; y += 1) {
  const lines = text(await readFile(join(DIR, 'fomc', `hist-${y}.html`), 'utf8'));
  for (const l of lines) {
    // "January 27-28 Meeting - 2015" | "January 31-February 1 Meeting" | "Jan/Feb 31-1 Meeting" | "March 22 Meeting"
    const m = /^([A-Z][a-z]+)(?:\/([A-Z][a-z]+))?\s+(\d{1,2})(?:\s*-\s*(?:([A-Z][a-z]+)\s+)?(\d{1,2}))?\s+Meeting\b/.exec(l);
    if (!m || !MONTH[m[1].toLowerCase()]) continue;
    const month = MONTH[(m[4] || m[2] || m[1]).toLowerCase()];
    const day = Number(m[5] || m[3]);
    const date = `${y}-${pad(month)}-${pad(day)}`;
    meetings.set(date, { date, source: `https://www.federalreserve.gov/monetarypolicy/fomchistorical${y}.htm` });
  }
}
{
  const lines = text(await readFile(join(DIR, 'fomc', 'calendars.html'), 'utf8'));
  let year = null;
  for (let i = 0; i < lines.length; i += 1) {
    const h = /^(\d{4}) FOMC Meetings$/.exec(lines[i]);
    if (h) { year = Number(h[1]); continue; }
    if (!year || year < 2021) continue;
    const mm = /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan\/Feb|Apr\/May|Oct\/Nov|Jul\/Aug)$/.exec(lines[i]);
    if (!mm) continue;
    const d = /^(\d{1,2})(?:-(\d{1,2}))?\*?$/.exec(lines[i + 1] || '');
    if (!d) continue; // e.g. a month heading with only a notation vote / unscheduled entry
    const parts = mm[1].split('/');
    const last = parts[parts.length - 1];
    const month = MONTH[last.toLowerCase()] || { Feb: 2, May: 5, Nov: 11, Aug: 8 }[last];
    const date = `${year}-${pad(month)}-${pad(Number(d[2] || d[1]))}`;
    meetings.set(date, { date, source: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' });
  }
}

function series(csv) {
  const m = new Map();
  for (const line of csv.trim().split(/\r?\n/).slice(1)) { const [d, v] = line.split(','); const n = Number(v); if (Number.isFinite(n)) m.set(d, n); }
  return m;
}
const old = series(await readFile(join(DIR, 'fred-DFEDTAR.csv'), 'utf8'));
const upper = series(await readFile(join(DIR, 'fred-DFEDTARU.csv'), 'utf8'));
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const valueOn = (d) => upper.get(d) ?? old.get(d) ?? null;
const lastOnOrBefore = (d) => { for (let k = 0; k < 10; k += 1) { const v = valueOn(shift(d, -k)); if (v !== null) return v; } return null; };

const today = new Date().toISOString().slice(0, 10);
const rows = [...meetings.values()].sort((a, b) => a.date.localeCompare(b.date)).map((m) => {
  const before = lastOnOrBefore(shift(m.date, -1));
  const decided = m.date < today ? lastOnOrBefore(shift(m.date, 2)) : null;
  const changeBps = before !== null && decided !== null ? Math.round((decided - before) * 100) : null;
  return { meetingDate: m.date, targetBefore: before, targetAfter: decided, changeBps, calendarSource: m.source, decisionSource: m.date <= '2008-12-15' ? 'FRED DFEDTAR' : 'FRED DFEDTARU' };
});

// cross-check with the curated registry
const curated = JSON.parse(await readFile(new URL('../../data/fomc/official-decisions.json', import.meta.url), 'utf8'));
let agree = 0;
for (const c of curated) {
  const r = rows.find((x) => x.meetingDate === c.meetingDate);
  if (!r) throw new Error(`curated meeting ${c.meetingDate} missing from scraped calendar`);
  if (r.changeBps !== c.changeBps) throw new Error(`decision mismatch ${c.meetingDate}: derived ${r.changeBps} vs curated ${c.changeBps}`);
  agree += 1;
}
await writeFile(new URL('../../data/fomc/scheduled-decisions.json', import.meta.url), JSON.stringify({ generated_at: new Date().toISOString(), curated_agreement: `${agree}/${curated.length}`, meetings: rows }, null, 1) + '\n');
console.log(`meetings ${rows.length}, decided ${rows.filter((r) => r.changeBps !== null).length}, curated agreement ${agree}/${curated.length}`);
console.log(rows.slice(-6));
