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
  assert.match(label.textContent, /^Uploading 2 at once, 0 of 3 done: 100B \/ 400B \(25\.0%\)$/);
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
    "2 files selected (1 pair, 2.0KB total), 1 hidden file skipped"
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
