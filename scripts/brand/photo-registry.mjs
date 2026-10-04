// Builds the Insights real-photo registry (Tier 1/2 of the image resolver, workers/pbe-predictions/src/insights/images.js).
// Every subject is an EXPLICIT Wikidata entity, verified before use: English label must match AND the entity's
// coordinates (P625) must lie within MAX_KM of the weather station it illustrates. The photo is the entity's own
// Wikidata image (P18) on Wikimedia Commons; license/author/source come from Commons' machine-readable extmetadata.
// Only free licenses with usable attribution are accepted; anything ambiguous or failing a check falls through (the
// resolver then uses a story-specific SVG). Downloads the 2400px Commons rendition as the master.
//   node scripts/brand/photo-registry.mjs            -> writes workers/pbe-predictions/src/insights/photo-registry.json
//                                                       + images/insights/_masters/photos/<key>.jpg (not deployed)
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CLI_STATIONS } from '../../src/weather/stations.js';

const UA = 'PropBetEdgePredictions/1.0 (https://predictions.propbetedge.ai; editorial image registry)';
const MAX_KM = 60;
const VERSION = 'v1';
// city key -> [Wikidata QID, expected English label, CLI stations it illustrates]
const CITIES = {
  'new-york': ['Q60', 'New York City', ['CLINYC']], chicago: ['Q1297', 'Chicago', ['CLIORD', 'CLIMDW']], austin: ['Q16559', 'Austin', ['CLIAUS']],
  miami: ['Q8652', 'Miami', ['CLIMIA']], denver: ['Q16554', 'Denver', ['CLIDEN']], philadelphia: ['Q1345', 'Philadelphia', ['CLIPHL']],
  'los-angeles': ['Q65', 'Los Angeles', ['CLILAX']], 'las-vegas': ['Q23768', 'Las Vegas', ['CLILAS']], 'new-orleans': ['Q34404', 'New Orleans', ['CLIMSY']],
  'san-francisco': ['Q62', 'San Francisco', ['CLISFO']], washington: ['Q61', 'Washington, D.C.', ['CLIDCA']], seattle: ['Q5083', 'Seattle', ['CLISEA']],
  boston: ['Q100', 'Boston', ['CLIBOS']], phoenix: ['Q16556', 'Phoenix', ['CLIPHX']], atlanta: ['Q23556', 'Atlanta', ['CLIATL']],
  minneapolis: ['Q36091', 'Minneapolis', ['CLIMSP']], dallas: ['Q16557', 'Dallas', ['CLIDFW']], 'san-antonio': ['Q975', 'San Antonio', ['CLISAT']],
  houston: ['Q16555', 'Houston', ['CLIHOU']], 'oklahoma-city': ['Q34863', 'Oklahoma City', ['CLIOKC']], newark: ['Q25395', 'Newark', ['CLIEWR']],
  trenton: ['Q25668', 'Trenton', ['CLITTN']], milwaukee: ['Q37836', 'Milwaukee', ['CLIMKE']], lexington: ['Q49241', 'Lexington', ['CLILEX']],
  columbus: ['Q16567', 'Columbus', ['CLICMH']], providence: ['Q18383', 'Providence', ['CLIPVD']], 'college-station': ['Q594362', 'College Station', ['CLICLL']],
  pittsburgh: ['Q1342', 'Pittsburgh', ['CLIPIT']], albuquerque: ['Q34804', 'Albuquerque', ['CLIABQ']], springfield: ['Q135615', 'Springfield', ['CLISGF']],
};
// Commons free licenses incl. the {{Attribution}} license and the Free Art License (both attribution-only / copyleft)
const FREE = /^(cc0|public domain|pd[- ]|pd$|cc[- ]by(-sa)?[- ]\d(\.\d)?|attribution$|fal$|free art license)/i;
const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const km = (a, b) => { const R = 6371, r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r; const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const getJson = async (url) => { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

const out = { generated_at: new Date().toISOString(), method: 'Wikidata P18 of an explicit entity, verified by label + coordinates within ' + MAX_KM + ' km of the station; Commons extmetadata license', subjects: {}, rejected: {} };
await mkdir('images/insights/_masters/photos', { recursive: true });
const ent = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${Object.values(CITIES).map((c) => c[0]).join('|')}&props=labels|claims&languages=en&format=json`);
for (const [key, [qid, label, stations]] of Object.entries(CITIES)) {
  try {
    const e = ent.entities[qid];
    const en = e?.labels?.en?.value || '';
    if (!en.toLowerCase().startsWith(label.toLowerCase().split(',')[0])) throw new Error(`label mismatch: ${qid} is "${en}", expected "${label}"`);
    const coord = e.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    if (!coord) throw new Error('no coordinates on entity');
    for (const cli of stations) { const st = CLI_STATIONS[cli]; const d = km({ lat: coord.latitude, lon: coord.longitude }, { lat: st.lat, lon: st.lon }); if (d > MAX_KM) throw new Error(`${cli} is ${Math.round(d)} km from ${qid}`); }
    const file = e.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (!file) throw new Error('entity has no image (P18)');
    const ii = await getJson(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(`File:${file}`)}&prop=imageinfo&iiprop=url|size|mime|extmetadata|sha1&iiurlwidth=2400&format=json`);
    const info = Object.values(ii.query.pages)[0].imageinfo?.[0];
    if (!info) throw new Error('no imageinfo');
    if (!/image\/(jpeg|png)/.test(info.mime)) throw new Error(`mime ${info.mime}`);
    if (info.width < 1600) throw new Error(`too small ${info.width}px`);
    const m = info.extmetadata || {};
    const license = strip(m.LicenseShortName?.value);
    if (!FREE.test(license)) throw new Error(`license not accepted: ${license || 'none'}`);
    const author = strip(m.Artist?.value).replace(/^[\s.,;:]+/, '') || null;
    const attributionRequired = String(m.AttributionRequired?.value || '').toLowerCase() === 'true';
    if (attributionRequired && !author) throw new Error('attribution required but no author');
    const img = await fetch(info.thumburl, { headers: { 'user-agent': UA } });
    if (!img.ok) throw new Error(`download ${img.status}`);
    const bytes = Buffer.from(await img.arrayBuffer());
    await writeFile(`images/insights/_masters/photos/${key}.jpg`, bytes);
    out.subjects[key] = {
      key: `photo-${key}`, version: VERSION, focal: '50% 55%', stations,
      alt: `${label}${strip(m.ImageDescription?.value) ? ` — ${strip(m.ImageDescription.value).slice(0, 140)}` : ''}`,
      match: { type: 'wikidata-p18', entity: qid, label: en, verified: `label + coordinates within ${MAX_KM} km of ${stations.join(', ')}` },
      credit: { source_class: 'wikimedia-commons', source_url: info.descriptionurl, original_url: info.url, author, license, license_url: m.LicenseUrl?.value || null, attribution_required: attributionRequired,
        attribution: `${author ? `Photo: ${author}` : 'Photo'} · ${license} · via Wikimedia Commons`, file: `File:${file}`, commons_sha1: info.sha1 },
      master: { width: info.thumbwidth, height: info.thumbheight, sha256: createHash('sha256').update(bytes).digest('hex') },
    };
    console.log('ok', key, license, author, info.thumbwidth);
  } catch (err) { out.rejected[key] = err.message; console.log('REJECT', key, err.message); }
  await new Promise((r) => setTimeout(r, 400)); // be polite to Wikimedia
}
await writeFile('workers/pbe-predictions/src/insights/photo-registry.json', `${JSON.stringify(out, null, 1)}\n`);
console.log(`subjects ${Object.keys(out.subjects).length} rejected ${Object.keys(out.rejected).length}`);
