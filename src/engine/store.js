// Engine persistence on the append-only Predictions ledger (tkmln). Inserts ignore duplicates (idempotent
// re-runs); nothing is ever updated except the mutable registry row pred_events.
// Reads page in 1000-row pages: Supabase PostgREST caps every response at 1000 rows regardless of `limit`.
import { SupabasePredictionsLedger } from '../supabase-ledger.js';

export const PAGE = 1000;
const DEFAULT_ORDER = {
  pred_events: 'event_id.asc', pred_contracts: 'contract_id.asc', pred_forecasts: 'forecast_id.asc', pred_venue_snapshots: 'venue_snapshot_id.asc',
  pred_forecast_designations: 'designation_id.asc', pred_resolutions: 'resolution_id.asc', pred_scores: 'score_id.asc',
  pred_feature_snapshots: 'snapshot_id.asc', pred_source_observations: 'observation_key.asc',
};

export const inList = (ids) => `in.(${ids.map((i) => `"${String(i).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`;
export function chunk(arr, n = 40) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

export class EngineStore extends SupabasePredictionsLedger {
  // limit = maximum rows wanted in total (default: everything); pages of 1000 until a short page.
  async select(table, query, { limit = Infinity, order = null } = {}) {
    const rows = [];
    const ord = order || DEFAULT_ORDER[table] || null;
    for (let offset = 0; rows.length < limit; offset += PAGE) {
      const url = new URL(`${this.url}/rest/v1/${table}`);
      for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
      if (ord) url.searchParams.set('order', ord);
      const want = Math.min(PAGE, limit - rows.length);
      url.searchParams.set('limit', String(want));
      url.searchParams.set('offset', String(offset));
      const res = await this.fetchImpl(url, { headers: { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}`, accept: 'application/json' } });
      if (!res.ok) throw new Error(`Supabase read ${table} failed: ${res.status} ${await res.text()}`);
      const page = await res.json();
      rows.push(...page);
      if (page.length < want) break;
    }
    return rows;
  }

  // select with a long id list: chunked `in.(...)` filters, each chunk paged.
  async selectIn(table, query, column, ids, opts = {}) {
    const out = [];
    for (const part of chunk([...new Set(ids)], opts.chunkSize || 40)) out.push(...await this.select(table, { ...query, [column]: inList(part) }, opts));
    return out;
  }

  insertMany(table, rows, conflictColumn) {
    if (!rows.length) return Promise.resolve(null);
    return Promise.all(chunk(rows, 500).map((part) => this.write(table, part, { conflictColumn })));
  }

  upsertEventRow(row) {
    return this.write('pred_events', { ...row, updated_at: new Date().toISOString() }, { conflictColumn: 'event_id', merge: true });
  }

  insertContracts(rows) { return this.insertMany('pred_contracts', rows, 'contract_id'); }
  insertVenueSnapshots(rows) { return this.insertMany('pred_venue_snapshots', rows, 'snapshot_key'); }
  insertObservations(rows) { return this.insertMany('pred_source_observations', rows, 'observation_key'); }
  insertFeatureRows(rows) { return this.insertMany('pred_feature_snapshots', rows, 'snapshot_id'); }
  insertForecastRows(rows) { return this.insertMany('pred_forecasts', rows, 'record_id'); }

  async insertReturning(table, rows) {
    if (!rows.length) return [];
    return (await this.write(table, rows, { returnRepresentation: true })) || [];
  }
}
