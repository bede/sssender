import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { holdAwake } = await import(`${pathToFileURL(resolve(here, "../ui/ui.js"))}?test=${Date.now()}`);

// Plain objects stand in for document, navigator and window
function browser({ visible = true, refuse = false } = {}) {
  const listeners = new Map();
  const target = () => ({
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.get(type) === fn && listeners.delete(type),
  });
  const locks = [];
  const doc = { ...target(), visibilityState: visible ? "visible" : "hidden" };
  const nav = {
    wakeLock: {
      request: async () => {
        if (refuse) throw new Error("NotAllowedError");
        const lock = { released: false };
        lock.release = async () => {
          lock.released = true;
        };
        locks.push(lock);
        return lock;
      },
    },
  };
  return { doc, nav, win: target(), locks, listeners };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("holdAwake keeps the screen on and asks before leaving, until released", async () => {
  const b = browser();
  const release = holdAwake(b);
  await settle();
  assert.equal(b.locks.length, 1);
  assert.ok(b.listeners.has("beforeunload"));
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  b.listeners.get("beforeunload")(e);
  assert.ok(e.prevented);
  release();
  await settle();
  assert.ok(b.locks[0].released);
  assert.ok(!b.listeners.has("beforeunload") && !b.listeners.has("visibilitychange"));
});

test("holdAwake takes the lock again when a hidden page is shown", async () => {
  const b = browser({ visible: false });
  const release = holdAwake(b);
  await settle();
  assert.equal(b.locks.length, 0); // browsers refuse a hidden page
  b.doc.visibilityState = "visible";
  b.listeners.get("visibilitychange")();
  await settle();
  assert.equal(b.locks.length, 1);
  b.locks[0].release(); // the browser drops it when the page is hidden again
  b.listeners.get("visibilitychange")();
  await settle();
  assert.equal(b.locks.length, 2);
  release();
});

for (const order of [[0, 1], [1, 0]]) {
  test(`holdAwake releases overlapping acquisitions resolved in order ${order}`, async () => {
    const b = browser();
    const grant = b.nav.wakeLock.request;
    const pending = [];
    b.nav.wakeLock.request = () => new Promise((resolve) => pending.push(() => resolve(grant())));
    const release = holdAwake(b);
    b.doc.visibilityState = "hidden";
    b.listeners.get("visibilitychange")();
    b.doc.visibilityState = "visible";
    b.listeners.get("visibilitychange")();
    assert.equal(pending.length, 2);

    pending[order[0]]();
    await settle();
    pending[order[1]]();
    await settle();
    assert.ok(!b.locks[0].released, "the retained lock keeps the screen awake");
    assert.ok(b.locks[1].released, "the redundant lock is released immediately");
    release();
    await settle();
    assert.ok(b.locks.every((lock) => lock.released), "cleanup releases every acquired lock");
  });
}

test("holdAwake releases a lock acquired after cleanup", async () => {
  const b = browser();
  const grant = b.nav.wakeLock.request;
  let finishRequest;
  b.nav.wakeLock.request = () => new Promise((resolve) => (finishRequest = () => resolve(grant())));
  const release = holdAwake(b);

  release();
  assert.ok(!b.listeners.has("beforeunload") && !b.listeners.has("visibilitychange"));
  finishRequest();
  await settle();
  assert.equal(b.locks.length, 1);
  assert.ok(b.locks[0].released, "a pending acquisition cannot outlive cleanup");
});

test("holdAwake carries on when the lock is refused or unsupported", async () => {
  holdAwake(browser({ refuse: true }))();
  holdAwake({ ...browser(), nav: {} })();
  await settle();
});
