#!/usr/bin/env python3
"""Mint a magic link: a presigned upload link for sssender or an app built on it.

Signs an S3 POST policy whose `starts-with` condition on `$key` authorises uploads
anywhere under a prefix, and packs it into the URL fragment of the upload page.
Works for any number of files, so the link is reusable until it expires. Each upload
gets its own timestamped subdir inside the prefix.

Needs the AWS CLI configured for the target bucket. The S3 endpoint comes from
--endpoint, else AWS_ENDPOINT_URL_S3 / AWS_ENDPOINT_URL, else the profile's
`endpoint_url`. No third-party packages.

For CLIMB:

    scripts/mint-magic-link.py inrb-batch3 --bucket my-bucket --profile climb --endpoint https://s3.climb.ac.uk

The link opens --page (default: sssender) and authorises uploads under
<root><name>-<suffix>/. Each app has its own --root (default: sssender/), so apps
sharing a bucket never clash. The policy fixes only where files go; the page decides
the rest. Apps wrap this script with their own --page and --root.
"""

import argparse
import base64
import hashlib
import hmac
import json
import re
import secrets
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

DEFAULT_REGION = "us-east-1"  # non-AWS stores (Ceph RGW, MinIO) ignore it
AWS_ENDPOINT_RE = re.compile(r"^https?://(?:[^/]+\.)?s3[.-](?:dualstack\.)?([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?(?:[:/]|$)", re.I)
PAGE_URL = "https://bede.im/sssender/"
DEFAULT_ROOT = "sssender/"  # keep in step with DEFAULT_ROOT in core/mint.js
ROOT_RE = re.compile(r"([a-z0-9][a-z0-9._-]*/)+")

ALGORITHM = "AWS4-HMAC-SHA256"
POST_MAX_BYTES = 5 * 1024**3  # S3 POST Object caps a single upload at 5 GB
MAX_DAYS = 7  # SigV4 signatures are invalid beyond 604800 s
SUFFIX_LETTERS = "abcdefghijklmnopqrstuvwxyz"
SUFFIX_DIGITS = "0123456789"


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret: str, datestamp: str, region: str, service: str) -> bytes:
    k = _hmac(f"AWS4{secret}".encode("utf-8"), datestamp)
    k = _hmac(k, region)
    k = _hmac(k, service)
    return _hmac(k, "aws4_request")


def sanitise(name: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", name.strip().lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-.")
    if not slug:
        raise SystemExit("error: name must contain at least one alphanumeric character")
    return slug


def region_for_endpoint(endpoint: str) -> str:
    """SigV4 region: from an AWS endpoint, else us-east-1. Keep in step with core/mint.js."""
    m = AWS_ENDPOINT_RE.match(endpoint or "")
    if not m or m.group(1) == "external-1":
        return DEFAULT_REGION
    return m.group(1)


def check_root(root: str) -> str:
    """Lower-case path segments, each ending in '/'."""
    if not ROOT_RE.fullmatch(root or ""):
        raise SystemExit(f"error: invalid --root {root!r}: expected e.g. {DEFAULT_ROOT!r}")
    return root


def make_prefix(name: str, root: str = DEFAULT_ROOT) -> str:
    """<root><name>-<suffix>/. The suffix avoids collisions, not guessing; the
    signature is the secret."""
    check_root(root)
    suffix = "".join(
        secrets.choice(SUFFIX_LETTERS if i % 2 == 0 else SUFFIX_DIGITS) for i in range(4)
    )
    return f"{root}{sanitise(name)}-{suffix}/"


def resolve_credentials(profile, allow_session_token):
    cmd = ["aws", "configure", "export-credentials", "--format", "process"]
    if profile:
        cmd += ["--profile", profile]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    except FileNotFoundError:
        raise SystemExit("error: the aws CLI is not on PATH")
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"error: could not resolve AWS credentials\n{exc.stderr.strip()}")

    creds = json.loads(out)
    if creds.get("SessionToken") and not allow_session_token:
        raise SystemExit(
            "error: these are temporary credentials (they carry a session token).\n"
            "The link would stop working the moment the session expires, long before\n"
            "its stated lifetime. Sign with long-lived IAM user keys instead, or pass\n"
            "--allow-session-token if you understand the link will expire early."
        )
    return creds["AccessKeyId"], creds["SecretAccessKey"], creds.get("SessionToken")


def resolve_endpoint(explicit, profile):
    """Return (endpoint, source): --endpoint, else env, else the AWS CLI profile."""
    for value, source in (
        (explicit, "--endpoint"),
        (os.environ.get("AWS_ENDPOINT_URL_S3"), "AWS_ENDPOINT_URL_S3"),
        (os.environ.get("AWS_ENDPOINT_URL"), "AWS_ENDPOINT_URL"),
    ):
        if value:
            return value.rstrip("/"), source
    cmd = ["aws", "configure", "get", "endpoint_url"]
    if profile:
        cmd += ["--profile", profile]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True).stdout.strip()
    except FileNotFoundError:
        raise SystemExit("error: the aws CLI is not on PATH")
    if not out:
        raise SystemExit(
            "error: no S3 endpoint configured. Pass --endpoint, set AWS_ENDPOINT_URL, or add\n"
            "`endpoint_url = https://...` to the AWS CLI profile. For CLIMB:\n"
            "  --endpoint https://s3.climb.ac.uk"
        )
    return out.rstrip("/"), f"profile {profile or 'default'}"


def build_policy(bucket, prefix, region, access_key, session_token, expires_at, now, max_bytes):
    datestamp = now.strftime("%Y%m%d")
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    credential = f"{access_key}/{datestamp}/{region}/s3/aws4_request"

    conditions = [
        {"bucket": bucket},
        # Authorise a key pattern, not a key
        ["starts-with", "$key", prefix],
        ["content-length-range", 0, max_bytes],
        # Empty value matches anything
        ["starts-with", "$Content-Type", ""],
        {"x-amz-algorithm": ALGORITHM},
        {"x-amz-credential": credential},
        {"x-amz-date": amz_date},
    ]
    fields = {
        "x-amz-algorithm": ALGORITHM,
        "x-amz-credential": credential,
        "x-amz-date": amz_date,
    }
    if session_token:
        conditions.append({"x-amz-security-token": session_token})
        fields["x-amz-security-token"] = session_token

    policy = {
        "expiration": expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "conditions": conditions,
    }
    # These exact bytes are signed and posted
    encoded = base64.b64encode(
        json.dumps(policy, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    fields["policy"] = encoded
    return fields, datestamp, encoded


def sign_policy(fields, secret, datestamp, region, encoded_policy):
    key = signing_key(secret, datestamp, region, "s3")
    # No canonical request. The base64 policy is the string to sign
    fields["x-amz-signature"] = hmac.new(
        key, encoded_policy.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return fields


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def self_test():
    """AWS's published SigV4 signing-key derivation example."""
    got = signing_key(
        "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam"
    ).hex()
    want = "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
    if got != want:
        print(f"FAIL signing key\n  got  {got}\n  want {want}", file=sys.stderr)
        return 1

    # A round-trip the browser must decode
    prefix = make_prefix("Smoke Test!!")
    if not re.fullmatch(r"sssender/smoke-test-([a-z][0-9]){2}/", prefix):
        print(f"FAIL prefix shape: {prefix}", file=sys.stderr)
        return 1

    now = datetime(2026, 7, 9, 14, 22, 0, tzinfo=timezone.utc)
    fields, datestamp, encoded = build_policy(
        "b", prefix, "us-east-1", "AKIAEXAMPLE", None,
        now + timedelta(days=7), now, POST_MAX_BYTES,
    )
    sign_policy(fields, "secret", datestamp, "us-east-1", encoded)
    policy = json.loads(base64.b64decode(fields["policy"]))
    assert ["starts-with", "$key", prefix] in policy["conditions"]
    assert policy["expiration"] == "2026-07-16T14:22:00Z"
    assert len(fields["x-amz-signature"]) == 64

    app_prefix = make_prefix("Smoke Test!!", root="someapp/")
    if not re.fullmatch(r"someapp/smoke-test-([a-z][0-9]){2}/", app_prefix):
        print(f"FAIL app prefix shape: {app_prefix}", file=sys.stderr)
        return 1

    for endpoint, want in [
        ("https://s3.eu-west-2.amazonaws.com", "eu-west-2"),
        ("https://s3.dualstack.ap-south-1.amazonaws.com", "ap-south-1"),
        ("https://s3.amazonaws.com", DEFAULT_REGION),
        ("https://s3.climb.ac.uk", DEFAULT_REGION),
    ]:
        if region_for_endpoint(endpoint) != want:
            print(f"FAIL region for {endpoint}: {region_for_endpoint(endpoint)}", file=sys.stderr)
            return 1

    print("self-test ok")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("name", nargs="?", help="human label for the upload; a random suffix is appended")
    p.add_argument("--profile", help="AWS CLI profile to sign with")
    p.add_argument("--bucket", help="bucket to upload into (required)")
    p.add_argument("--endpoint", help="S3 endpoint URL (default: from the AWS CLI config)")
    p.add_argument("--region", help="bucket region (default: from an AWS --endpoint, else us-east-1)")
    p.add_argument(
        "--page",
        "--base-url",
        dest="page",
        default=PAGE_URL,
        help=f"upload page the link opens (default: {PAGE_URL})",
    )
    p.add_argument(
        "--root",
        default=DEFAULT_ROOT,
        help=f"the app's upload root inside the bucket (default: {DEFAULT_ROOT})",
    )
    p.add_argument("--days", type=int, default=MAX_DAYS, help=f"link lifetime (max {MAX_DAYS})")
    p.add_argument("--max-bytes", type=int, default=POST_MAX_BYTES, help="per-object size cap")
    p.add_argument("--allow-session-token", action="store_true")
    p.add_argument("--self-test", action="store_true", help="verify signing against AWS test vectors")
    args = p.parse_args()

    if args.self_test:
        raise SystemExit(self_test())
    if not args.name:
        p.error("an upload name is required, e.g. `mint-magic-link.py inrb-batch3`")
    if not args.bucket:
        p.error("--bucket is required")
    check_root(args.root)
    if not 1 <= args.days <= MAX_DAYS:
        p.error(f"--days must be between 1 and {MAX_DAYS} (SigV4 signatures cannot outlive 7 days)")
    if not 1 <= args.max_bytes <= POST_MAX_BYTES:
        p.error(f"--max-bytes must be between 1 and {POST_MAX_BYTES} (S3 POST Object limit)")

    endpoint, endpoint_source = resolve_endpoint(args.endpoint, args.profile)
    access_key, secret, token = resolve_credentials(args.profile, args.allow_session_token)
    region = args.region or region_for_endpoint(endpoint)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    expires_at = now + timedelta(days=args.days)
    prefix = make_prefix(args.name, root=args.root)

    fields, datestamp, encoded = build_policy(
        args.bucket, prefix, region, access_key, token, expires_at, now, args.max_bytes
    )
    sign_policy(fields, secret, datestamp, region, encoded)

    payload = {"v": 1, "endpoint": endpoint, "fields": fields}
    blob = b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    link = f"{args.page.rstrip('/')}/#u={blob}"

    print(f"endpoint {endpoint} ({endpoint_source})")
    print(f"bucket   {args.bucket} ({region})")
    print(f"prefix   {prefix}")
    print(f"expires  {expires_at.strftime('%Y-%m-%dT%H:%M:%SZ')} ({args.days} days)")
    print(f"max size {args.max_bytes / 1024**3:.1f} GB per file")
    print(f"page     {args.page}")
    print()
    print(link)
    print()
    print("Anyone with this link can upload into that prefix until it expires.", file=sys.stderr)
    print("They cannot list, read or delete anything. Share it like a password.", file=sys.stderr)


if __name__ == "__main__":
    main()
