// Collector state API (namespaced: 'auth' authoritative, 'shadow', 'rehearsal:<id>'). Production uses the SQLite-backed
// Durable Object in state-do.js (one global instance = single writer; a lease stops overlapping ticks). MemoryState
// implements the same contract for tests. The capture index is written only AFTER the evidence bytes are in R2, and it is
// the index (never a clock or a retry) that tells the planner a slot was satisfied; verify() re-derives it from R2.
export class MemoryState {
  constructor() { this.kv = new Map(); this.idx = []; this.ledger = []; this.tickLog = []; this.mirror = []; this.leases = new Map(); this.seq = 0; }
  async acquire(ns, holder, ttlMs, nowMs) { const l = this.leases.get(ns); if (l && l.until > nowMs && l.holder !== holder) return false; this.leases.set(ns, { holder, until: nowMs + ttlMs }); return true; }
  async release(ns, holder) { if (this.leases.get(ns)?.holder === holder) this.leases.delete(ns); }
  async getState(ns) { return structuredClone(this.kv.get(ns) || {}); }
  async putState(ns, obj) { this.kv.set(ns, structuredClone(obj)); }
  async index(ns) { return this.idx.filter((r) => r.ns === ns).map(({ ns: _, ...r }) => r); }
  async addIndex(ns, rows) { for (const r of rows) this.idx.push({ ns, ok: 0, path: null, ...r }); }
  async appendLedger(ns, entries) { for (const e of entries) this.ledger.push({ ns, seq: ++this.seq, ...e }); }
  async ledgerTail(ns, n = 50) { return this.ledger.filter((r) => r.ns === ns).slice(-n); }
  async addTick(ns, rec) { this.tickLog.push({ ns, ...rec }); }
  async ticks(ns, n = 50) { return this.tickLog.filter((r) => r.ns === ns).slice(-n); }
  async queueMirror(ns, item) { this.mirror.push({ ns, id: ++this.seq, ...item }); }
  async pendingMirror(ns) { return this.mirror.filter((m) => m.ns === ns); }
  async clearMirror(ns, id) { this.mirror = this.mirror.filter((m) => !(m.ns === ns && m.id === id)); }
}
