import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { describeType, fileType, isJunk, selectFiles, singleGroups } = await import(
  `${pathToFileURL(resolve(here, "../core/select.js"))}?test=${Date.now()}`
);

const file = (path, size = 1) => ({ name: path.split("/").pop(), size, webkitRelativePath: path });

test("types keep a compression suffix with what it compresses", () => {
  assert.equal(fileType(file("a.FASTQ.gz")), "fastq.gz");
  assert.equal(fileType(file("b.tar.zst")), "tar.zst");
  assert.equal(fileType(file("c.csv")), "csv");
  assert.equal(fileType(file("d.gz")), "gz");
  assert.equal(fileType(file("README")), "");
  assert.equal(fileType("x.v2.json"), "json");
  assert.equal(describeType("fastq.gz"), ".fastq.gz");
  assert.equal(describeType(""), "no extension");
});

test("OS litter and hidden directories are junk", () => {
  assert.ok(isJunk(file("run/.DS_Store")));
  assert.ok(isJunk(file("run/.git/config")));
  assert.ok(isJunk(file("Thumbs.db")));
  assert.ok(!isJunk(file("run/a.fastq")));
});

test("each file is its own group by default, in path order", () => {
  const groups = singleGroups([file("b.txt", 2), file("a.txt", 3)]);
  assert.deepEqual(groups.map((g) => [g.label, g.size, g.files.length]), [["a.txt", 3, 1], ["b.txt", 2, 1]]);
});

test("selectFiles counts types and leaves disabled ones out of the groups", () => {
  const input = [file("a.csv", 10), file("b.csv", 20), file("c.json", 5), file(".DS_Store"), file("d")];
  const all = selectFiles(input);
  assert.deepEqual(all.types, [
    { key: "csv", count: 2, bytes: 30, enabled: true },
    { key: "", count: 1, bytes: 1, enabled: true },
    { key: "json", count: 1, bytes: 5, enabled: true },
  ]);
  assert.equal(all.ignored, 1);
  assert.equal(all.groups.length, 4);
  assert.equal(all.totalBytes, 36);

  const some = selectFiles(input, { disabled: new Set(["csv", ""]) });
  assert.equal(some.files.length, 4);
  assert.deepEqual(some.selected.map((f) => f.name), ["c.json"]);
  assert.deepEqual(some.groups.map((g) => g.label), ["c.json"]);
  assert.deepEqual(some.types.map((t) => t.enabled), [false, false, true]);
  assert.equal(some.totalBytes, 5);
});

test("accept() filters before typing, and a grouping error is reported, not thrown", () => {
  const sel = selectFiles([file("a.fq"), file("notes.txt")], {
    accept: (f) => f.name.endsWith(".fq"),
    group: () => {
      throw new Error("Ambiguous pair");
    },
  });
  assert.equal(sel.rejected, 1);
  assert.deepEqual(sel.types.map((t) => t.key), ["fq"]);
  assert.deepEqual(sel.groups, []);
  assert.equal(sel.error, "Ambiguous pair");
});

test("custom classify merges types", () => {
  const sel = selectFiles([file("a.fq.gz"), file("b.fastq")], { classify: () => "reads" });
  assert.deepEqual(sel.types.map((t) => [t.key, t.count]), [["reads", 2]]);
});
