// Engine persistence on the append-only Predictions ledger (tkmln). Inserts ignore duplicates (idempotent
// re-runs); nothing is ever updated except the mutable registry row pred_events.
import { SupabasePredictionsLedger } from '../supabase-ledger.js';

export class EngineStore extends SupabasePredictionsLedger {
  async select(table, query, { limit = 1000, order = null } = {}) {
    const url = new URL(`${this.url}/rest/v1/${table}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    if (order) url.searchParams.set('order', order);
    url.searchParams.set('limit', String(limit));
    const res = await this.fetchImpl(url, { headers: { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Supabase read ${table} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  insertMany(table, rows, conflictColumn) {
    if (!rows.length) return Promise.resolve(null);
    return this.write(table, rows, { conflictColumn });
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
