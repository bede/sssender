import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { makeLinkUploader, makeCredentialUploader, normaliseEndpoint, patientRetryStrategy } = await import(
  `${pathToFileURL(resolve(here, "../core/uploaders.js"))}?test=${Date.now()}`
);

class FakeS3Client {
  constructor() {
    this.config = { requestHandler: {} };
  }
}

test("link upload checks combined spool capacity before pulling either output", async () => {
  const events = [];
  const posts = [];
  const released = [];
  const uploader = makeLinkUploader({
    link: {
      endpoint: "https://example.test",
      bucket: "bucket",
      maxBytes: 1000,
      expiresAt: Date.now() + 60_000,
      fields: {},
    },
    onStatus: () => {},
    prepareSpoolFn: async (bytes) => events.push(["prepare", bytes]),
    spoolDir: "app-spool",
    spoolNameFn: (_n, part) => `${part}.bin`,
    spoolToFileFn: async (_stream, name, opts) => {
      events.push(["spool", name, opts.expectedBytes, opts.dir]);
      return new Blob([name]);
    },
    releaseSpoolFn: async (name, opts) => released.push([name, opts.dir]),
    postWithRetryFn: async (args) => posts.push(args.key),
  });

  const keys = await uploader.uploadGroup(
    {
      keys: ["prefix/r1.fastq.gz", "prefix/r2.fastq.gz"],
      files: [{ size: 100 }, { size: 200 }],
    },
    [{ stream: {} }, { stream: {} }],
    { onUploadStart: () => {}, onUploadProgress: () => {} }
  );

  assert.deepEqual(events, [
    ["prepare", 300],
    ["spool", "1.bin", 100, "app-spool"],
    ["spool", "2.bin", 200, "app-spool"],
  ]);
  assert.deepEqual(posts, ["prefix/r1.fastq.gz", "prefix/r2.fastq.gz"]);
  assert.deepEqual(keys, posts);
  assert.deepEqual(released, [["1.bin", "app-spool"], ["2.bin", "app-spool"]]);
});

test("link upload posts whole Blobs directly, with no spool", async () => {
  const posts = [];
  const started = [];
  const fail = (what) => async () => assert.fail(`${what} must not be called for raw bodies`);
  const uploader = makeLinkUploader({
    link: {
      endpoint: "https://example.test",
      bucket: "bucket",
      maxBytes: 1000,
      expiresAt: Date.now() + 60_000,
      fields: { policy: "p" },
    },
    onStatus: () => {},
    prepareSpoolFn: fail("prepareSpool"),
    spoolToFileFn: fail("spoolToFile"),
    releaseSpoolFn: fail("releaseSpool"),
    postWithRetryFn: async (args) => posts.push([args.key, args.body, args.link.fields]),
  });

  const r1 = new Blob(["@r1\n"]);
  const r2 = new Blob(["@r2\n"]);
  const keys = await uploader.uploadGroup(
    { keys: ["p/r1.fastq", "p/r2.fastq"], files: [r1, r2] },
    [{ body: r1 }, { body: r2 }],
    { onUploadStart: (n) => started.push(n), onUploadProgress: () => {} }
  );

  assert.deepEqual(keys, ["p/r1.fastq", "p/r2.fastq"]);
  assert.equal(posts[0][1], r1);
  assert.equal(posts[1][1], r2);
  assert.equal(posts[0][2].policy, "p"); // fields go through verbatim
  assert.deepEqual(started, [r1.size + r2.size]);
});

test("link upload enforces the per-file cap on a whole Blob's exact size", async () => {
  const uploader = makeLinkUploader({
    link: { endpoint: "e", bucket: "b", maxBytes: 3, expiresAt: Date.now() + 60_000, fields: {} },
    postWithRetryFn: async () => assert.fail("must not post an oversize body"),
  });
  const body = new Blob(["@toolong\n"]);
  await assert.rejects(
    uploader.uploadGroup(
      { keys: ["p/a.fastq"], files: [body] },
      [{ body }],
      { onUploadStart: () => {}, onUploadProgress: () => {} }
    ),
    (err) => err.kind === "size" && /^a\.fastq is 9B/.test(err.message)
  );
});

test("credential upload sends a whole Blob as the multipart Body", async () => {
  const sent = [];
  class Upload {
    constructor({ params }) {
      this.params = params;
    }
    on() {}
    async done() {
      sent.push([this.params.Key, this.params.Body]);
    }
  }
  const uploader = makeCredentialUploader({
    accessKeyId: "a",
    secretAccessKey: "s",
    bucket: "b",
    endpoint: "e",
    region: "r",
    loadSdk: async () => ({ Upload, S3Client: FakeS3Client }),
  });
  await uploader.preflight("p");
  const body = new Blob(["@r\n"]);
  const started = [];
  await uploader.uploadGroup(
    { keys: ["p/a.fastq"], files: [body] },
    [{ body }],
    { onUploadStart: (n) => started.push(n), onUploadProgress: () => {} }
  );
  assert.deepEqual(sent.at(-1), ["p/a.fastq", body]);
  assert.deepEqual(started, [body.size]);
});

test("a server address without a scheme gets https://", () => {
  assert.equal(normaliseEndpoint("s3.climb.ac.uk"), "https://s3.climb.ac.uk");
  assert.equal(normaliseEndpoint(" https://s3.climb.ac.uk/ "), "https://s3.climb.ac.uk");
  assert.equal(normaliseEndpoint("http://localhost:9000"), "http://localhost:9000");
  assert.equal(normaliseEndpoint("https://"), ""); // the untouched prefill
  assert.equal(normaliseEndpoint(""), "");
});

function failingCredentialUploader(error) {
  class Upload {
    on() {}
    async done() {
      throw error;
    }
  }
  return makeCredentialUploader({
    accessKeyId: "a",
    secretAccessKey: "s",
    bucket: "b",
    endpoint: "https://e",
    loadSdk: async () => ({ Upload, S3Client: FakeS3Client }),
  });
}

// Bad keys show on the first write (_CLIENT.json)
async function putOne(uploader) {
  await uploader.preflight("p");
  return uploader.putSmall("p/_CLIENT.json", new Blob(["{}"]), "application/json");
}

test("a 403 on the first write is a credentials error", async () => {
  const err = Object.assign(new Error("Access Denied"), { $metadata: { httpStatusCode: 403 } });
  await assert.rejects(putOne(failingCredentialUploader(err)), (e) => e.kind === "credentials");
});

test("credential upload errors are classified for the pipeline", async () => {
  const cases = [
    [Object.assign(new Error("Service Unavailable"), { $metadata: { httpStatusCode: 503 } }), "network"],
    [new TypeError("Failed to fetch"), "network"],
    [Object.assign(new Error("gone"), { name: "NotReadableError" }), "input"],
    [Object.assign(new Error("bad"), { $metadata: { httpStatusCode: 400 } }), undefined],
    [Object.assign(new Error("corrupt gzip"), { kind: "input" }), "input"], // a transform's own kind survives
  ];
  for (const [error, kind] of cases) {
    await assert.rejects(putOne(failingCredentialUploader(error)), (e) => e === error && e.kind === kind);
  }
});

test("other first-write failures keep their own cause", async () => {
  const err = new TypeError("Invalid URL");
  await assert.rejects(putOne(failingCredentialUploader(err)), (e) => e === err && e.kind === undefined);
});

test("credential upload aborts its multipart uploads when the run is stopped", async () => {
  const aborted = [];
  class Upload {
    constructor({ params }) {
      this.key = params.Key;
    }
    on() {}
    done() {
      return new Promise((_, reject) => (this.reject = reject));
    }
    async abort() {
      aborted.push(this.key);
      this.reject(new Error("Upload aborted."));
    }
  }
  const uploader = makeCredentialUploader({
    accessKeyId: "a",
    secretAccessKey: "s",
    bucket: "b",
    endpoint: "e",
    loadSdk: async () => ({ Upload, S3Client: FakeS3Client }),
  });
  await uploader.preflight("p");
  const ctrl = new AbortController();
  const run = uploader.uploadGroup(
    { keys: ["p/a", "p/b"], files: [new Blob(["a"]), new Blob(["b"])] },
    [{ body: new Blob(["a"]) }, { body: new Blob(["b"]) }],
    { signal: ctrl.signal }
  );
  const reason = new Error("sibling failed");
  ctrl.abort(reason);
  await assert.rejects(run, (err) => err === reason);
  assert.deepEqual(aborted.sort(), ["p/a", "p/b"]);
  assert.equal(uploader.concurrency, 2);
});

test("link upload passes the run's signal to every POST and reports retries", async () => {
  const seen = [];
  const retries = [];
  const uploader = makeLinkUploader({
    link: { endpoint: "e", bucket: "b", maxBytes: 100, expiresAt: Date.now() + 60_000, fields: {} },
    postWithRetryFn: async (args) => {
      seen.push(args.signal);
      args.onRetry({ attempt: 1, waitMs: 1000 });
    },
  });
  const ctrl = new AbortController();
  const body = new Blob(["x"]);
  await uploader.uploadGroup({ keys: ["p/a"], files: [body] }, [{ body }], {
    signal: ctrl.signal,
    onUploadRetry: (info) => retries.push(info.attempt),
  });
  assert.deepEqual(seen, [ctrl.signal]);
  assert.deepEqual(retries, [1]);
});

const netErr = () => Object.assign(new TypeError("Failed to fetch"));

test("credential retries never give up on a connection problem, and resend the request", async () => {
  const infos = [];
  const sleeps = [];
  let calls = 0;
  const strategy = patientRetryStrategy({
    onRetry: (info) => infos.push(info.resumed ? ["resumed", info.attempt] : ["retry", info.attempt, info.error.kind]),
    onlineFn: () => true,
    sleepFn: async (ms) => sleeps.push(ms),
  });
  const out = await strategy.retry(async () => {
    if (++calls < 6) throw calls % 2 ? netErr() : Object.assign(new Error("Slow Down"), { $metadata: { httpStatusCode: 503 } });
    return { output: "ok" };
  }, { request: { body: new Uint8Array(8) } });
  assert.deepEqual(out, { output: "ok" });
  assert.equal(calls, 6);
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000]); // backoff, capped at a minute
  assert.deepEqual(infos.slice(0, 2), [["retry", 1, "network"], ["retry", 2, "network"]]);
});

test("credential retries wait for the browser to come back online", async () => {
  let online = true;
  const waits = [];
  const strategy = patientRetryStrategy({
    onRetry: (info) => waits.push(info.resumed ? "resumed" : info.waitingOnline),
    onlineFn: () => online,
    sleepFn: () => new Promise(() => {}), // no backoff: it waits for `online` instead
    waitOnlineFn: async () => {
      online = true;
    },
  });
  let calls = 0;
  await strategy.retry(async () => {
    if (++calls === 1) {
      online = false; // the connection dropped mid-request
      throw netErr();
    }
    return {};
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [true, "resumed"]);
});

test("credential retries stop at once for anything but a connection problem", async () => {
  for (const err of [
    Object.assign(new Error("Access Denied"), { $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error("bad"), { $metadata: { httpStatusCode: 400 } }),
  ]) {
    let calls = 0;
    const strategy = patientRetryStrategy({ sleepFn: async () => {} });
    await assert.rejects(strategy.retry(async () => (calls++, Promise.reject(err))), (e) => e === err);
    assert.equal(calls, 1);
  }
  // A streamed body can't be sent twice
  let calls = 0;
  const strategy = patientRetryStrategy({ sleepFn: async () => {} });
  await assert.rejects(strategy.retry(async () => (calls++, Promise.reject(netErr())), { request: { body: new ReadableStream() } }));
  assert.equal(calls, 1);
});

test("cancelling ends a credential retry wait", async () => {
  const ctrl = new AbortController();
  const reason = new Error("cancelled");
  const strategy = patientRetryStrategy({
    signal: ctrl.signal,
    onlineFn: () => true,
    sleepFn: () => new Promise(() => {}),
    onRetry: () => ctrl.abort(reason),
  });
  await assert.rejects(strategy.retry(async () => Promise.reject(netErr())), (e) => e === reason);
});


// --- First contact ----------------------------------------------------------
const LINK = { endpoint: "https://e", bucket: "b", maxBytes: 100, expiresAt: Date.now() + 3_600_000, fields: {} };

function firstContactUploader({ results, elapsedMs = 0, online = () => true, waitOnlineFn = async () => {} }) {
  let now = Date.now();
  const calls = [];
  const sleeps = [];
  const uploader = makeLinkUploader({
    link: LINK,
    postOnceFn: async (args) => {
      calls.push(args);
      now += elapsedMs;
      const r = results.shift();
      if (r instanceof Error) throw r;
    },
    postWithRetryFn: async () => assert.fail("the first write is never retried by the POST loop"),
    waits: { nowFn: () => now, onlineFn: online, sleepFn: async (ms) => sleeps.push(ms), waitOnlineFn },
  });
  const first = () => uploader.putSmall("p/_CLIENT.json", new Blob(["{}"]), "application/json", { first: true });
  return { uploader, calls, sleeps, first };
}
const refused = () => Object.assign(new TypeError("Failed to fetch"), { kind: "network" });

test("a first write that fails at once, twice, means the store can't be reached from here", async () => {
  const { calls, sleeps, first } = firstContactUploader({ results: [refused(), refused()] });
  await assert.rejects(first(), (err) => err.kind === "unreachable" && /Ask whoever sent the link/.test(err.message));
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [3000]); // one more try a few seconds later, for a blip
});

test("a blip on the first write is forgiven once", async () => {
  const { calls, first } = firstContactUploader({ results: [refused(), undefined] });
  await first();
  assert.equal(calls.length, 2);
});

test("a slow first-write failure is the connection, and is retried like any other", async () => {
  const { calls, first } = firstContactUploader({ results: [refused(), refused(), refused(), undefined], elapsedMs: 30_000 });
  await first();
  assert.equal(calls.length, 4);
});

test("an answer from the store on the first write is final", async () => {
  const denied = Object.assign(new Error("Policy expired"), { kind: "link" });
  const { calls, first } = firstContactUploader({ results: [denied] });
  await assert.rejects(first(), (err) => err === denied);
  assert.equal(calls.length, 1);
});

test("a first write that fails because the browser went offline waits for it", async () => {
  let online = true;
  let calls = 0;
  const waited = [];
  const uploader = makeLinkUploader({
    link: LINK,
    postOnceFn: async () => {
      // First two attempts lose the connection
      if (++calls <= 2) {
        online = false;
        throw refused();
      }
    },
    waits: {
      onlineFn: () => online,
      sleepFn: () => new Promise(() => {}), // never a timed retry: only the online wait
      waitOnlineFn: async () => (waited.push(calls), (online = true)),
    },
  });
  await uploader.putSmall("p/_CLIENT.json", new Blob(["{}"]), "application/json", { first: true });
  assert.equal(calls, 3); // never "unreachable": twice offline, then through
  assert.deepEqual(waited, [1, 2]);
});

test("credential mode says what to check itself", async () => {
  class Upload {
    on() {}
    async done() {
      throw new TypeError("Failed to fetch");
    }
  }
  const uploader = makeCredentialUploader({
    accessKeyId: "a",
    secretAccessKey: "s",
    bucket: "b",
    endpoint: "https://e",
    loadSdk: async () => ({ Upload, S3Client: FakeS3Client }),
    waits: { sleepFn: async () => {}, onlineFn: () => true },
  });
  await uploader.preflight("p");
  await assert.rejects(
    uploader.putSmall("p/_CLIENT.json", new Blob(["{}"]), "application/json", { first: true }),
    (err) => err.kind === "unreachable" && /Check the server address/.test(err.message)
  );
});

test("first contact's retry wait is clipped to the link's expiry", async () => {
  let now = 0;
  let attempts = 0;
  const sleeps = [];
  const uploader = makeLinkUploader({
    link: { ...LINK, expiresAt: 25_000 },
    postOnceFn: async () => { attempts++; now = 24_900; throw refused(); },
    waits: {
      nowFn: () => now, onlineFn: () => true,
      sleepFn: async (ms) => { sleeps.push(ms); now += ms; },
    },
  });
  await assert.rejects(uploader.putSmall("p/_CLIENT.json", new Blob(["{}"]), "application/json", { first: true }),
    (err) => err.kind === "link");
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, [100]);
});
