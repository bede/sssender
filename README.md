# sssender

seamlessly uploads files to S3-compatible storage simply by dragging and dropping them into a web browser. Files are uploaded directly to a specified S3 bucket inside a timestamped directory, preserving any nested directory structure. sssender communicates exclusively with the chosen S3 bucket and requires no third party trust, a is engineered to work over slow and unstable internet connections.

**sssender may be used in two ways:**

1. **Credential mode** in which S3 bucket credentials are entered manually.
2. **Magic link mode** in which the receiving party generates a pre-authenticated sssender URL and shares it with the sending party. This URL grants upload permission only to a specific prefix in the bucket, and is valid for up to 7 days.

## Creating a magic link as the receiving party

Magic links work using a presigned S3 POST policy authorising uploads anywhere under a specified bucket prefix for up to 7 days.

**From the browser**, follow *mint magic link* at the bottom of the sssender page (`/sssender/mint.html`). Enter the bucket's endpoint and credentials, and press *Make link*. The link is signed in the browser without sending credentials anywhere. The page must be served over HTTPS or from localhost.

**From the command line**, use an AWS CLI profile that can write to the bucket and run:

```sh
scripts/mint-magic-link.py test-upload --bucket my-bucket --profile climb --endpoint https://s3.climb.ac.uk
```

Other flags: `--days`, `--max-bytes`, `--region`, `--page`, `--root`.

Anyone with a magic link can upload to its target bucket prefix until either the request itself or the credentials associated with it expire or are revoked. Uploads go under `sssender/` in the bucket. Apps built on sssender use their own directory (Updeacon uses `updeacon/`), so they never clash. `scripts/check-upload-link.py '<link>'` checks a link against the live bucket.

## Bucket setup

The bucket must allow uploads from the browser (CORS), the most common cause of upload failures. [`cors.json`](cors.json) allows any origin, which is safe since every upload is still signed:

```sh
aws s3api put-bucket-cors --bucket my-bucket --cors-configuration file://cors.json
```

On Amazon S3, the server address to enter in sssender is `https://s3.<region>.amazonaws.com`.

## Development

```sh
python3 -m http.server 8000                                   # then open http://localhost:8000/
scripts/mint-magic-link.py smoke --bucket my-bucket --page http://localhost:8000
node --test "tests/*.test.mjs"
```

`scripts/deploy.sh` copies the page into the `bede.github.io` site and pushes. `scripts/stamp-cache-token.sh` restamps the cache token after editing.
