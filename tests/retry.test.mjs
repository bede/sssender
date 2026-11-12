import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { retryDelayMs, retryUntilDone, waitForOnline } = await import(`${pathToFileURL(resolve(here, "../core/retry.js"))}?test=${Date.now()}`);

const network = () => Object.assign(new Error("offline"), { kind: "network" });
const retryable = (err) => err.kind === "network";

test("retryDelayMs backs off exponentially and caps at one minute", () => {
  assert.equal(retryDelayMs(1), 1000);
  assert.equal(retryDelayMs(2), 2000);
  assert.equal(retryDelayMs(6), 32000);
  assert.equal(retryDelayMs(7), 60000);
  assert.equal(retryDelayMs(20), 60000);
});

test("retries what it's told to, backing off, until the attempt succeeds", async () => {
  const sleeps = [];
  const infos = [];
  let n = 0;
  const out = await retryUntilDone(async (attempt) => (++n < 4 ? Promise.reject(network()) : `done on ${attempt}`), {
    retryable,
    onlineFn: () => true,
    sleepFn: async (ms) => sleeps.push(ms),
    onRetry: (i) => infos.push([i.attempt, i.waitingOnline, i.waitMs]),
  });
  assert.equal(out, "done on 3");
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.deepEqual(infos, [[1, false, 1000], [2, false, 2000], [3, false, 4000]]);
});

test("throws anything not retryable, and anything beforeRetry objects to", async () => {
  const bad = new Error("bad request");
  await assert.rejects(retryUntilDone(async () => Promise.reject(bad), { retryable, onlineFn: () => true }), (e) => e === bad);
  const gone = new Error("gone");
  let calls = 0;
  await assert.rejects(
    retryUntilDone(async () => (calls++, Promise.reject(network())), {
      retryable,
      onlineFn: () => true,
      beforeRetry: () => Promise.reject(gone),
    }),
    (e) => e === gone
  );
  assert.equal(calls, 1);
});

test("never starts an attempt offline: it waits, then says it resumed", async () => {
  let online = false;
  const events = [];
  await retryUntilDone(async () => events.push("attempt"), {
    retryable,
    onlineFn: () => online,
    sleepFn: () => new Promise(() => {}),
    waitOnlineFn: async () => (events.push("wait"), (online = true)),
    onRetry: (i) => events.push(i.waitingOnline ? "offline" : i.resumed ? "resumed" : "backoff"),
  });
  assert.deepEqual(events, ["offline", "wait", "resumed", "attempt"]);
});

test("a deadline ends the retries, and no wait overruns it", async () => {
  let now = 0;
  const sleeps = [];
  const expired = new Error("expired");
  await assert.rejects(
    retryUntilDone(async () => Promise.reject(network()), {
      retryable,
      deadline: 2500,
      expired: () => expired,
      onlineFn: () => true,
      nowFn: () => now,
      sleepFn: async (ms) => (sleeps.push(ms), (now += ms)),
    }),
    (e) => e === expired
  );
  assert.deepEqual(sleeps, [1000, 1500]);
});

test("aborting the signal ends a wait with its reason", async () => {
  const ctrl = new AbortController();
  const reason = new Error("cancelled");
  await assert.rejects(
    retryUntilDone(async () => Promise.reject(network()), {
      retryable,
      signal: ctrl.signal,
      onlineFn: () => true,
      sleepFn: () => new Promise(() => {}),
      onRetry: () => ctrl.abort(reason),
    }),
    (e) => e === reason
  );
});

test("Cancel ends a beforeRetry check that never returns", async () => {
  const ctrl = new AbortController();
  const reason = new Error("cancelled");
  const run = retryUntilDone(async () => Promise.reject(network()), {
    retryable,
    signal: ctrl.signal,
    onlineFn: () => true,
    sleepFn: async () => {},
    beforeRetry: () => new Promise(() => {}), // e.g. a read from a vanished network share
  });
  setTimeout(() => ctrl.abort(reason), 0);
  await assert.rejects(run, (e) => e === reason);
});

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimerFn(fn, ms) { pending.set(++seq, { fn, ms }); return seq; },
    clearTimerFn(id) { pending.delete(id); },
    fire() {
      const [id, timer] = pending.entries().next().value;
      pending.delete(id);
      timer.fn();
    },
    get size() { return pending.size; },
    get delays() { return [...pending.values()].map((t) => t.ms); },
  };
}

test("repeated offline polls keep one listener/timer and clear both when online", async () => {
  const timers = fakeTimers();
  const target = new EventTarget();
  let online = false;
  let attempts = 0;
  const run = retryUntilDone(async () => attempts++, {
    retryable, onlineFn: () => online, ...timers,
    waitOnlineFn: (options) => waitForOnline({ ...options, target }),
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(getEventListeners(target, "online").length, 1);
    assert.equal(timers.size, 1);
    timers.fire();
    await new Promise(setImmediate);
  }
  online = true;
  target.dispatchEvent(new Event("online"));
  await run;
  assert.equal(attempts, 1);
  assert.equal(getEventListeners(target, "online").length, 0);
  assert.equal(timers.size, 0);
});

test("Cancel removes the offline listener and its polling timer", async () => {
  const timers = fakeTimers();
  const target = new EventTarget();
  const ctrl = new AbortController();
  const reason = new Error("Cancelled offline");
  const run = retryUntilDone(() => assert.fail("must not send offline"), {
    retryable, signal: ctrl.signal, onlineFn: () => false, ...timers,
    waitOnlineFn: (options) => waitForOnline({ ...options, target }),
  });
  ctrl.abort(reason);
  await assert.rejects(run, (err) => err === reason);
  assert.equal(getEventListeners(target, "online").length, 0);
  assert.equal(timers.size, 0);
});

test("Cancel clears the actual backoff timer", async () => {
  const timers = fakeTimers();
  const ctrl = new AbortController();
  const run = retryUntilDone(async () => { throw network(); }, {
    retryable, signal: ctrl.signal, onlineFn: () => true, ...timers,
  });
  await new Promise(setImmediate);
  assert.deepEqual(timers.delays, [1000]);
  const reason = new Error("Cancelled backoff");
  ctrl.abort(reason);
  await assert.rejects(run, (err) => err === reason);
  assert.equal(timers.size, 0);
});

test("expiry bounds offline waits and prevents any request starting", async () => {
  const timers = fakeTimers();
  const target = new EventTarget();
  let now = 0;
  const expired = new Error("Expired offline");
  const run = retryUntilDone(() => assert.fail("must not send"), {
    retryable, onlineFn: () => false, deadline: 500, nowFn: () => now,
    expired: () => expired, ...timers,
    waitOnlineFn: (options) => waitForOnline({ ...options, target }),
  });
  assert.deepEqual(timers.delays, [500]);
  now = 500;
  timers.fire();
  await assert.rejects(run, (err) => err === expired);
  assert.equal(getEventListeners(target, "online").length, 0);
  assert.equal(timers.size, 0);
});

test("expiry ends a hung beforeRetry check and cancels its own wait", async () => {
  const timers = fakeTimers();
  const ctrl = new AbortController();
  let checkSignal;
  const expired = new Error("Expired during check");
  const run = retryUntilDone(async () => { throw network(); }, {
    retryable, signal: ctrl.signal, onlineFn: () => true,
    deadline: 500, nowFn: () => 0, expired: () => expired, ...timers,
    beforeRetry: (_err, { signal }) => { checkSignal = signal; return new Promise(() => {}); },
  });
  await new Promise(setImmediate);
  assert.deepEqual(timers.delays, [500]);
  timers.fire();
  await assert.rejects(run, (err) => err === expired);
  assert.ok(checkSignal.aborted);
  assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
  assert.equal(timers.size, 0);
});
