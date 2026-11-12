import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { checkReadable, isRetryableUploadError, postObjectWithRetry, postObject, STALL_MS, RESPONSE_MS, READ_CHECK_MS } = await import(
  `${pathToFileURL(resolve(here, "../core/post.js"))}?test=${Date.now()}`
);

test("isRetryableUploadError only retries transient upload failures", () => {
  const network = new Error("offline");
  network.kind = "network";
  assert.equal(isRetryableUploadError(network), true);

  for (const status of [408, 429, 500, 503]) {
    const err = new Error(`HTTP ${status}`);
    err.status = status;
    assert.equal(isRetryableUploadError(err), true, String(status));
  }

  for (const cause of ["link", "size", "storage", "cors"]) {
    const err = new Error(cause);
    err.kind = cause;
    assert.equal(isRetryableUploadError(err), false, cause);
  }

  const badRequest = new Error("bad request");
  badRequest.status = 400;
  assert.equal(isRetryableUploadError(badRequest), false);
});

test("postObjectWithRetry retries transient errors until the POST succeeds", async () => {
  const attempts = [];
  const sleeps = [];
  const link = { expiresAt: Date.parse("2026-07-09T00:10:00Z") };
  const network = new Error("offline");
  network.kind = "network";

  await postObjectWithRetry({
    link,
    key: "prefix/file.fastq.gz",
    body: new Blob(["x"]),
    nowFn: () => Date.parse("2026-07-09T00:00:00Z"),
    sleepFn: async (ms) => sleeps.push(ms),
    postOnce: async () => {
      attempts.push(1);
      if (attempts.length < 3) throw network;
    },
  });

  assert.equal(attempts.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("postObjectWithRetry stops retrying when the magic link expires", async () => {
  let now = Date.parse("2026-07-09T00:00:00Z");
  const sleeps = [];
  const link = { expiresAt: now + 2500 };
  const network = new Error("offline");
  network.kind = "network";

  await assert.rejects(
    () =>
      postObjectWithRetry({
        link,
        key: "prefix/file.fastq.gz",
        body: new Blob(["x"]),
        nowFn: () => now,
        sleepFn: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        postOnce: async () => {
          throw network;
        },
      }),
    /magic link expired/
  );

  assert.deepEqual(sleeps, [1000, 1500]);
});

test("postObjectWithRetry waits for online after an offline upload failure", async () => {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });

  const events = [];
  const attempts = [];
  const link = { expiresAt: Date.parse("2026-07-09T00:10:00Z") };
  const offline = new Error("Connection lost during upload.");
  offline.kind = "network";
  offline.offline = true;

  try {
    await postObjectWithRetry({
      link,
      key: "prefix/file.fastq.gz",
      body: new Blob(["x"]),
      nowFn: () => Date.parse("2026-07-09T00:00:00Z"),
      sleepFn: () => new Promise(() => {}),
      waitOnlineFn: async () => {
        events.push("wait-online");
        globalThis.navigator.onLine = true;
      },
      onRetry: (info) => events.push(info.waitingOnline ? "waiting-online" : info.resumed ? "resumed" : "backoff"),
      postOnce: async () => {
        attempts.push(1);
        if (attempts.length === 1) {
          globalThis.navigator.onLine = false;
          throw offline;
        }
      },
    });
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }

  assert.equal(attempts.length, 2);
  assert.deepEqual(events, ["waiting-online", "wait-online", "resumed"]);
});

test("postObjectWithRetry does not start a POST while already offline", async () => {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: false },
  });

  const events = [];
  const attempts = [];
  const link = { expiresAt: Date.parse("2026-07-09T00:10:00Z") };

  try {
    await postObjectWithRetry({
      link,
      key: "prefix/file.fastq.gz",
      body: new Blob(["x"]),
      nowFn: () => Date.parse("2026-07-09T00:00:00Z"),
      sleepFn: () => new Promise(() => {}),
      waitOnlineFn: async () => {
        events.push(`wait-before-${attempts.length}`);
        globalThis.navigator.onLine = true;
      },
      onRetry: (info) => events.push(info.waitingOnline ? "waiting-online" : info.resumed ? "resumed" : "backoff"),
      postOnce: async () => {
        attempts.push(1);
      },
    });
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }

  assert.equal(attempts.length, 1);
  assert.deepEqual(events, ["waiting-online", "wait-before-0", "resumed"]);
});

// --- Idle timeouts ------------------------------------------------------------
// Timers are injected so these run instantly. The real durations are minutes long.

function fakeTimers() {
  let seq = 0;
  let setCount = 0;
  const pending = new Map();
  return {
    setTimerFn(fn, ms) {
      setCount++;
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimerFn(id) {
      pending.delete(id);
    },
    get armed() {
      return [...pending.values()].map((t) => t.ms);
    },
    get setCount() {
      return setCount;
    },
    // Fire by duration, so tests read as "the stall timer expired"
    fire(ms) {
      for (const [id, t] of pending) {
        if (t.ms !== ms) continue;
        pending.delete(id);
        t.fn();
        return;
      }
      throw new Error(`no timer armed for ${ms}ms (armed: ${[...pending.values()].map((t) => t.ms)})`);
    },
  };
}

// A pending promise resolves the sentinel first, a settled one wins the race
const settledYet = (p) =>
  Promise.race([p.then(() => true, () => true), Promise.resolve(false)]);

function withMockXhr(run) {
  const originalWindow = globalThis.window;
  const originalXhr = globalThis.XMLHttpRequest;
  const listeners = new Map();
  let xhr = null;

  class MockXhr {
    constructor() {
      this.upload = {};
      this.status = 200;
      this.statusText = "OK";
      this.responseText = "";
      this.aborted = false;
      xhr = this;
    }
    open() {}
    send(form) { this.form = form; }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    progress(loaded) {
      this.upload.onprogress?.({ loaded, total: 1000 });
    }
    bodySent() {
      this.upload.onloadend?.();
    }
    respond(status = 200) {
      this.status = status;
      this.onload?.();
    }
  }

  globalThis.window = {
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  globalThis.XMLHttpRequest = MockXhr;

  const link = { endpoint: "https://example.test", bucket: "bucket", fields: {} };
  const start = (timers, options = {}) =>
    postObject({
      link,
      key: "prefix/file.fastq.gz",
      body: new Blob(["x"]),
      onProgress: () => {},
      setTimerFn: timers.setTimerFn,
      clearTimerFn: timers.clearTimerFn,
      ...options,
    });

  return (async () => {
    try {
      return await run({ start, goOffline: () => listeners.get("offline")(), xhr: () => xhr, listeners });
    } finally {
      globalThis.window = originalWindow;
      globalThis.XMLHttpRequest = originalXhr;
    }
  })();
}

test("a silent upload aborts once the stall timer expires", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(100);
    xhr().progress(200);
    timers.fire(STALL_MS);

    await assert.rejects(upload, (err) => {
      assert.equal(err.kind, "network");
      assert.equal(isRetryableUploadError(err), true);
      return /stalled/i.test(err.message);
    });
    assert.equal(xhr().aborted, true);
    assert.deepEqual(timers.armed, []);
  }));

test("postObjectWithRetry retries a stalled upload rather than failing the run", async () => {
  const stalled = await withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);
    timers.fire(STALL_MS);
    return upload.catch((err) => err);
  });

  const attempts = [];
  await postObjectWithRetry({
    link: { expiresAt: Date.parse("2026-07-09T00:10:00Z") },
    key: "prefix/file.fastq.gz",
    body: new Blob(["x"]),
    nowFn: () => Date.parse("2026-07-09T00:00:00Z"),
    sleepFn: async () => {},
    postOnce: async () => {
      attempts.push(1);
      if (attempts.length === 1) throw stalled;
    },
  });

  assert.equal(attempts.length, 2);
});

test("continuing progress keeps resetting the stall timer", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    for (const loaded of [100, 200, 300, 400]) xhr().progress(loaded);

    // One live timer, not one per event
    assert.deepEqual(timers.armed, [STALL_MS]);
    assert.equal(await settledYet(upload), false);

    xhr().respond(204);
    await upload;
  }));

test("duplicate progress events do not conceal a stalled upload", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(100);
    const afterAdvance = timers.setCount;
    xhr().progress(100);
    assert.equal(timers.setCount, afterAdvance);

    timers.fire(STALL_MS);
    await assert.rejects(upload, /stalled/i);
  }));

test("silence after the body is sent is bounded by the response timer", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(1000);
    assert.deepEqual(timers.armed, [STALL_MS]);

    xhr().bodySent();
    // The store commits silently. A stall timer here would kill a healthy upload
    assert.deepEqual(timers.armed, [RESPONSE_MS]);

    timers.fire(RESPONSE_MS);
    await assert.rejects(upload, (err) => {
      assert.equal(err.kind, "network");
      return /timed out waiting for the object store/i.test(err.message);
    });
  }));

test("a slow but arriving response still succeeds, leaving no timer armed", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(1000);
    xhr().bodySent();
    xhr().respond(204);

    await upload;
    assert.deepEqual(timers.armed, []);
  }));

test("loadend fired by an abort does not arm the response timer", async () =>
  withMockXhr(async ({ start, xhr, goOffline }) => {
    const timers = fakeTimers();
    const upload = start(timers);

    xhr().progress(100);
    goOffline();
    xhr().bodySent(); // abort() fires loadend on the upload object too

    await assert.rejects(upload, /Connection lost/);
    assert.deepEqual(timers.armed, []);
  }));

test("an offline abort keeps its cause and clears the timers", async () =>
  withMockXhr(async ({ start, xhr, goOffline, listeners }) => {
    const timers = fakeTimers();
    const upload = start(timers);
    assert.ok(xhr().form, "the request was sent");

    goOffline();

    await assert.rejects(upload, (err) => {
      assert.equal(err.offline, true);
      assert.equal(err.kind, "network");
      return /Connection lost/.test(err.message);
    });
    assert.ok(xhr().aborted);
    assert.ok(!listeners.has("offline"));
    // Settled, so a stall timer can no longer fire and reject a second time
    assert.deepEqual(timers.armed, []);
  }));

test("control objects use XHR and the same progress-driven timers without a progress callback", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const fields = { policy: "signed-policy", "x-amz-signature": "signature" };
    const upload = start(timers, {
      key: "prefix/_MANIFEST.txt", contentType: "text/plain", onProgress: undefined,
      link: { endpoint: "https://example.test", bucket: "bucket", fields },
    });
    assert.deepEqual(timers.armed, [STALL_MS]);
    assert.equal(typeof xhr().upload.onprogress, "function");
    const entries = [...xhr().form.entries()];
    assert.deepEqual(entries.slice(0, -1), [
      ["key", "prefix/_MANIFEST.txt"], ...Object.entries(fields), ["Content-Type", "text/plain"],
    ]);
    assert.equal(entries.at(-1)[0], "file");
    xhr().progress(1000);
    xhr().bodySent();
    assert.deepEqual(timers.armed, [RESPONSE_MS]);
    xhr().respond(204);
    await upload;
    assert.deepEqual(timers.armed, []);
  }));

test("control-object HTTP errors retain their classification and clear timers", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers, { key: "prefix/_MANIFEST.txt", onProgress: undefined });
    xhr().responseText = "<Error><Code>AccessDenied</Code><Message>nope</Message></Error>";
    xhr().respond(403);
    await assert.rejects(upload, (err) => err.kind === "link" && err.name === "AccessDenied");
    assert.deepEqual(timers.armed, []);
  }));

test("a control-object response that stalls after headers is still bounded", async () =>
  withMockXhr(async ({ start, xhr }) => {
    const timers = fakeTimers();
    const upload = start(timers, { key: "prefix/_MANIFEST.txt", onProgress: undefined });
    xhr().bodySent();
    xhr().status = 503; // headers arrived, but onload waits for the complete body
    timers.fire(RESPONSE_MS);
    await assert.rejects(upload, (err) => err.kind === "network" && /timed out/.test(err.message));
    assert.ok(xhr().aborted);
    assert.deepEqual(timers.armed, []);
  }));

// --- Spool storage ------------------------------------------------------------

test("an aborted signal stops a retry wait and is never retried", async () => {
  const ctrl = new AbortController();
  let attempts = 0;
  const reason = new Error("sibling failed");
  const run = postObjectWithRetry({
    link: { endpoint: "e", bucket: "b", expiresAt: Date.now() + 60_000, fields: {} },
    key: "p/a",
    body: new Blob(["x"]),
    signal: ctrl.signal,
    sleepFn: () => new Promise(() => {}), // a long backoff, cut short only by the abort
    postOnce: async () => {
      attempts++;
      const err = new Error("reset");
      err.kind = "network";
      throw err;
    },
    onRetry: () => ctrl.abort(reason),
  });
  await assert.rejects(run, (err) => err === reason);
  assert.equal(attempts, 1);
});

test("postObject aborts an in-flight XHR when the run's signal aborts", async () => {
  const originalXhr = globalThis.XMLHttpRequest;
  let aborted = false;
  class MockXhr {
    constructor() {
      this.upload = {};
    }
    open() {}
    send() {}
    abort() {
      aborted = true;
      this.onabort?.();
    }
  }
  globalThis.XMLHttpRequest = MockXhr;
  try {
    const ctrl = new AbortController();
    const reason = new Error("sibling failed");
    const upload = postObject({
      link: { endpoint: "https://example.test", bucket: "bucket", fields: {} },
      key: "prefix/file",
      body: new Blob(["x"]),
      onProgress: () => {},
      signal: ctrl.signal,
    });
    ctrl.abort(reason);
    await assert.rejects(upload, (err) => err === reason);
    assert.equal(aborted, true);
  } finally {
    globalThis.XMLHttpRequest = originalXhr;
  }
});

// A File whose bytes vanished from disk after it was picked
class GoneFile extends Blob {
  slice() {
    return { arrayBuffer: () => Promise.reject(Object.assign(new Error("gone"), { name: "NotReadableError" })) };
  }
}

test("checkReadable passes a readable body and flags a vanished one as an input problem", async () => {
  await checkReadable(new Blob(["x"]));
  await checkReadable("not a blob");
  await assert.rejects(checkReadable(new GoneFile(["x"])), (err) => err.kind === "input" && /moved, changed or deleted/.test(err.message));
});

test("a file that became unreadable is not retried forever", async () => {
  let attempts = 0;
  await assert.rejects(
    postObjectWithRetry({
      link: { endpoint: "e", bucket: "b", expiresAt: Date.now() + 60_000, fields: {} },
      key: "p/a",
      body: new GoneFile(["x"]),
      sleepFn: async () => {},
      postOnce: async () => {
        attempts++;
        throw Object.assign(new Error("Can't reach the object store from this page."), { kind: "network" });
      },
    }),
    (err) => err.kind === "input"
  );
  assert.equal(attempts, 1);
});

// A File whose disk stopped answering
class HungFile extends Blob {
  slice() {
    return { arrayBuffer: () => new Promise(() => {}) };
  }
}

test("checkReadable gives up on a read that hangs, as an input problem", async () => {
  let fire;
  let cleared = 0;
  const check = checkReadable(new HungFile(["x"]), {
    setTimerFn: (fn) => ((fire = fn), 1),
    clearTimerFn: () => cleared++,
  });
  fire();
  await assert.rejects(check, (err) => err.kind === "input" && /stopped responding/.test(err.message));
  assert.equal(cleared, 1);
});

test("checkReadable leaves no timer behind once the byte is read", async () => {
  let cleared = 0;
  await checkReadable(new Blob(["x"]), { setTimerFn: () => 7, clearTimerFn: (t) => (cleared += t === 7) });
  assert.equal(cleared, 1);
});

test("link expiry ends a hung readability check and clears both wait timers", async () => {
  const timers = fakeTimers();
  let now = 0;
  let attempts = 0;
  const run = postObjectWithRetry({
    link: { expiresAt: 2500 }, body: new HungFile(["x"]), nowFn: () => now,
    setTimerFn: timers.setTimerFn, clearTimerFn: timers.clearTimerFn,
    postOnce: async () => { attempts++; throw Object.assign(new Error("offline"), { kind: "network" }); },
  });
  await new Promise(setImmediate);
  assert.deepEqual(timers.armed, [READ_CHECK_MS, 2500]);
  now = 2500;
  timers.fire(2500);
  await assert.rejects(run, (err) => err.kind === "link");
  assert.deepEqual(timers.armed, []);
  assert.equal(attempts, 1);
});

test("Cancel clears a hung readability check's timer too", async () => {
  const timers = fakeTimers();
  const ctrl = new AbortController();
  const run = postObjectWithRetry({
    link: { expiresAt: Date.now() + 60_000 }, body: new HungFile(["x"]), signal: ctrl.signal,
    setTimerFn: timers.setTimerFn, clearTimerFn: timers.clearTimerFn,
    postOnce: async () => { throw Object.assign(new Error("offline"), { kind: "network" }); },
  });
  await new Promise(setImmediate);
  assert.ok(timers.armed.includes(READ_CHECK_MS));
  const reason = new Error("Cancelled during read");
  ctrl.abort(reason);
  await assert.rejects(run, (err) => err === reason);
  assert.deepEqual(timers.armed, []);
});
