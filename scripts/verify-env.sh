#!/bin/sh
# Environment orchestration for pre-release verification of the plugin packages.
# Encodes the fiddly steps so each verification run does not reinvent them:
#   worktree <dir>  — git worktree of the DSH release tag + pnpm install/build.
#                     Point DSH_ROOT at the result when the sibling deepseek-harness
#                     checkout is AHEAD of the published dsh (package renames break
#                     the plugin build; see SKILL.md "Version alignment").
#   cli [dir]       — install the published @deepseek-ai/dsh CLI (needs an enlarged
#                     node heap: the dependency tree OOMs npm's default 2GB).
#   registry up     — start a throwaway verdaccio on :4873, create a user, write
#                     $VERIFY_DIR/npmrc for npm publish and the profile .npmrc.
#   registry down   — remove the verdaccio container.
#   publish         — npm pack the four packages into dist/ and publish them to
#                     the local verdaccio (run `registry up` first).
#   probe <port>    — smoke-check a running `dsh web`: page, both plugin bundles,
#                     and the scheduledTasks API route (404 means the host half's
#                     routes did not register — see SKILL.md "Known pitfall").
#
# Usage: scripts/verify-env.sh <subcommand> [args]
# Env:   VERIFY_DIR (default /tmp/dsh-verify), DSH_REF (default dsh-v0.1.2-alpha.2),
#        DSH_REPO (default sibling checkout)
set -eu

VERIFY_DIR=${VERIFY_DIR:-/tmp/dsh-verify}
DSH_REF=${DSH_REF:-dsh-v0.1.2-alpha.2}
DSH_REPO=${DSH_REPO:-"$(dirname "$PWD")/deepseek-harness"}
REPO_ROOT=$PWD

die() { echo "verify-env: $*" >&2; exit 1; }

cmd=${1:-}; shift || true
case "$cmd" in
  worktree)
    dir=${1:?usage: verify-env.sh worktree <dir>}
    git -C "$DSH_REPO" worktree add "$dir" "$DSH_REF"
    (cd "$dir" && pnpm install --frozen-lockfile && pnpm build)
    echo "verify-env: DSH worktree ready — DSH_ROOT=$dir"
    ;;
  cli)
    dir=${1:-$VERIFY_DIR/cli}
    mkdir -p "$VERIFY_DIR"
    NODE_OPTIONS=--max-old-space-size=8192 npm install --prefix "$dir" @deepseek-ai/dsh
    "$dir/node_modules/.bin/dsh" --version
    ;;
  registry)
    sub=${1:?usage: verify-env.sh registry up|down}
    case "$sub" in
      up)
        docker rm -f dsh-verify-verdaccio >/dev/null 2>&1 || true
        docker run -d --name dsh-verify-verdaccio -p 4873:4873 verdaccio/verdaccio:latest >/dev/null
        for i in 1 2 3 4 5 6 7 8 9 10; do
          curl -sf -o /dev/null http://localhost:4873/ && break
          sleep 2
        done
        token=$(curl -sf -XPUT -H "Content-Type: application/json" \
          -d '{"name":"release-verify","password":"verify-only-local","email":"verify@example.com","type":"user","roles":[]}' \
          http://localhost:4873/-/user/org.couchdb.user:release-verify \
          | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
        mkdir -p "$VERIFY_DIR"
        printf 'registry=http://localhost:4873/\n//localhost:4873/:_authToken=%s\n' "$token" > "$VERIFY_DIR/npmrc"
        echo "verify-env: verdaccio ready — .npmrc at $VERIFY_DIR/npmrc"
        ;;
      down)
        docker rm -f dsh-verify-verdaccio >/dev/null 2>&1 || true
        echo "verify-env: verdaccio removed"
        ;;
      *) die "registry up|down" ;;
    esac
    ;;
  publish)
    [ -f "$VERIFY_DIR/npmrc" ] || die "run `verify-env.sh registry up` first"
    mkdir -p dist
    for p in host remotes client bundle; do
      (cd "packages/scheduled-task/$p" && npm pack --pack-destination "$REPO_ROOT/dist" >/dev/null)
    done
    for t in "$REPO_ROOT"/dist/*.tgz; do
      # "./" prefix is required: a bare relative path is treated as a git spec
      npm publish --registry http://localhost:4873 --userconfig "$VERIFY_DIR/npmrc" "./${t#"$REPO_ROOT"/}"
    done
    ;;
  probe)
    port=${1:?usage: verify-env.sh probe <port> [token]}
    base="http://127.0.0.1:$port"
    # dsh >= 0.1.2-alpha: the web root answers 401 without the boot token, plugin
    # bundles serve ONLY through the combo route discovered from the boot page,
    # and API calls need the auth cookie the token exchange sets.
    token=${2:-}
    if [ -z "$token" ] && [ -f "$VERIFY_DIR/web.log" ]; then
      token=$(grep -o 'token=[A-Za-z0-9]*' "$VERIFY_DIR/web.log" | head -1 | cut -d= -f2)
    fi
    [ -n "$token" ] || die "probe: no token (pass it, or boot with the log at $VERIFY_DIR/web.log)"
    jar="$VERIFY_DIR/cookies.txt"
    code=$(curl -s -c "$jar" -L -o "$VERIFY_DIR/boot.html" -w '%{http_code}' "$base/?token=$token")
    echo "/ (with token): ${code:-000}"
    for id in "@qihongmu/dsh-client-ui-scheduled-task" "@qihongmu/dsh-client-remotes-scheduled-task"; do
      grep -q "$id/client.js" "$VERIFY_DIR/boot.html" \
        && echo "boot graph: $id ✓" \
        || echo "boot graph: $id MISSING"
    done
    # A healthy route answers with a JSON envelope (even a validation error);
    # an HTML error page or empty body means the host half's typert routes
    # never registered.
    echo "/api/scheduledTasks/list: $(curl -s -b "$jar" -X POST "$base/api/scheduledTasks/list" \
      -H 'Content-Type: application/json' -d '{}' | head -c 60)"
    ;;
  *)
    grep -E '^#   [a-z]' "$0" | sed 's/^#   //'
    ;;
esac
