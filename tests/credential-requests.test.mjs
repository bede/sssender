import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { makeCredentialUploader, withRequestTimeout } from "../core/uploaders.js";
import { S3Client, Upload } from "../vendor/aws-sdk.js";

const TIMEOUT = 1234;

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimerFn(fn) {
      const id = ++seq;
      pending.set(id, fn);
      return id;
    },
    clearTimerFn(id) {
      pending.delete(id);
    },
    fire() {
      const [id, fn] = pending.entries().next().value ?? [];
      assert.ok(fn, "a request timer must be armed");
      pending.delete(id);
      fn();
    },
    get size() {
      return pending.size;
    },
  };
}

// Fetches stay active until answered or actually aborted by their Request signal
function controlledFetch(t) {
  const calls = [];
  const active = new Set();
  const waiting = [];
  t.mock.method(globalThis, "fetch", (request) => new Promise((resolve, reject) => {
    let body = null;
    const finish = (fn, result) => {
      active.delete(call);
      request.signal.removeEventListener("abort", onAbort);
      fn(result);
    };
    const fail = (err) => finish(body ? (reason) => body.error(reason) : reject, err);
    const onAbort = () => fail(request.signal.reason);
    const call = {
      request,
      respond: () => finish(resolve, new Response(null, { headers: { etag: '"part-etag"' } })),
      fail,
      respondStreaming(status) {
        resolve(new Response(new ReadableStream({ start(controller) { body = controller; } }), { status }));
        return () => finish(() => body.close());
      },
    };
    calls.push(call);
    active.add(call);
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    for (const wait of waiting) if (calls.length >= wait.n) wait.resolve();
  }));
  t.after(() => {
    for (const call of active) call.fail(new DOMException("Test cleanup", "AbortError"));
  });
  return {
    calls,
    active,
    count(n) {
      return calls.length >= n ? Promise.resolve() : new Promise((resolve) => waiting.push({ n, resolve }));
    },
  };
}

async function fixture(t, { signal, multipart = false } = {}) {
  const fetches = controlledFetch(t);
  const timers = fakeTimers();
  const retries = [];
  // Node lacks DOMParser. Stub only XML-based multipart setup/finalisation;
  // lib-storage's part scheduling, SDK signing, retries and HTTP handler are real
  class Client extends S3Client {
    send(command, ...options) {
      switch (command.constructor.name) {
        case "CreateMultipartUploadCommand": return Promise.resolve({ UploadId: "upload-id" });
        case "CompleteMultipartUploadCommand": return Promise.resolve({});
        case "AbortMultipartUploadCommand": return Promise.resolve({});
        default: return super.send(command, ...options);
      }
    }
  }
  const uploader = makeCredentialUploader({
    endpoint: "https://example.test",
    bucket: "bucket",
    region: "us-east-1",
    accessKeyId: "a",
    secretAccessKey: "s",
    partSize: 5 * 1024 * 1024,
    queueSize: 2,
    requestTimeoutMs: TIMEOUT,
    setTimerFn: timers.setTimerFn,
    clearTimerFn: timers.clearTimerFn,
    retryOptions: { onlineFn: () => true, sleepFn: async () => {} },
    loadSdk: async () => ({ S3Client: Client, Upload }),
  });
  await uploader.preflight("p");
  const body = new Uint8Array(multipart ? 11 * 1024 * 1024 : 8);
  const run = uploader.uploadGroup({ keys: ["p/file"], files: [body] }, [{ body }], {
    signal,
    onUploadRetry: (info) => retries.push(info),
  });
  // Attach the rejection handler before triggering Cancel or a timeout
  const result = run.then((keys) => ({ keys }), (error) => ({ error }));
  return { ...fetches, timers, retries, result };
}

test("a timed-out SDK part is aborted before retry, without aborting its sibling", { timeout: 5000 }, async (t) => {
  const ctrl = new AbortController();
  const f = await fixture(t, { signal: ctrl.signal, multipart: true });
  await f.count(2);
  const [first, sibling] = f.calls;
  f.timers.fire();
  assert.ok(first.request.signal.aborted);
  assert.ok(!sibling.request.signal.aborted);
  assert.ok(!ctrl.signal.aborted);
  assert.equal(f.active.size, 1);

  await f.count(3);
  const retry = f.calls[2];
  assert.equal(new URL(retry.request.url).searchParams.get("partNumber"),
    new URL(first.request.url).searchParams.get("partNumber"));
  assert.notEqual(retry.request.signal, first.request.signal);
  assert.ok(!retry.request.signal.aborted);
  assert.equal(f.active.size, 2);
  assert.equal(f.retries.length, 1);
  assert.equal(f.retries[0].error.name, "TimeoutError");
  assert.equal(f.retries[0].error.kind, "network");

  sibling.respond();
  retry.respond();
  await f.count(4); // the last part can start once a worker becomes free
  f.calls[3].respond();
  assert.deepEqual(await f.result, { keys: ["p/file"] });
  assert.equal(f.active.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
});

test("Cancel aborts every active SDK part and leaves no background uploads or retries", { timeout: 5000 }, async (t) => {
  const ctrl = new AbortController();
  const f = await fixture(t, { signal: ctrl.signal, multipart: true });
  await f.count(2);
  const reason = new DOMException("Cancelled", "AbortError");
  ctrl.abort(reason);
  assert.equal(f.active.size, 0);
  assert.ok(f.calls.every(({ request }) => request.signal.aborted));
  assert.equal((await f.result).error, reason);
  await new Promise(setImmediate); // allow lib-storage's other workers to settle
  assert.equal(f.calls.length, 2, "neither the third part nor retries may start");
  assert.equal(f.retries.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
});

for (const order of ["timeout first", "Cancel first"]) {
  test(`Cancel wins when timeout and Cancel coincide: ${order}`, { timeout: 5000 }, async (t) => {
    const ctrl = new AbortController();
    const f = await fixture(t, { signal: ctrl.signal });
    await f.count(1);
    const reason = new Error("Cancelled by caller");
    if (order === "timeout first") f.timers.fire();
    ctrl.abort(reason);
    if (order === "Cancel first") f.timers.fire();
    assert.equal((await f.result).error, reason);
    assert.equal(f.active.size, 0);
    assert.equal(f.retries.length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.size, 0);
  });
}

test("the SDK timeout covers a stalled error response body, then retries", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.count(1);
  f.calls[0].respondStreaming(503);
  await new Promise(setImmediate);
  assert.equal(f.timers.size, 1, "receiving headers must not clear the timer");
  f.timers.fire();
  assert.ok(f.calls[0].request.signal.aborted);
  assert.equal(f.active.size, 0);
  await f.count(2);
  assert.equal(f.retries[0].error.name, "TimeoutError");
  f.calls[1].respond();
  assert.deepEqual(await f.result, { keys: ["p/file"] });
  assert.equal(f.timers.size, 0);
});

test("Cancel aborts an SDK response body after its headers arrive", { timeout: 5000 }, async (t) => {
  const ctrl = new AbortController();
  const f = await fixture(t, { signal: ctrl.signal });
  await f.count(1);
  f.calls[0].respondStreaming(503);
  await new Promise(setImmediate);
  const reason = new DOMException("Cancelled", "AbortError");
  ctrl.abort(reason);
  assert.equal((await f.result).error, reason);
  assert.ok(f.calls[0].request.signal.aborted);
  assert.equal(f.active.size, 0);
  assert.equal(f.retries.length, 0);
  assert.equal(f.timers.size, 0);
});

test("successful SDK replies finish buffering and clear their timer and Cancel listener", { timeout: 5000 }, async (t) => {
  const ctrl = new AbortController();
  const f = await fixture(t, { signal: ctrl.signal });
  await f.count(1);
  const finish = f.calls[0].respondStreaming(200);
  await new Promise(setImmediate);
  assert.equal(f.timers.size, 1);
  finish();
  assert.deepEqual(await f.result, { keys: ["p/file"] });
  assert.equal(f.timers.size, 0);
  assert.equal(f.active.size, 0);
  assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
  ctrl.abort();
  assert.ok(!f.calls[0].request.signal.aborted, "completed requests have no remaining Cancel listener");
});

test("the wrapper forwards an SDK-provided abort signal to the real HTTP handler", { timeout: 5000 }, async (t) => {
  const f = controlledFetch(t);
  const timers = fakeTimers();
  const ctrl = new AbortController();
  const sdkCtrl = new AbortController();
  const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "a", secretAccessKey: "s" } });
  const handler = withRequestTimeout(client.config.requestHandler, { signal: ctrl.signal, ...timers });
  const result = handler.handle({
    protocol: "https:", hostname: "example.test", path: "/bucket/key", method: "PUT", headers: {}, body: new Uint8Array(8),
  }, { abortSignal: sdkCtrl.signal }).catch((err) => err);
  await f.count(1);
  const reason = new DOMException("SDK cancelled", "AbortError");
  sdkCtrl.abort(reason);
  assert.equal(await result, reason);
  assert.equal(f.active.size, 0);
  assert.ok(f.calls[0].request.signal.aborted);
  assert.ok(!ctrl.signal.aborted);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
  assert.equal(getEventListeners(sdkCtrl.signal, "abort").length, 0);
});

test("the wrapper preserves handler methods and disables the SDK timer even for send overrides", async () => {
  const timers = fakeTimers();
  const ctrl = new AbortController();
  const sdkCtrl = new AbortController();
  const response = {};
  const request = {};
  const configs = {};
  let destroyed = false;
  const original = {
    metadata: { handlerProtocol: "http/1.1" },
    updateHttpClientConfig(key, value) {
      assert.equal(this, original);
      configs[key] = value;
    },
    httpHandlerConfigs() {
      assert.equal(this, original);
      return configs;
    },
    destroy() {
      assert.equal(this, original);
      destroyed = true;
    },
    async handle(req, options) {
      assert.equal(this, original);
      assert.equal(req, request);
      assert.equal(options.requestTimeout, 0);
      assert.equal(options.extraOption, "kept");
      assert.ok(options.abortSignal instanceof AbortSignal);
      return response;
    },
  };
  const handler = withRequestTimeout(original, { signal: ctrl.signal, ...timers });
  assert.equal(handler.metadata, original.metadata);
  handler.updateHttpClientConfig("requestTimeout", 999);
  assert.equal(handler.httpHandlerConfigs(), configs);
  assert.equal(configs.requestTimeout, 999);
  assert.equal(await handler.handle(request, { requestTimeout: 1, abortSignal: sdkCtrl.signal, extraOption: "kept" }), response);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
  assert.equal(getEventListeners(sdkCtrl.signal, "abort").length, 0);
  handler.destroy();
  assert.ok(destroyed);
});

test("an already-cancelled request never reaches the handler or arms a timer", async () => {
  const timers = fakeTimers();
  const ctrl = new AbortController();
  const reason = new Error("Already cancelled");
  ctrl.abort(reason);
  const original = { handle: () => assert.fail("must not send") };
  await assert.rejects(withRequestTimeout(original, { signal: ctrl.signal, ...timers }).handle({}), (err) => err === reason);
  await assert.rejects(withRequestTimeout(original, timers).handle({}, { abortSignal: ctrl.signal }), (err) => err === reason);
  assert.equal(timers.size, 0);
});

test("a failed handler also clears its timer and listeners", async () => {
  const timers = fakeTimers();
  const ctrl = new AbortController();
  const reason = new Error("Permanent failure");
  const handler = withRequestTimeout({ handle() { throw reason; } }, { signal: ctrl.signal, ...timers });
  await assert.rejects(handler.handle({}), (err) => err === reason);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
});
