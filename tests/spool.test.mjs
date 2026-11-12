import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { MEMORY_SPOOL_MAX_BYTES, prepareSpoolStorage, spoolToFile } = await import(
  `${pathToFileURL(resolve(here, "../core/spool.js"))}?test=${Date.now()}`
);

test("large link uploads require OPFS rather than an unbounded memory fallback", async () => {
  await assert.rejects(
    prepareSpoolStorage(MEMORY_SPOOL_MAX_BYTES + 1, { supported: false }),
    (err) => err.kind === "storage" && /OPFS support/i.test(err.message)
  );
  await assert.rejects(
    spoolToFile(new ReadableStream(), "large.bin", { expectedBytes: MEMORY_SPOOL_MAX_BYTES + 1 }),
    (err) => err.kind === "storage"
  );
});

test("small outputs retain the compatibility memory fallback", async () => {
  const prepared = await prepareSpoolStorage(1024, { supported: false });
  assert.deepEqual(prepared, { opfs: false });

  const blob = await spoolToFile(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("reads"));
        controller.close();
      },
    }),
    "small.bin",
    { expectedBytes: 5 }
  );
  assert.equal(await blob.text(), "reads");
});

test("Cancel also stops a pending read in the memory spool fallback", { timeout: 1000 }, async () => {
  const ctrl = new AbortController();
  let cancelled;
  const stream = new ReadableStream({
    pull: () => new Promise(() => {}),
    cancel(reason) { cancelled = reason; },
  });
  const spooling = spoolToFile(stream, "small.bin", { expectedBytes: 5, signal: ctrl.signal });
  const reason = new DOMException("Cancelled", "AbortError");
  ctrl.abort(reason);
  await assert.rejects(spooling, (err) => err === reason);
  assert.equal(cancelled, reason);
  assert.ok(!stream.locked);
});

test("spool preparation requests persistence without guessing the filtered size", async () => {
  let persistCalls = 0;
  const result = await prepareSpoolStorage(80, {
    supported: true,
    persistFn: async () => {
      persistCalls++;
      return true;
    },
  });
  assert.equal(persistCalls, 1);
  assert.deepEqual(result, { opfs: true });
});

test("an actual OPFS quota failure becomes a clear storage error", async () => {
  const originalNavigator = globalThis.navigator;
  const originalHandle = globalThis.FileSystemFileHandle;
  class MockFileHandle {
    createWritable() {}
  }
  Object.defineProperty(globalThis, "FileSystemFileHandle", {
    configurable: true,
    value: MockFileHandle,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        async getDirectory() {
          return {
            async getDirectoryHandle() {
              return {
                async getFileHandle() {
                  return {
                    async createWritable() {
                      const err = new Error("quota full");
                      err.name = "QuotaExceededError";
                      throw err;
                    },
                  };
                },
              };
            },
          };
        },
      },
    },
  });

  try {
    await assert.rejects(
      spoolToFile(new ReadableStream(), "full.bin", { expectedBytes: 1024 }),
      (err) => err.kind === "storage" && /private storage/i.test(err.message)
    );
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(globalThis, "FileSystemFileHandle", {
      configurable: true,
      value: originalHandle,
    });
  }
});
