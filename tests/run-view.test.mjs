import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { makeRunView } = await import(`${pathToFileURL(resolve(here, "../ui/run-view.js"))}?test=${Date.now()}`);

// Plain objects stand in for the DOM
function setup(sizes, opts = {}) {
  const wrap = { style: {} };
  const bar = { value: -1 };
  const label = { textContent: "" };
  const rows = sizes.map(() => ({ li: { className: "" }, st: { textContent: "" } }));
  const groups = sizes.map((size, i) => ({ label: `f${i}`, size }));
  const view = makeRunView({ wrap, bar, label, rows, groups, ...opts });
  return { view, bar, label, rows, groups };
}

test("raw uploads in parallel add up on one bar", () => {
  const { view, bar, label, rows, groups } = setup([100, 100, 200]);
  assert.deepEqual(rows.map((r) => r.st.textContent), ["queued", "queued", "queued"]);
  view.onGroupStart(0);
  view.onGroupStart(1);
  view.onUploadStart(0, 100);
  view.onUploadProgress(0, 50);
  view.onUploadProgress(1, 50);
  assert.equal(bar.value, 25);
  assert.match(label.textContent, /^Uploading: 0 of 3 done, 100B \/ 400B \(25\.0%\)$/);
  assert.equal(rows[0].st.textContent, "uploading 50%");
  assert.equal(rows[1].st.textContent, "uploading 50%");
  view.onGroupDone(0, groups[0], {});
  assert.equal(rows[0].li.className, "done");
  view.onUploadProgress(1, 100);
  assert.match(label.textContent, /^Uploading 2 of 3: 200B \/ 400B \(50\.0%\)$/);
});

test("retries show on the row and clear when bytes move again", () => {
  const { view, rows } = setup([100]);
  view.onGroupStart(0);
  view.onUploadRetry(0, { waitingOnline: true });
  assert.equal(rows[0].st.textContent, "waiting for connection");
  view.onUploadRetry(0, { attempt: 2, waitMs: 1000 });
  assert.equal(rows[0].st.textContent, "retrying (attempt 2)");
  view.onUploadProgress(0, 10);
  assert.equal(rows[0].st.textContent, "uploading 10%");
});

test("a transform drives the bar by bytes read, then a spooled upload by bytes sent", () => {
  const { view, bar, label, rows } = setup([200], { transform: { verb: "filtering", past: "filtered" } });
  view.onGroupStart(0);
  assert.equal(rows[0].st.textContent, "filtering…");
  view.onTransformProgress(0, { bytesProcessed: 100 });
  assert.equal(bar.value, 50);
  assert.equal(label.textContent, "Filtering 1 of 1: 100B / 200B (50.0%)");
  assert.equal(rows[0].st.textContent, "filtering 50%");
  view.onUploadStart(0, 80);
  view.onUploadProgress(0, 40);
  assert.equal(label.textContent, "Uploading 1 of 1: 40B / 80B");
  assert.equal(rows[0].st.textContent, "uploading 50%");
});

test("a skipped group is marked failed with its reason, and counts as settled", () => {
  const { view, rows, label } = setup([10, 10]);
  view.onGroupStart(0);
  view.onGroupStart(1);
  view.onGroupFailed(0, {}, new Error("corrupt gzip"));
  assert.equal(rows[0].li.className, "failed");
  assert.equal(rows[0].li.title, "corrupt gzip");
  assert.equal(rows[0].st.textContent, "failed, skipped");
  view.onUploadProgress(1, 5);
  assert.equal(label.textContent, "Uploading 2 of 2: 15B / 20B (75.0%)");
});

test("a failure marks its row failed and the others in flight stopped", () => {
  const { view, rows, groups, label } = setup([1, 1, 1, 1]);
  view.onGroupStart(0);
  view.onGroupDone(0, groups[0], {});
  view.onGroupStart(1);
  view.onGroupStart(2);
  view.fail(2);
  assert.deepEqual(
    rows.map((r) => [r.li.className, r.st.textContent]),
    [["done", "done"], ["", "stopped"], ["failed", "failed"], ["", "queued"]]
  );
  assert.equal(label.textContent, "Stopped: 1 of 4 done.");
  view.onUploadProgress(1, 1); // a late event from a stopped group changes nothing
  assert.equal(rows[1].st.textContent, "stopped");
});

test("summariseSelection counts what will go, and says what was left out", async () => {
  const { summariseSelection } = await import(`${pathToFileURL(resolve(here, "../ui/ui.js"))}?test=${Date.now()}`);
  const sel = (o) => ({ files: [], selected: [], groups: [], totalBytes: 0, ignored: 0, rejected: 0, error: null, ...o });
  assert.equal(summariseSelection(sel({})), "");
  assert.equal(summariseSelection(sel({ ignored: 2 })), "No files found in selection, 2 hidden files skipped");
  assert.equal(
    summariseSelection(sel({ rejected: 1 }), { noun: "sequence file" }),
    "No sequence files found in selection, 1 other file ignored"
  );
  const two = [{}, {}];
  assert.equal(
    summariseSelection(sel({ files: two, selected: two, totalBytes: 2048, ignored: 1 }), { details: () => ["1 pair"] }),
    "2 files selected (1 pair, 2.0KB), 1 hidden file skipped"
  );
});

test("retries show their attempt and reason, cancel marks rows in flight", () => {
  const { view, rows, label, groups } = setup([10, 10, 10]);
  view.onGroupStart(0);
  view.onGroupStart(1);
  view.onUploadRetry(0, { attempt: 3, error: new Error("Upload stalled.") });
  assert.equal(rows[0].st.textContent, "retrying (attempt 3): upload stalled");
  assert.equal(rows[0].li.title, "Upload stalled.");
  view.onUploadRetry(0, { attempt: 3, error: new Error("A very long explanation of what went wrong here today") });
  assert.equal(rows[0].st.textContent, "retrying (attempt 3): a very long explanation of what went wr…");
  view.onGroupDone(1, groups[1], {});
  view.cancel();
  assert.deepEqual(rows.map((r) => r.st.textContent), ["cancelled", "done", "queued"]);
  assert.equal(label.textContent, "Cancelled: 1 of 3 done.");
});

test("a group the transform starts over shows it, and its progress resets", () => {
  const { view, rows, bar } = setup([100], { transform: { verb: "filtering", past: "filtered" } });
  view.onGroupStart(0);
  view.onTransformProgress(0, { bytesProcessed: 60 });
  assert.equal(bar.value, 60);
  view.onGroupRetry(0, {}, new Error("Deacon stopped unexpectedly"));
  assert.equal(rows[0].st.textContent, "starting again…");
  assert.equal(rows[0].li.title, "Deacon stopped unexpectedly");
  view.onTransformProgress(0, { bytesProcessed: 10 });
  assert.equal(bar.value, 10);
});

test("an upload that stops moving says so on its row, until bytes move again", () => {
  let now = 0;
  let tick = null;
  let cleared = false;
  const { view, rows, groups } = setup([100, 100], {
    nowFn: () => now,
    setIntervalFn: (fn) => ((tick = fn), 1),
    clearIntervalFn: () => (cleared = true),
  });
  view.onGroupStart(0);
  view.onUploadStart(0, 100);
  view.onUploadProgress(0, 40);
  now = 59_000;
  tick();
  assert.equal(rows[0].st.textContent, "uploading 40%");
  now = 3 * 60_000 + 1;
  tick();
  assert.equal(rows[0].st.textContent, "uploading 40%, no progress for 3 min");
  view.onUploadProgress(0, 41);
  assert.equal(rows[0].st.textContent, "uploading 41%");
  // A retry's own text wins, and restarts the clock
  now += 2 * 60_000;
  tick();
  view.onUploadRetry(0, { attempt: 1, error: new Error("Upload stalled.") });
  tick();
  assert.equal(rows[0].st.textContent, "retrying (attempt 1): upload stalled");
  view.onGroupDone(0, groups[0], {});
  tick();
  assert.ok(cleared, "the timer stops once nothing is in flight");
});

test("a transform still starting up is not called quiet", () => {
  let now = 0;
  let tick = null;
  const { view, rows } = setup([100], {
    transform: { verb: "filtering", past: "filtered" },
    nowFn: () => now,
    setIntervalFn: (fn) => ((tick = fn), 1),
    clearIntervalFn: () => {},
  });
  view.onGroupStart(0);
  now = 10 * 60_000;
  tick();
  assert.equal(rows[0].st.textContent, "filtering…");
});

test("the label, always in view, says when uploads are quiet, retrying or waiting", () => {
  let now = 0;
  let tick = null;
  const classes = new Set();
  const { view, label, groups } = setup([100, 100], {
    nowFn: () => now,
    setIntervalFn: (fn) => ((tick = fn), 1),
    clearIntervalFn: () => {},
  });
  label.classList = { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) };
  view.onGroupStart(0);
  view.onGroupStart(1);
  view.onUploadStart(0, 100);
  view.onUploadStart(1, 100);
  view.onUploadProgress(0, 50);
  view.onUploadProgress(1, 50);
  assert.equal(label.textContent, "Uploading: 0 of 2 done, 100B / 200B (50.0%)");
  now = 2 * 60_000;
  tick();
  assert.equal(label.textContent, "Uploading: 0 of 2 done, 100B / 200B (50.0%) · no progress for 2 min");
  assert.ok(classes.has("trouble"));
  view.onUploadRetry(0, { attempt: 1, error: new Error("Upload stalled.") });
  assert.match(label.textContent, / · 1 upload retrying, no progress for 2 min$/);
  view.onUploadRetry(1, { attempt: 1 });
  assert.match(label.textContent, / · 2 uploads retrying$/);
  view.onUploadRetry(1, { waitingOnline: true });
  assert.match(label.textContent, / · waiting for connection$/);
  view.onUploadProgress(0, 10);
  view.onUploadProgress(1, 10);
  assert.doesNotMatch(label.textContent, /·/);
  assert.ok(!classes.has("trouble"));
  view.onGroupDone(0, groups[0], {});
  view.onGroupDone(1, groups[1], {});
  view.finish("Uploaded 200B across 2 files.");
  assert.equal(label.textContent, "Uploaded 200B across 2 files.");
});

// A list box 3 rows tall over rows 20px high, laid out from scrollTop
function scrollingList(n) {
  const list = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 60 }) };
  const rows = Array.from({ length: n }, (_, i) => ({
    li: {
      className: "",
      getBoundingClientRect: () => ({ top: i * 20 - list.scrollTop, bottom: (i + 1) * 20 - list.scrollTop }),
    },
    st: { textContent: "" },
  }));
  const groups = rows.map((_, i) => ({ label: `f${i}`, size: 1 }));
  const view = makeRunView({ wrap: { style: {} }, bar: {}, label: {}, rows, groups, list });
  return { list, view, groups };
}

test("the file list follows the uploads in flight, until the user scrolls away", () => {
  const { list, view, groups } = scrollingList(100);
  for (let i = 0; i < 4; i++) view.onGroupStart(i);
  assert.equal(list.scrollTop, 0);
  for (let i = 0; i < 10; i++) {
    view.onGroupDone(i, groups[i], {});
    view.onGroupStart(i + 4);
  }
  assert.equal(list.scrollTop, 9 * 20, "row 10 in flight, row 9 above it for context");
  // The user scrolls back to read row 2
  list.scrollTop = 40;
  list.onscroll();
  view.onGroupDone(10, groups[10], {});
  view.onGroupStart(14);
  assert.equal(list.scrollTop, 40, "left where the user put it");
  // …and back down to the rows in flight: following again
  list.scrollTop = 200;
  list.onscroll();
  view.onGroupDone(11, groups[11], {});
  view.onGroupStart(15);
  assert.equal(list.scrollTop, 11 * 20);
});
