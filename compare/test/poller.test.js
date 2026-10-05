// Polling lifecycle: no duplicate timers, listeners or overlapping requests across mount/unmount cycles,
// hidden tabs stop polling, visibility return refreshes immediately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from '../poller.js';

function fakeEnv() {
  let now = 0, id = 0;
  const timers = new Map();
  const doc = { hidden: false, listeners: new Set(), addEventListener(t, f) { this.listeners.add(f); }, removeEventListener(t, f) { this.listeners.delete(f); }, fire() { for (const f of [...this.listeners]) f(); } };
  return {
    doc, timers,
    setTimer: (f, ms) => { const k = ++id; timers.set(k, { f, at: now + ms }); return k; },
    clearTimer: (k) => { timers.delete(k); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].f();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
      await new Promise((r) => setImmediate(r));
    }
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test('three mount/unmount cycles leave zero timers, listeners and in-flight requests', async () => {
  const env = fakeEnv();
  const life = createLifecycle({ doc: env.doc, setTimer: env.setTimer, clearTimer: env.clearTimer });
  let calls = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    life.poller('markets', { run: async () => { calls++; }, interval: () => 60e3 }).start();
    life.poller('scores', { run: async () => { calls++; }, interval: () => 15e3 }).start();
    await flush();
    assert.equal(life.ledger.timers, 2, `cycle ${cycle}: exactly one timer per poller`);
    assert.equal(env.timers.size, 2);
    assert.equal(env.doc.listeners.size, 1, 'one visibility listener for the whole lifecycle');
    await env.advance(60e3);
    assert.equal(env.timers.size, 2, 'rescheduling never stacks timers');
    life.stopAll();
    assert.equal(env.timers.size, 0);
    assert.equal(life.ledger.timers, 0);
    assert.equal(life.ledger.inflight, 0);
    assert.equal(env.doc.listeners.size, 0);
  }
  // per cycle: 2 initial + scores at 15/30/45/60 (4) + markets at 60 (1) = 7
  assert.equal(calls, 21);
});

test('re-creating a poller with the same name replaces it (no duplicate)', async () => {
  const env = fakeEnv();
  const life = createLifecycle({ doc: env.doc, setTimer: env.setTimer, clearTimer: env.clearTimer });
  life.poller('markets', { run: async () => {}, interval: () => 60e3 }).start();
  life.poller('markets', { run: async () => {}, interval: () => 60e3 }).start();
  await flush();
  assert.equal(env.timers.size, 1);
  assert.equal(life.size, 1);
  life.stopAll();
});

test('no overlapping runs: a slow request is never doubled; stop aborts it', async () => {
  const env = fakeEnv();
  const life = createLifecycle({ doc: env.doc, setTimer: env.setTimer, clearTimer: env.clearTimer });
  let release, started = 0, aborted = false;
  const p = life.poller('slow', { run: (signal) => { started++; signal.addEventListener('abort', () => { aborted = true; release(); }); return new Promise((r) => { release = r; }); }, interval: () => 1000 });
  p.start();
  p.refresh(); p.refresh();
  await flush();
  assert.equal(started, 1, 'refresh while in flight does not start a second request');
  assert.equal(life.ledger.skippedOverlap, 2);
  assert.equal(env.timers.size, 0, 'no timer is armed while a run is in flight');
  p.stop();
  await flush();
  assert.equal(aborted, true);
  assert.equal(life.ledger.inflight, 0);
  assert.equal(env.timers.size, 0);
});

test('hidden tab: no timers; visible again: immediate refresh then normal cadence', async () => {
  const env = fakeEnv();
  const life = createLifecycle({ doc: env.doc, setTimer: env.setTimer, clearTimer: env.clearTimer });
  let calls = 0;
  life.poller('scores', { run: async () => { calls++; }, interval: () => 15e3 }).start();
  await flush();
  assert.equal(calls, 1);
  env.doc.hidden = true; env.doc.fire();
  assert.equal(env.timers.size, 0, 'hidden = no polling at all');
  await env.advance(10 * 60e3);
  assert.equal(calls, 1);
  env.doc.hidden = false; env.doc.fire();
  await flush();
  assert.equal(calls, 2, 'refreshes immediately on return');
  assert.equal(env.timers.size, 1);
  env.doc.fire(); env.doc.fire(); // repeated visibility events
  await flush();
  assert.equal(env.timers.size, 1, 'repeated visibility events never stack timers');
  life.stopAll();
});
