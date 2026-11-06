#!/usr/bin/env bash
# Deploy the sssender page to bede.github.io under /sssender/, and push. No build
# step. Stamps the cache token and SSSENDER_COMMIT with the source commit.
#   /sender/   an alias: redirects to /sssender/, fragment (magic link) and all
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAGES_ROOT="${PAGES_ROOT:-/Users/bede/Research/git/bede.github.io}"
DEST_DIR=sssender

SOURCE_HASH="$(git -C "$SRC" rev-parse --short HEAD)"
# We copy the working tree, not HEAD, so don't label uncommitted code with a clean hash
if [[ -n "$(git -C "$SRC" status --porcelain)" ]]; then
  SOURCE_HASH="$SOURCE_HASH-dirty-$(date -u +%Y%m%d%H%M%S)"
fi

# The page, then everything in core/, ui/ and vendor/. Copy, stamp, stage and prune
# all use this set, so a rename can't leave an orphan behind.
FILES=(index.html mint.html page.js)
while IFS= read -r f; do FILES+=("$f"); done < <(cd "$SRC" && find core ui vendor -type f ! -name .DS_Store | sort)

dest="$PAGES_ROOT/$DEST_DIR"
for f in "${FILES[@]}"; do
  mkdir -p "$(dirname "$dest/$f")"
  cp "$SRC/$f" "$dest/$f"
  case "$f" in *.js|*.html|*.css) ;; *) continue ;; esac
  sed -i '' -E "s/(ASSET_VERSION = \"|[?]v=)[0-9]{8}-[0-9]{6}/\\1$SOURCE_HASH/g" "$dest/$f"
  sed -i '' "s/const SSSENDER_COMMIT = \"dev\";/const SSSENDER_COMMIT = \"$SOURCE_HASH\";/" "$dest/$f"
done
echo "Deployed to $dest"

# /sender/ forwards each page to its /sssender/ twin, keeping the fragment
ALIAS_DIR=sender
ALIAS_FILES=(index.html mint.html)
mkdir -p "$PAGES_ROOT/$ALIAS_DIR"
for f in "${ALIAS_FILES[@]}"; do
  target="../$DEST_DIR/${f/index.html/}"
  cat > "$PAGES_ROOT/$ALIAS_DIR/$f" <<HTML
<!DOCTYPE html>
<meta charset="utf-8">
<title>sssender</title>
<script>location.replace("$target" + location.hash);</script>
<p>Moved to <a href="$target">sssender</a>.</p>
HTML
done
echo "Wrote redirects in $PAGES_ROOT/$ALIAS_DIR"

cd "$PAGES_ROOT"
# prune_and_stage <dir> <files…>: remove tracked files under dir not in the set
# (e.g. left behind by a rename), then stage the set
prune_and_stage() {
  local dir="$1"; shift
  local tracked rel keep f
  while IFS= read -r tracked; do
    rel="${tracked#"$dir"/}"
    keep=0
    for f in "$@"; do [[ "$f" == "$rel" ]] && { keep=1; break; }; done
    [[ "$keep" == 0 ]] && git rm -q "$tracked"
  done < <(git ls-files "$dir/")
  for f in "$@"; do git add "$dir/$f"; done
}
prune_and_stage "$DEST_DIR" "${FILES[@]}"
prune_and_stage "$ALIAS_DIR" "${ALIAS_FILES[@]}"

if git diff --cached --quiet; then
  echo "No GitHub Pages changes to commit"
  exit 0
fi
git commit -m "sssender $SOURCE_HASH"
git push origin "$(git rev-parse --abbrev-ref HEAD)"
echo "Pushed to GitHub Pages"
