#!/usr/bin/env python3
"""Smoke-test a magic link against the real object store.

Verifies the two things only a live bucket can answer: that it accepts our POST
policy, and that it refuses writes outside the authorised prefix.

Needs no credentials; the link carries its own authority. Writes one small object
inside the prefix, which it cannot then delete.

    scripts/check-upload-link.py 'https://.../#u=...'
"""

import base64
import json
import re
import secrets
import sys
import urllib.error
import urllib.request


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def parse_link(url: str):
    frag = url.partition("#")[2]
    match = re.search(r"(?:^|&)u=([A-Za-z0-9_-]+)", frag)
    if not match:
        raise SystemExit("error: that URL has no #u=... payload")
    payload = json.loads(b64url_decode(match.group(1)))
    policy = json.loads(base64.b64decode(payload["fields"]["policy"]))

    bucket = prefix = None
    for cond in policy["conditions"]:
        if isinstance(cond, dict) and "bucket" in cond:
            bucket = cond["bucket"]
        elif isinstance(cond, list) and cond[0] == "starts-with" and cond[1] == "$key":
            prefix = cond[2]
    return payload["endpoint"], bucket, prefix, policy["expiration"], payload["fields"]


def post_object(endpoint, bucket, fields, key, body):
    """Mirrors core/post.js: key first, file last, fields verbatim."""
    boundary = f"----sssender{secrets.token_hex(8)}"
    parts = []

    def field(name, value):
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )

    field("key", key)
    for name, value in fields.items():
        field(name, value)
    field("Content-Type", "text/plain")
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="f"\r\n'
        f"Content-Type: text/plain\r\n\r\n".encode()
        + body
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())

    req = urllib.request.Request(
        f"{endpoint}/{bucket}",
        data=b"".join(parts),
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, ""
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        code = re.search(r"<Code>([^<]+)</Code>", body)
        return exc.code, code.group(1) if code else body[:120]


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    endpoint, bucket, prefix, expiration, fields = parse_link(sys.argv[1])

    print(f"endpoint {endpoint}")
    print(f"bucket   {bucket}")
    print(f"prefix   {prefix}")
    print(f"expires  {expiration}\n")

    failures = 0
    probe = f"{prefix}_LINK_CHECK.txt"

    status, err = post_object(endpoint, bucket, fields, probe, b"sssender link check\n")
    if status in (200, 201, 204):
        print(f"  ok   object store accepted the POST policy ({status}) -> {probe}")
    else:
        failures += 1
        print(f" FAIL  POST inside the prefix was rejected: HTTP {status} {err}")
        print("       (RGW may not support POST Object, or the policy/signature is wrong)")

    # The prefix must be enforced by the object store, not the page
    for escape in ("escape.txt", f"{prefix.rstrip('/')}-sibling/escape.txt"):
        status, err = post_object(endpoint, bucket, fields, escape, b"should not exist\n")
        if status == 403:
            print(f"  ok   write outside the prefix denied (403 {err}) -> {escape}")
        else:
            failures += 1
            print(f" FAIL  wrote outside the prefix! HTTP {status} -> {escape}")
            print("       The policy is not constraining $key. Do not distribute this link.")

    print()
    if failures:
        print(f"{failures} check(s) failed")
    else:
        print("all checks passed, the link works and the prefix is enforced")
        print(f"remove the probe with:\n  aws s3 rm s3://{bucket}/{probe} --endpoint-url {endpoint}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
