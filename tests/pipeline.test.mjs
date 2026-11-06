import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { buildUploadItems, clientEnvironment, clientRecord, findOversizeFiles, rawTransform, runUpload } =
  await import(`${pathToFileURL(resolve(here, "../core/pipeline.js"))}?test=${Date.now()}`);

const file = (path, text = "@r\nACGT\n+\nIIII\n") => {
  const f = new File([text], path.split("/").pop());
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
};
const group = (...files) => ({
  label: files.map((f) => f.webkitRelativePath).join(" & "),
  size: files.reduce((n, f) => n + f.size, 0),
  files,
});

// Records calls in order
function fakeUploader({ failOn, failKind, concurrency, gate } = {}) {
  const calls = [];
  return {
    calls,
    concurrency,
    access: { mode: "test", access_key_id: "AKIAFAKE" },
    async preflight(keyBase) {
      calls.push(["preflight", keyBase]);
    },
    async uploadGroup(item, outputs, hooks) {
      calls.push(["start", item.keys]);
      if (gate) await gate(item, hooks);
      if (failOn === item.keys[0]) throw Object.assign(new Error("boom"), failKind && { kind: failKind });
      hooks.onUploadStart(item.size);
      hooks.onUploadProgress(item.size);
      calls.push(["group", item.keys, outputs]);
      return item.keys;
    },
    async putSmall(key, body) {
      calls.push(["small", key, await body.text()]);
    },
  };
}

test("runUpload follows the protocol: preflight, groups, extras, manifest last", async () => {
  const uploader = fakeUploader();
  const transform = {
    name: "t",
    outputName: (p) => p + ".out",
    start: (g) => g.files.map(() => ({ stream: "s" })),
    extras: (item) => [{ key: `${item.keys[0]}.json`, body: new Blob(["{}"]), contentType: "application/json" }],
  };
  const { keys } = await runUpload({
    groups: [group(file("d/a.fastq"))],
    keyBase: "p/run",
    uploader,
    transform,
  });
  assert.deepEqual(
    uploader.calls.filter((c) => c[0] !== "start").map((c) => [c[0], c[1]]),
    [
      ["preflight", "p/run"],
      ["small", "p/run/_CLIENT.json"],
      ["group", ["p/run/d/a.fastq.out"]],
      ["small", "p/run/d/a.fastq.out.json"],
      ["small", "p/run/_MANIFEST.txt"],
    ]
  );
  assert.deepEqual(keys, ["p/run/_CLIENT.json", "p/run/d/a.fastq.out", "p/run/d/a.fastq.out.json"]);
  assert.equal(uploader.calls.at(-1)[2], keys.join("\n") + "\n");
});

test("raw uploads hand over the input files untouched, under their own names", async () => {
  const uploader = fakeUploader();
  const a = file("s_1.txt");
  const b = file("s_2.txt");
  await runUpload({ groups: [group(a, b)], keyBase: "p/run", uploader, transform: rawTransform });
  const [, keys, outputs] = uploader.calls.find((c) => c[0] === "group");
  assert.deepEqual(keys, ["p/run/s_1.txt", "p/run/s_2.txt"]);
  assert.equal(outputs[0].body, a);
  assert.equal(outputs[1].body, b);
  // No extras: just _CLIENT.json and the manifest
  assert.deepEqual(uploader.calls.filter((c) => c[0] === "small").map((c) => c[1]), [
    "p/run/_CLIENT.json",
    "p/run/_MANIFEST.txt",
  ]);
});

test("a fatal failure names the failed group and skips the manifest", async () => {
  const uploader = fakeUploader({ failOn: "p/run/b.fastq", failKind: "link" });
  const hooksSeen = [];
  await assert.rejects(
    runUpload({
      groups: [group(file("a.fastq")), group(file("b.fastq"))],
      keyBase: "p/run",
      uploader,
      transform: rawTransform,
      hooks: { onGroupDone: (i) => hooksSeen.push(i) },
    }),
    (err) => err.groupIndex === 1
  );
  assert.deepEqual(hooksSeen, [0]);
  assert.ok(!uploader.calls.some((c) => c[1] === "p/run/_MANIFEST.txt"));
});

test("a group that fails on its own is skipped, recorded in _FAILED.txt, and the rest finish", async () => {
  const uploader = fakeUploader({ failOn: "p/run/b_1.fq" });
  const seen = [];
  const { keys, failed } = await runUpload({
    groups: [group(file("a.fq")), group(file("b_1.fq"), file("b_2.fq")), group(file("c.fq"))],
    keyBase: "p/run",
    uploader,
    transform: rawTransform,
    hooks: {
      onGroupDone: (i) => seen.push(["done", i]),
      onGroupFailed: (i, _item, err) => seen.push(["failed", i, err.message]),
    },
  });
  assert.deepEqual(seen, [["done", 0], ["failed", 1, "boom"], ["done", 2]]);
  assert.deepEqual(failed.map((f) => [f.index, f.error.message]), [[1, "boom"]]);
  const small = uploader.calls.filter((c) => c[0] === "small");
  // Both files of the failed pair named, manifest still last
  assert.deepEqual(small.map((c) => c[1]), ["p/run/_CLIENT.json", "p/run/_FAILED.txt", "p/run/_MANIFEST.txt"]);
  assert.equal(small[1][2], "b_1.fq\tboom\nb_2.fq\tboom\n");
  assert.deepEqual(keys, ["p/run/_CLIENT.json", "p/run/a.fq", "p/run/c.fq", "p/run/_FAILED.txt"]);
  assert.equal(small[2][2], keys.join("\n") + "\n");
});

test("a group failing on its own stops its other outputs, and nobody else's", async () => {
  const signals = [];
  const uploader = {
    async preflight() {},
    async putSmall() {},
    uploadGroup(item, _outputs, hooks) {
      signals.push(hooks.signal);
      if (item.keys[0] === "p/ok.txt") return Promise.resolve(item.keys);
      const hang = new Promise((_, reject) => hooks.signal.addEventListener("abort", () => reject(hooks.signal.reason)));
      const bad = Promise.reject(Object.assign(new Error("corrupt"), { kind: "input" }));
      return Promise.all([bad, hang]).then(() => item.keys);
    },
  };
  const { failed } = await runUpload({
    groups: [group(file("pair_1.txt"), file("pair_2.txt")), group(file("ok.txt"))],
    keyBase: "p",
    uploader,
    transform: rawTransform,
    concurrency: 2,
  });
  assert.equal(failed.length, 1);
  assert.equal(signals[0].aborted, true); // the pair's mate was stopped
  assert.equal(signals[1].aborted, false);
});

test("runUpload reports progress per group through its hooks", async () => {
  const events = [];
  await runUpload({
    groups: [group(file("a.fastq"))],
    keyBase: "p",
    uploader: fakeUploader(),
    transform: {
      name: "t",
      outputName: (p) => p,
      start: (_g, hooks) => {
        hooks.onProgress({ bytesProcessed: 3 });
        hooks.onStats({ readsIn: 1 }, "0.5");
        return [{ stream: "s" }];
      },
    },
    hooks: {
      onGroupStart: (i) => events.push(["start", i]),
      onTransformProgress: (i, m) => events.push(["progress", i, m.bytesProcessed]),
      onUploadStart: (i, n) => events.push(["upload", i, n > 0]),
      onGroupDone: (i, _item, result) => events.push(["done", i, result.stats.readsIn, result.elapsed]),
      onFinalising: () => events.push(["finalising"]),
    },
  });
  assert.deepEqual(events, [
    ["start", 0],
    ["progress", 0, 3],
    ["upload", 0, true],
    ["done", 0, 1, 0.5],
    ["finalising"],
  ]);
});

// Holds groups until released, to count how many run at once
function gated() {
  const waiting = [];
  let inFlight = 0;
  let peak = 0;
  return {
    gate: (item) =>
      new Promise((resolve) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        waiting.push({ key: item.keys[0], release: () => (inFlight--, resolve()) });
      }),
    waiting,
    get peak() {
      return peak;
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const releaseAll = async (g) => {
  while (g.waiting.length || (await tick(), g.waiting.length)) {
    g.waiting.shift().release();
    await tick();
  }
};

test("groups run up to `concurrency` at once, and the manifest keeps group order", async () => {
  const g = gated();
  const uploader = fakeUploader({ gate: g.gate });
  const groups = ["a", "b", "c", "d", "e"].map((n) => group(file(`${n}.txt`)));
  const run = runUpload({ groups, keyBase: "p", uploader, transform: rawTransform, concurrency: 3 });
  await tick();
  assert.equal(g.waiting.length, 3);
  // Finish out of order
  g.waiting.pop().release();
  await releaseAll(g);
  const { keys } = await run;
  assert.equal(g.peak, 3);
  assert.deepEqual(keys, ["p/_CLIENT.json", "p/a.txt", "p/b.txt", "p/c.txt", "p/d.txt", "p/e.txt"]);
  const order = uploader.calls.filter((c) => c[0] === "group").map((c) => c[1][0]);
  assert.notDeepEqual(order, keys.slice(1)); // they really did finish out of order
});

test("a transform or uploader concurrency cap wins over the requested one", async () => {
  for (const [transformCap, uploaderCap, want] of [[1, undefined, 1], [undefined, 2, 2], [3, 2, 2]]) {
    const g = gated();
    const run = runUpload({
      groups: ["a", "b", "c", "d"].map((n) => group(file(`${n}.txt`))),
      keyBase: "p",
      uploader: fakeUploader({ gate: g.gate, concurrency: uploaderCap }),
      transform: { ...rawTransform, concurrency: transformCap },
      concurrency: 4,
    });
    await releaseAll(g);
    await run;
    assert.equal(g.peak, want, `transform ${transformCap}, uploader ${uploaderCap}`);
  }
});

test("the first fatal failure aborts the groups in flight and starts no more", async () => {
  const signals = [];
  const uploader = fakeUploader({
    gate: (item, hooks) => {
      signals.push(hooks.signal);
      if (item.keys[0] === "p/b.txt") return Promise.reject(Object.assign(new Error("boom"), { kind: "network" }));
      // Others hang until aborted
      return new Promise((_, reject) => hooks.signal.addEventListener("abort", () => reject(hooks.signal.reason)));
    },
  });
  const groups = ["a", "b", "c", "d"].map((n) => group(file(`${n}.txt`)));
  const done = [];
  await assert.rejects(
    runUpload({
      groups,
      keyBase: "p",
      uploader,
      transform: rawTransform,
      concurrency: 3,
      hooks: { onGroupDone: (i) => done.push(i) },
    }),
    (err) => err.message === "boom" && err.groupIndex === 1
  );
  assert.equal(signals.length, 3); // d never started
  assert.ok(signals.every((s) => s.aborted));
  assert.deepEqual(done, []);
  assert.ok(!uploader.calls.some((c) => c[1] === "p/_MANIFEST.txt"));
});

test("aborting the caller's signal stops the run", async () => {
  const ctrl = new AbortController();
  const uploader = fakeUploader({
    gate: (_item, hooks) =>
      new Promise((_, reject) => hooks.signal.addEventListener("abort", () => reject(hooks.signal.reason))),
  });
  const run = runUpload({
    groups: [group(file("a.txt"))],
    keyBase: "p",
    uploader,
    transform: rawTransform,
    signal: ctrl.signal,
  });
  await tick();
  ctrl.abort(new Error("cancelled"));
  await assert.rejects(run, (err) => err.message === "cancelled" && err.groupIndex === 0);
});

test("buildUploadItems keys by relative path, through the transform's naming", () => {
  const [item] = buildUploadItems([group(file("run1/a.fastq"), file("run1/b.fastq"))], "p/ts", (p) => p + ".gz");
  assert.deepEqual(item.keys, ["p/ts/run1/a.fastq.gz", "p/ts/run1/b.fastq.gz"]);
});

test("findOversizeFiles checks every file of every group against the cap", () => {
  const small = file("a.fastq", "@");
  const big = file("b_R2.fastq", "@".repeat(10));
  assert.deepEqual(findOversizeFiles([group(small), group(small, big)], 5), [big]);
  assert.deepEqual(findOversizeFiles([group(big)], null), []);
});

test("clientRecord names the app, transform and sssender, and counts the input", () => {
  const rec = clientRecord({
    app: "someapp",
    appVersion: "1.2.3",
    commit: "abc123",
    transform: "raw",
    groups: [group(file("a.fastq", "@@@@"), file("b.fastq", "@@"))],
    extra: { note: 1 },
  });
  assert.equal(rec.app, "someapp");
  assert.equal(rec.app_version, "1.2.3");
  assert.equal(rec.commit, "abc123");
  assert.equal(rec.transform, "raw");
  assert.equal(rec.groups, 1);
  assert.equal(rec.files, 2);
  assert.equal(rec.input_bytes, 6);
  assert.equal(rec.note, 1);
  assert.equal(rec.layout, 1);
  assert.ok(typeof rec.sssender_version === "string" && typeof rec.sssender_commit === "string");
});

test("clientEnvironment reports provenance and nothing more", () => {
  const env = clientEnvironment();
  // The signature rides in the fragment, so no URL may ever appear here
  const serialised = JSON.stringify(env);
  assert.ok(!/#u=|x-amz-signature|policy|http/i.test(serialised), serialised);
  assert.deepEqual(Object.keys(env).filter((k) => k !== "device_memory_gb").sort(), [
    "hardware_concurrency",
    "languages",
    "platform",
    "timezone",
    "user_agent",
  ]);
  assert.ok(Array.isArray(env.languages));
  assert.ok(typeof env.timezone === "string" && env.timezone.length > 0);
});

test("a group whose error says retry gets exactly one more go", async () => {
  for (const [failures, wantFailed] of [[1, 0], [2, 1]]) {
    let starts = 0;
    const events = [];
    const { failed, keys } = await runUpload({
      groups: [group(file("a.fq"))],
      keyBase: "p",
      uploader: fakeUploader(),
      transform: {
        ...rawTransform,
        start(g) {
          if (++starts <= failures) throw Object.assign(new Error("worker crashed"), { kind: "input", retry: true });
          return rawTransform.start(g);
        },
      },
      hooks: {
        onGroupRetry: (i) => events.push(["retry", i]),
        onGroupFailed: (i) => events.push(["failed", i]),
        onGroupDone: (i) => events.push(["done", i]),
      },
    });
    assert.equal(starts, Math.min(failures + 1, 2));
    assert.equal(failed.length, wantFailed);
    assert.deepEqual(events, wantFailed ? [["retry", 0], ["failed", 0]] : [["retry", 0], ["done", 0]]);
    assert.equal(keys.includes("p/a.fq"), !wantFailed);
  }
});

test("_CLIENT.json is written first in every mode, naming the app, transform and access", async () => {
  const uploader = fakeUploader();
  await runUpload({
    groups: [group(file("a.fq"))],
    keyBase: "p",
    uploader,
    transform: rawTransform,
    client: { app: "someapp", appVersion: "1.0", commit: "abc", extra: { note: 1 } },
  });
  const [first] = uploader.calls.filter((c) => c[0] !== "preflight");
  assert.equal(first[1], "p/_CLIENT.json");
  const rec = JSON.parse(first[2]);
  assert.equal(rec.app, "someapp");
  assert.equal(rec.transform, "raw");
  assert.equal(rec.note, 1);
  assert.deepEqual(rec.access, { mode: "test", access_key_id: "AKIAFAKE" });
});

test("a refused _CLIENT.json stops the run before any data is sent", async () => {
  const uploader = fakeUploader();
  uploader.putSmall = async () => Promise.reject(Object.assign(new Error("Access Denied"), { kind: "credentials" }));
  await assert.rejects(
    runUpload({ groups: [group(file("a.fq"))], keyBase: "p", uploader, transform: rawTransform }),
    (err) => err.kind === "credentials"
  );
  assert.ok(!uploader.calls.some((c) => c[0] === "start"));
});
