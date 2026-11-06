// Layering that lets apps vendor core/ and ui/. Neither knows the root page
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

async function imports(dir) {
  const out = [];
  for (const name of (await readdir(resolve(root, dir))).filter((n) => n.endsWith(".js"))) {
    const text = await readFile(resolve(root, dir, name), "utf8");
    for (const [, spec] of text.matchAll(/(?:from|import\()\s*["'`]([^"'`]+)["'`]/g)) out.push([name, spec]);
  }
  return out;
}

test("core/ imports only core/ (and the vendored SDK)", async () => {
  for (const [name, spec] of await imports("core")) {
    assert.match(spec, /^(\.\/[\w.-]+|\.\.\/vendor\/aws-sdk)\.js\?v=[\w-]+$/, `core/${name} imports ${spec}`);
  }
});

test("ui/ imports only ui/ and core/", async () => {
  for (const [name, spec] of await imports("ui")) {
    assert.match(spec, /^(\.\/|\.\.\/core\/)[\w.-]+\.js\?v=[\w-]+$/, `ui/${name} imports ${spec}`);
  }
});

const TOKEN_RE = /(?:ASSET_VERSION = "|[?]v=)([0-9]{8}-[0-9]{6})/g;

async function stampedFiles() {
  const { execFileSync } = await import("node:child_process");
  return execFileSync(resolve(root, "scripts/stamp-cache-token.sh"), ["--list"], { encoding: "utf8" }).split("\n").filter(Boolean);
}

test("the source module graph uses one cache token", async () => {
  const tokens = [];
  for (const path of await stampedFiles()) {
    tokens.push(...[...(await readFile(resolve(root, path), "utf8")).matchAll(TOKEN_RE)].map((m) => m[1]));
  }
  assert.ok(tokens.length >= 30, `only ${tokens.length} tokens found`);
  assert.equal(new Set(tokens).size, 1);
});
