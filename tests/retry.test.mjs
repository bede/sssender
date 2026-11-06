import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { retryDelayMs, retryUntilDone } = await import(`${pathToFileURL(resolve(here, "../core/retry.js"))}?test=${Date.now()}`);

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
