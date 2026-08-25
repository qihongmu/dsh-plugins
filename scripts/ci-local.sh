#!/usr/bin/env bash
# Reproduce the GitHub Actions `gates` job locally, in a fresh temp copy of the
# workspace, so you can validate before pushing.
#
# Why a temp copy? The dev machine's root node_modules carries hand-made links
# (e.g. @types/react from a profile build) that mask exactly the type-resolution
# gaps CI hits. Copying the repo to a clean dir means node_modules starts empty
# and everything comes only from `npm run bootstrap` — identical to a fresh CI
# runner. (`actions/checkout` also clones DSH INSIDE the workspace there; that
# part is DSH_ROOT-independent, so we just point DSH_ROOT at your local clone.)
#
# Usage:  npm run ci:local          # uses DSH_ROOT env or ../deepseek-harness
#         DSH_ROOT=/path/to/dsh npm run ci:local
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH_ROOT="${DSH_ROOT:-$REPO/../deepseek-harness}"

if [ ! -f "$DSH_ROOT/package.json" ]; then
  echo "[ci-local] DSH_ROOT does not look like a DeepSeek Harness checkout: $DSH_ROOT" >&2
  echo "[ci-local] set DSH_ROOT=/path/to/deepseek-harness (a BUILT checkout)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[ci-local] staging clean copy..."
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '*.tsbuildinfo' \
  --exclude 'tsconfig.dsh.generated.json' \
  --exclude 'tsconfig.dsh.client.generated.json' \
  "$REPO/" "$TMP/"

echo "[ci-local] copy: $TMP ; DSH_ROOT=$DSH_ROOT"
cd "$TMP"
export DSH_ROOT

run() { echo; echo "##### $* #####"; "$@"; }

run npm run bootstrap
run npm run build
run npm test
run npm run verify

echo
echo "[ci-local] ALL GATES PASSED (matching CI gates job)"
