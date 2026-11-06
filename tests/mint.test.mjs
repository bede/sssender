import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = (name) => `${pathToFileURL(resolve(here, "../core", name))}?test=${Date.now()}`;
const { signingKey, sanitise, checkRoot, makePrefix, mintMagicLink, POST_MAX_BYTES } = await import(lib("mint.js"));
const { parseMagicLink } = await import(lib("link.js"));

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const NOW = new Date("2026-07-09T14:22:00Z");
const BASE = { endpoint: "https://s3.example.test", bucket: "b", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" };
// Suffix a1b2: letter 0, digit 1, letter 1, digit 2
const fixedSuffix = () => { const picks = [0, 1, 1, 2]; return () => picks.shift(); };

test("signing key matches AWS's published SigV4 example", async () => {
  const key = await signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
  assert.equal(hex(key), "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
});

test("policy and signature are byte-identical to scripts/mint-magic-link.py", async () => {
  // Expected values printed by the Python script for the same inputs
  const { fields, prefix } = await mintMagicLink({ ...BASE, name: "X", randomFn: fixedSuffix(), baseUrl: "https://x.test/", now: NOW });
  assert.equal(prefix, "sssender/x-a1b2/");
  assert.equal(
    fields.policy,
    "eyJleHBpcmF0aW9uIjoiMjAyNi0wNy0xNlQxNDoyMjowMFoiLCJjb25kaXRpb25zIjpbeyJidWNrZXQiOiJiIn0sWyJzdGFydHMtd2l0aCIsIiRrZXkiLCJzc3NlbmRlci94LWExYjIvIl0sWyJjb250ZW50LWxlbmd0aC1yYW5nZSIsMCw1MzY4NzA5MTIwXSxbInN0YXJ0cy13aXRoIiwiJENvbnRlbnQtVHlwZSIsIiJdLHsieC1hbXotYWxnb3JpdGhtIjoiQVdTNC1ITUFDLVNIQTI1NiJ9LHsieC1hbXotY3JlZGVudGlhbCI6IkFLSUFFWEFNUExFLzIwMjYwNzA5L3VzLWVhc3QtMS9zMy9hd3M0X3JlcXVlc3QifSx7IngtYW16LWRhdGUiOiIyMDI2MDcwOVQxNDIyMDBaIn1dfQ=="
  );
  assert.equal(fields["x-amz-signature"], "832ef151f4d8fcb2cfb6fa89deaa68dd63e6749c7f46f77ffe7776c588d3aa9e");
  assert.deepEqual(Object.keys(fields), ["x-amz-algorithm", "x-amz-credential", "x-amz-date", "policy", "x-amz-signature"]);
});

test("a minted link is read back by the upload pages", async () => {
  const { link, expiresAt } = await mintMagicLink({
    ...BASE,
    endpoint: "https://s3.example.test/",
    name: "batch",
    root: "someapp/",
    randomFn: fixedSuffix(),
    days: 3,
    maxBytes: 1024,
    baseUrl: "https://bede.im/someapp",
    now: NOW,
  });
  assert.match(link, /^https:\/\/bede\.im\/someapp\/#u=[\w-]+$/);
  const parsed = parseMagicLink(new URL(link).hash);
  assert.equal(parsed.endpoint, "https://s3.example.test");
  assert.equal(parsed.bucket, "b");
  assert.equal(parsed.prefix, "someapp/batch-a1b2/");
  assert.equal(parsed.maxBytes, 1024);
  assert.equal(parsed.expiresAt, expiresAt.getTime());
  assert.equal(expiresAt.toISOString(), "2026-07-12T14:22:00.000Z");
});

test("prefixes are sanitised, suffixed letter-digit-letter-digit, and rooted under the app's root", () => {
  assert.equal(sanitise("  INRB Batch 3!! "), "inrb-batch-3");
  assert.throws(() => sanitise("!!!"), /letter or digit/);
  assert.match(makePrefix("Smoke Test!!"), /^sssender\/smoke-test-[a-z][0-9][a-z][0-9]\/$/);
  assert.match(makePrefix("Smoke Test!!", { root: "updeacon/" }), /^updeacon\/smoke-test-[a-z][0-9][a-z][0-9]\/$/);
  assert.match(makePrefix("x", { root: "a/b/" }), /^a\/b\/x-/);
  // Never the top of the bucket, where apps would clash
  for (const root of ["", "/", "app", "/app/", "App/", "../app/", null]) {
    assert.throws(() => checkRoot(root), /Invalid upload root/, String(root));
  }
});

test("errors name the empty fields by their labels, in on-screen order", async () => {
  const args = { ...BASE, name: "x", baseUrl: "https://x.test/", now: NOW };
  await assert.rejects(mintMagicLink({ ...args, endpoint: "", secretAccessKey: "" }), {
    message: "Enter the server address and secret access key.",
  });
  // Credentials are checked before the name, so a blank form asks for them first
  await assert.rejects(mintMagicLink({ ...args, bucket: "", name: "" }), { message: "Enter the bucket." });
  await assert.rejects(mintMagicLink({ ...args, name: "" }), { message: "Enter a name for the link." });
  await assert.rejects(mintMagicLink({ ...args, name: "!!!" }), /at least one letter or digit/);
});

test("refuses out-of-range lifetimes and file sizes, too small as well as too large", async () => {
  const args = { ...BASE, name: "x", baseUrl: "https://x.test/", now: NOW };
  for (const days of [0, 8, 2.5, NaN]) {
    await assert.rejects(mintMagicLink({ ...args, days }), /whole number of days from 1 to 7/);
  }
  for (const maxBytes of [0, -1, NaN, POST_MAX_BYTES + 1]) {
    await assert.rejects(mintMagicLink({ ...args, maxBytes }), /greater than 0 and at most 5 GB/);
  }
});

test("an AWS endpoint signs for its own region; anything else for us-east-1", async () => {
  const { regionForEndpoint } = await import(lib("mint.js"));
  assert.equal(regionForEndpoint("https://s3.eu-west-2.amazonaws.com"), "eu-west-2");
  assert.equal(regionForEndpoint("https://s3-eu-west-1.amazonaws.com"), "eu-west-1");
  assert.equal(regionForEndpoint("https://s3.dualstack.ap-south-1.amazonaws.com"), "ap-south-1");
  assert.equal(regionForEndpoint("https://s3.amazonaws.com"), "us-east-1");
  assert.equal(regionForEndpoint("https://s3.climb.ac.uk"), "us-east-1");
  assert.equal(regionForEndpoint("http://localhost:9000"), "us-east-1");
  const { fields } = await mintMagicLink({ ...BASE, endpoint: "https://s3.eu-west-2.amazonaws.com", name: "x", baseUrl: "https://x.test/", now: NOW });
  assert.match(fields["x-amz-credential"], /\/eu-west-2\/s3\/aws4_request$/);
});
