// SQLite-backed Durable Object implementing the state contract of state.js over RPC. Tables are append-only except
// kv (scheduler state), lease and the mirror retry queue. No method deletes ledger, index or tick rows.
import { DurableObject } from 'cloudflare:workers';

export class CollectorState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (ns TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (ns TEXT PRIMARY KEY, holder TEXT NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS idx (ns TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 0, at TEXT, path TEXT, status TEXT);
      CREATE INDEX IF NOT EXISTS idx_ns ON idx (ns, kind, key);
      CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mirror (id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT NOT NULL, json TEXT NOT NULL);`);
  }
  acquire(ns, holder, ttlMs, nowMs) {
    const l = this.sql.exec('SELECT holder, until FROM lease WHERE ns = ?', ns).toArray()[0];
    if (l && l.until > nowMs && l.holder !== holder) return false;
    this.sql.exec('INSERT INTO lease (ns, holder, until) VALUES (?, ?, ?) ON CONFLICT(ns) DO UPDATE SET holder = excluded.holder, until = excluded.until', ns, holder, nowMs + ttlMs);
    return true;
  }
  release(ns, holder) { this.sql.exec('DELETE FROM lease WHERE ns = ? AND holder = ?', ns, holder); }
  getState(ns) { const r = this.sql.exec('SELECT v FROM kv WHERE ns = ?', ns).toArray()[0]; return r ? JSON.parse(r.v) : {}; }
  putState(ns, obj) { this.sql.exec('INSERT INTO kv (ns, v) VALUES (?, ?) ON CONFLICT(ns) DO UPDATE SET v = excluded.v', ns, JSON.stringify(obj)); }
  index(ns) { return this.sql.exec('SELECT kind, key, ok, at, path, status FROM idx WHERE ns = ?', ns).toArray(); }
  addIndex(ns, rows) { for (const r of rows) this.sql.exec('INSERT INTO idx (ns, kind, key, ok, at, path, status) VALUES (?, ?, ?, ?, ?, ?, ?)', ns, r.kind, r.key, r.ok ? 1 : 0, r.at ?? null, r.path ?? null, r.status ?? null); }
  appendLedger(ns, entries) { for (const e of entries) this.sql.exec('INSERT INTO ledger (ns, at, type, json) VALUES (?, ?, ?, ?)', ns, e.at_utc, e.type, JSON.stringify(e)); }
  ledgerTail(ns, n = 50) { return this.sql.exec('SELECT seq, json FROM ledger WHERE ns = ? ORDER BY seq DESC LIMIT ?', ns, n).toArray().reverse().map((r) => ({ seq: r.seq, ...JSON.parse(r.json) })); }
  addTick(ns, rec) { this.sql.exec('INSERT INTO ticks (ns, at, json) VALUES (?, ?, ?)', ns, rec.at_utc, JSON.stringify(rec)); }
  ticks(ns, n = 50) { return this.sql.exec('SELECT json FROM ticks WHERE ns = ? ORDER BY id DESC LIMIT ?', ns, n).toArray().reverse().map((r) => JSON.parse(r.json)); }
  queueMirror(ns, item) { this.sql.exec('INSERT INTO mirror (ns, json) VALUES (?, ?)', ns, JSON.stringify(item)); }
  pendingMirror(ns) { return this.sql.exec('SELECT id, json FROM mirror WHERE ns = ? ORDER BY id', ns).toArray().map((r) => ({ id: r.id, ...JSON.parse(r.json) })); }
  clearMirror(ns, id) { this.sql.exec('DELETE FROM mirror WHERE ns = ? AND id = ?', ns, id); }
}
