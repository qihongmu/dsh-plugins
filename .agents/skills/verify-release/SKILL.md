---
name: verify-release
description: >
  End-to-end install & UI verification for this repo's dsh plugins before a
  release or after meaningful changes: build all artifacts, install them into
  an isolated DSH environment (from source, no registry needed — or through a
  local verdaccio registry to rehearse the real published flow), boot `dsh web`,
  and drive the plugin UI in a browser. Use whenever the user asks to 验证发布,
  发布前测试, 测试插件安装, verify the plugin install, run a release check,
  or wants confidence that `dsh plugin add` + `dsh web` actually work — even if
  they only say "帮我测一下插件".
---

# Verify a dsh plugin release

Two paths share one build. Pick based on what the user wants proven:

- **Source install (fast regression, no registry)** — proves the built artifacts
  work after code changes. Use for iterative "I changed X, still good?" checks.
- **Registry rehearsal (release rehearsal)** — proves the exact commands a user
  will run post-publish: `npm pack` → publish to a throwaway verdaccio →
  `dsh plugin --profile web add @qihongmu/dsh-plugins-scheduled-task-bundle`.
  Use before actually publishing.

Both paths MUST run inside an isolated `$DSH_HOME` and MUST NOT touch `~/.dsh`.
Prove isolation: before starting, snapshot with
`find ~/.dsh -maxdepth 3 -name node_modules -prune -o -print | sort > /tmp/dsh-verify/home-before.txt`,
and after cleanup `diff` it against a fresh snapshot — zero changes is a report item.

## 0. Version alignment (do this first)

The published DSH (`latest` on npm) can lag the local `deepseek-harness` checkout.
A checkout that is AHEAD breaks the plugin build (renamed/removed packages —
e.g. 0.1.2-alpha.1 removed `@deepseek-ai/dsh-client-runtime` which the client
half type-imports). Check: `npm view @deepseek-ai/dsh dist-tags` vs
`git -C ../deepseek-harness log --oneline -1`.

If they diverge, build against a worktree of the published tag and pass it as
`DSH_ROOT` to every later command:

```sh
scripts/verify-env.sh worktree /tmp/dsh-verify/dsh-src   # worktree + install + build
export DSH_ROOT=/tmp/dsh-verify/dsh-src
```

If they match, the sibling checkout is fine and bootstrap picks it up by default.

## 1. Build gates (both paths)

```sh
export DSH_ROOT=...   # only if step 0 required a worktree
npm run bootstrap && npm run build && npm run build:web
npm test && npm run verify
```

`build:web` produces the browser bundles `lib/client.js` for the client and
remotes halves — `npm run build` alone does NOT produce them, and the published
tarballs are broken without them.

## 2. Path A — source install, no registry

The halves must be installed as PLAIN dependencies, never via `dsh plugin add`
(see "Known pitfall" for why), with their insert rows supplied by the profile
patch file:

```sh
scripts/verify-env.sh cli                      # published dsh CLI into /tmp/dsh-verify/cli
export DSH_HOME=/tmp/dsh-verify/dsh-home PATH="/tmp/dsh-verify/cli/node_modules/.bin:$PATH" DSH_TELEMETRY_DISABLED=1

REPO=$(git -C "$(pwd)" rev-parse --show-toplevel)
dsh plugin --profile web list                  # first use initializes the profile
cd "$DSH_HOME/profiles/web"
pnpm add file:"$REPO"/dist/deepseek-ai-dsh-plugins-scheduled-task-0.1.0.tgz \
         file:"$REPO"/dist/deepseek-ai-dsh-client-remotes-scheduled-task-0.1.0.tgz \
         file:"$REPO"/dist/deepseek-ai-dsh-client-ui-scheduled-task-0.1.0.tgz
```

If `dist/*.tgz` are missing, run `scripts/verify-env.sh publish` against a
registry first, or `npm pack` locally without publishing. For a live-edit loop,
`pnpm add link:` the three repo directories instead of tgz — then iterating is
just "rebuild in the repo + restart `dsh web`".

Write the three rows into `$DSH_HOME/profiles/web/cordis.patch.yml` (the file
exists after profile init as an empty `[]`):

```yaml
- insert:
    - id: plugins-scheduled-task
      name: '@qihongmu/dsh-plugins-scheduled-task'
    - id: plugins-remotes-scheduled-task
      name: '@qihongmu/dsh-client-remotes-scheduled-task'
    - id: plugins-ui-scheduled-task
      name: '@qihongmu/dsh-client-ui-scheduled-task'
```

Boot and smoke-probe:

```sh
dsh web --no-open --port 3199 &     # dsh web takes NO --profile/--patch; it boots profile "web"
scripts/verify-env.sh probe 3199
```

Then run the browser checklist below.

## 3. Path B — registry release rehearsal

```sh
scripts/verify-env.sh registry up
scripts/verify-env.sh publish                 # npm pack dist/*.tgz + publish to verdaccio

rm -rf /tmp/dsh-verify/dsh-home && mkdir -p /tmp/dsh-verify/dsh-home/profiles/web
cp /tmp/dsh-verify/npmrc /tmp/dsh-verify/dsh-home/profiles/web/.npmrc   # pnpm runs with the profile dir as cwd
export DSH_HOME=/tmp/dsh-verify/dsh-home PATH="/tmp/dsh-verify/cli/node_modules/.bin:$PATH" DSH_TELEMETRY_DISABLED=1
dsh plugin --profile web add @qihongmu/dsh-plugins-scheduled-task-bundle

dsh --profile web --dump-config | grep scheduled-task   # expect the three insert rows
dsh web --no-open --port 3199 &
scripts/verify-env.sh probe 3199
```

Then run the browser checklist below.

## 4. Browser checklist

Drive the UI with the browser-use skill (main agent). DSH first boot shows an
"Internal Testing Notice" (Continue) and an API-key onboarding ("Configure
later") — dismiss both; running without a key is fine and exercises the
failure path. Then verify at minimum:

1. Sidebar footer entry "Scheduled Tasks" renders; drawer opens.
2. Create a task (Hourly, and a Custom "After a delay" one-shot ~2 min).
3. The one-shot fires on time: status → Completed, run session appears in the
   sidebar, unread dot on the row + badge on the sidebar entry; marking read
   clears them. (Without an API key the run itself errors — still proves the
   wall-clock trigger, session creation, and state machine.)
4. Pause/Resume toggles badge + Paused filter; Edit recomputes "Next run".
5. Delete removes the task; search filters both ways.
6. Restart `dsh web` (kill the process, boot again) — tasks persist
   (durable store: `$DSH_HOME/storages/scheduled_task.json`).
7. Save screenshots per test point (numbered, e.g. `/tmp/dsh-verify/shots/t1_*.png`)
   and view them; every pass/fail claim needs a viewed screenshot.

## 5. Known pitfalls

- **Half-by-half `dsh plugin add` is broken on dsh 0.1.1-rc.2**: installing the
  three halves via `dsh plugin add ./host ./remotes ./client` (or from tarballs)
  registers each as a bundle layer; the host half then shows "Mounted" in
  Settings → Plugins but its `/api/scheduledTasks/*` routes never register and
  the drawer shows HTTP 404. The aggregate bundle works. Source installs must
  follow Path A (plain deps + profile patch rows). Details in
  [references/troubleshooting.md](references/troubleshooting.md).
- Do not ALSO hand-write the three rows when the halves are bundle-registered —
  duplicate `insert` ids crash boot ("duplicate loader entry id").
- Installing the published CLI OOMs npm's default heap; the `cli` subcommand
  already sets `NODE_OPTIONS=--max-old-space-size=8192`.
- `npm publish <path>` needs the `./` prefix or npm treats the path as a git spec.
- In the DSH web UI, Playwright locator `.click()` hangs; use coordinate clicks
  (`tab.cua.click`) for buttons and locator `fill`/`selectOption` for inputs.
  See [references/troubleshooting.md](references/troubleshooting.md).
- `~/.dsh` is the user's real environment. Never set `DSH_HOME` to it, never
  mount it, and end the report with the before/after snapshot diff.

## 6. Cleanup

```sh
lsof -ti:3199 | xargs kill                       # any port you booted
scripts/verify-env.sh registry down
git -C "$DSH_REPO" worktree remove --force /tmp/dsh-verify/dsh-src   # if step 0 made one
rm -rf /tmp/dsh-verify/dsh-home /tmp/dsh-verify/cli
DSH_ROOT=<sibling-or-none> npm run bootstrap      # restore repo links to the default checkout
```

Keep `dist/` and the screenshots until the user has read the report. Re-run the
`~/.dsh` snapshot diff and include the result in the report.

## 7. Report

Report per phase: build gates (test/verify counts), install mode, probe output,
a checklist table with screenshot paths for each item, pitfalls hit, and the
`~/.dsh` isolation diff. List anything NOT covered (e.g. real LLM task runs need
an API key) rather than implying full coverage.
