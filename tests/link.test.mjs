import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { parseMagicLink, describeExpiry } = await import(
  `${pathToFileURL(resolve(here, "../core/link.js"))}?test=${Date.now()}`
);

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function policy({
  bucket = "test-bucket",
  prefix = "inrb-batch3-k7q2/",
  maxBytes = 5368709120,
  expiration = "2026-07-16T14:22:00Z",
  extra = [],
} = {}) {
  const conditions = [{ bucket }, ["content-length-range", 0, maxBytes], ...extra];
  if (prefix != null) conditions.splice(1, 0, ["starts-with", "$key", prefix]);
  return b64({ expiration, conditions });
}

function link(opts = {}) {
  return `#u=${b64url({
    v: 1,
    endpoint: opts.endpoint ?? "https://s3.climb.ac.uk",
    fields: {
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": "AKIAEXAMPLE/20260709/us-east-1/s3/aws4_request",
      "x-amz-date": "20260709T142200Z",
      policy: policy(opts),
      "x-amz-signature": "a".repeat(64),
      ...(opts.fields ?? {}),
    },
  })}`;
}

test("returns null when the hash carries no link", () => {
  assert.equal(parseMagicLink(""), null);
  assert.equal(parseMagicLink("#"), null);
  assert.equal(parseMagicLink(undefined), null);
  assert.equal(parseMagicLink("#index=panhuman"), null);
});

test("derives bucket, prefix, cap and expiry from the signed policy", () => {
  const parsed = parseMagicLink(link());
  assert.equal(parsed.endpoint, "https://s3.climb.ac.uk");
  assert.equal(parsed.bucket, "test-bucket");
  assert.equal(parsed.prefix, "inrb-batch3-k7q2/");
  assert.equal(parsed.maxBytes, 5368709120);
  assert.equal(parsed.expiresAt, Date.parse("2026-07-16T14:22:00Z"));
  assert.equal(parsed.fields["x-amz-signature"], "a".repeat(64));
});

test("posts the policy back verbatim, signature intact", () => {
  const parsed = parseMagicLink(link());
  // fields must survive untouched: any mutation invalidates the signature
  assert.deepEqual(Object.keys(parsed.fields).sort(), [
    "policy",
    "x-amz-algorithm",
    "x-amz-credential",
    "x-amz-date",
    "x-amz-signature",
  ]);
});

test("carries a session token through when the policy has one", () => {
  const parsed = parseMagicLink(
    link({ fields: { "x-amz-security-token": "tok" }, extra: [{ "x-amz-security-token": "tok" }] })
  );
  assert.equal(parsed.fields["x-amz-security-token"], "tok");
});

test("strips a trailing slash from the endpoint", () => {
  assert.equal(parseMagicLink(link({ endpoint: "https://s3.climb.ac.uk/" })).endpoint, "https://s3.climb.ac.uk");
});

test("refuses a policy that does not scope uploads to a prefix", () => {
  assert.throws(() => parseMagicLink(link({ prefix: null })), /does not restrict uploads to a prefix/);
});

test("refuses a policy with no bucket", () => {
  const hash = `#u=${b64url({
    v: 1,
    endpoint: "https://s3.climb.ac.uk",
    fields: { policy: b64({ expiration: "2026-07-16T14:22:00Z", conditions: [["starts-with", "$key", "p/"]] }), "x-amz-signature": "x" },
  })}`;
  assert.throws(() => parseMagicLink(hash), /names no bucket/);
});

test("refuses a policy with an unparseable expiry", () => {
  assert.throws(() => parseMagicLink(link({ expiration: "whenever" })), /no valid expiry/);
});

test("rejects an unsupported link version", () => {
  const hash = `#u=${b64url({ v: 2, endpoint: "https://x", fields: {} })}`;
  assert.throws(() => parseMagicLink(hash), /version 2 is not supported/);
});

test("rejects a link missing its signature", () => {
  const hash = `#u=${b64url({ v: 1, endpoint: "https://x", fields: { policy: policy() } })}`;
  assert.throws(() => parseMagicLink(hash), /missing required fields/);
});

test("rejects a truncated payload", () => {
  assert.throws(() => parseMagicLink("#u=not-valid-base64-json"), /corrupt/);
});

test("describeExpiry counts down in the largest sensible unit", () => {
  const now = Date.parse("2026-07-09T00:00:00Z");
  const at = (iso) => describeExpiry(Date.parse(iso), now);
  assert.deepEqual(at("2026-07-16T00:00:00Z"), { expired: false, text: "7 days" });
  assert.deepEqual(at("2026-07-10T00:00:00Z"), { expired: false, text: "1 day" });
  assert.deepEqual(at("2026-07-09T03:00:00Z"), { expired: false, text: "3 hours" });
  assert.deepEqual(at("2026-07-09T00:30:00Z"), { expired: false, text: "30 minutes" });
  assert.deepEqual(at("2026-07-09T00:00:30Z"), { expired: false, text: "less than a minute" });
  // A link minted "7 days" ago-to-the-second must not read as 6
  assert.deepEqual(at("2026-07-15T23:59:30Z"), { expired: false, text: "7 days" });
});

test("describeExpiry reports elapsed time once expired", () => {
  const now = Date.parse("2026-07-09T00:00:00Z");
  assert.deepEqual(describeExpiry(Date.parse("2026-07-07T00:00:00Z"), now), { expired: true, text: "2 days" });
  assert.deepEqual(describeExpiry(now, now), { expired: true, text: "less than a minute" });
});
