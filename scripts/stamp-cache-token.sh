#!/usr/bin/env bash
# Stamp one cache token into every source file, so browsers never mix module
# versions. The one place that decides which files (any depth).
#
#   scripts/stamp-cache-token.sh            # fresh timestamp token
#   scripts/stamp-cache-token.sh <token>    # given token (YYYYMMDD-HHMMSS)
#   scripts/stamp-cache-token.sh --list     # print the files
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# All .js/.html/.css bar build output, tests, third-party bundles and tooling
list() {
  (cd "$ROOT" && find . \( -name .git -o -name pkg -o -name tests -o -name vendor -o -name dev -o -name node_modules \) -prune \
    -o -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' \) -print | sed 's#^\./##' | sort)
}

if [[ "${1:-}" == "--list" ]]; then
  list
  exit 0
fi

TOKEN="${1:-$(date +%Y%m%d-%H%M%S)}"
[[ "$TOKEN" =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo "token must look like 20261106-120000" >&2; exit 1; }
n=0
while IFS= read -r f; do
  perl -i -pe "s/(ASSET_VERSION\s*=\s*\"|[?]v=)[0-9]{8}-[0-9]{6}/\${1}${TOKEN}/g" "$ROOT/$f"
  n=$((n + 1))
done < <(list)
echo "  stamped cache token $TOKEN into $n source files"
