// Polling lifecycle with an instrumentation ledger (window.__compareLedger in the browser).
// Guarantees: one timer per poller; never two in-flight runs of the same poller; stop() clears the timer and
// aborts the in-flight request; hidden document = no timers at all; visible again = immediate refresh.
// A single visibilitychange listener is owned by the Lifecycle, never by individual pollers.

export function createLedger() {
  return { timers: 0, inflight: 0, runs: 0, aborted: 0, skippedOverlap: 0, listeners: 0, mounts: 0, unmounts: 0, byName: {} };
}

export function createLifecycle({ doc, setTimer = setTimeout, clearTimer = clearTimeout, ledger = createLedger() } = {}) {
  const pollers = new Map();
  let listening = false;
  const onVis = () => {
    for (const p of pollers.values()) {
      if (doc.hidden) p.pause(); else p.resume();
    }
  };
  function listen() {
    if (listening || !doc?.addEventListener) return;
    doc.addEventListener('visibilitychange', onVis);
    listening = true; ledger.listeners += 1;
  }
  function unlisten() {
    if (!listening) return;
    doc.removeEventListener('visibilitychange', onVis);
    listening = false; ledger.listeners -= 1;
  }

  function poller(name, { run, interval }) {
    if (pollers.has(name)) pollers.get(name).stop();
    let timer = null, ctrl = null, running = false, stopped = false, paused = false;
    const stats = ledger.byName[name] = ledger.byName[name] || { runs: 0, timers: 0 };
    const clear = () => { if (timer !== null) { clearTimer(timer); timer = null; ledger.timers -= 1; stats.timers -= 1; } };
    const schedule = () => {
      clear();
      if (stopped || paused || doc?.hidden) return;
      const ms = interval();
      if (!(ms > 0)) return;
      timer = setTimer(() => { timer = null; ledger.timers -= 1; stats.timers -= 1; tick(); }, ms);
      ledger.timers += 1; stats.timers += 1;
    };
    async function tick() {
      if (stopped) return;
      if (running) { ledger.skippedOverlap += 1; return; }
      running = true; ctrl = new AbortController(); ledger.inflight += 1; ledger.runs += 1; stats.runs += 1;
      try { await run(ctrl.signal); } catch (e) { if (e?.name !== 'AbortError') throw e; }
      finally { running = false; ctrl = null; ledger.inflight -= 1; if (!stopped) schedule(); }
    }
    const api = {
      name,
      start() { stopped = false; paused = false; ledger.mounts += 1; return tick(); },
      refresh() { clear(); return tick(); },
      reschedule() { if (!running) schedule(); },
      pause() { paused = true; clear(); },
      resume() { if (stopped) return; paused = false; clear(); return tick(); },
      stop() {
        if (stopped) return;
        stopped = true; clear();
        if (ctrl) { ctrl.abort(); ledger.aborted += 1; }
        ledger.unmounts += 1; pollers.delete(name);
        if (!pollers.size) unlisten();
      },
      get state() { return { running, paused, stopped, hasTimer: timer !== null }; }
    };
    pollers.set(name, api);
    listen();
    return api;
  }

  return {
    ledger,
    poller,
    stopAll() { for (const p of [...pollers.values()]) p.stop(); },
    get size() { return pollers.size; }
  };
}
