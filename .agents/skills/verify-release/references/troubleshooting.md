# Troubleshooting reference

Forensics from the 2026-08-29 verification runs on dsh 0.1.1-rc.2, kept so
future runs can pattern-match symptoms instead of re-deriving causes.

## Install modes vs observed behavior

| Install mode | Host half UI entry | scheduledTasks API | Verdict |
|---|---|---|---|
| `dsh plugin add @qihongmu/dsh-plugins-scheduled-task-bundle` (registry) | renders | works | **the supported release path** |
| `dsh plugin add ./host ./remotes ./client` (link: or tgz, halves become bundle layers) | renders | **404** | broken on rc.2 — host mounts but its typert endpoints never register in the API gateway |
| plain `pnpm add file:/link:` in the profile + three insert rows in the profile `cordis.patch.yml` | renders | works | the no-registry recipe (SKILL.md Path A) |
| bundle-registered halves + hand-written rows in `cordis.patch.yml` | — | — | boot crashes: `duplicate loader entry id: plugins-scheduled-task` |

### Why the 404 happens (half-by-half add)

The API gateway (`@deepseek-ai/dsh-api-gateway`) claims `/api/<namespace>/<method>`
routes from `ctx.typert.local` (strict typert definitions) or from
`collectSrcClaims()`, which walks the gateway context's `reflect.props` for
services carrying a `typertRemote` binding. When the halves are installed as
individual bundle layers, the host plugin mounts under `include:plugins-scheduled-task`
in a context whose services the gateway's src-claims pass does not see, so the
endpoint is unclaimed → HTTP 404, while the browser halves still render (the
client bundle is served over the plugin combo URL, a different mechanism).
With the aggregate bundle the same rows register through a single layer and the
claims pass sees the service. This is an upstream interaction bug, not a plugin
defect — worth reporting to deepseek-harness with the table above.

Related constraint: the typert-loader only registers strict definitions for
packages exporting `exports["./typert"]`; the scheduled-task host intentionally
ships only the vendored `./remote` types, so route claims rely on the src-claims
path. If a future dsh tightens gateway claims further, the plugin may need to
add a `./typert` manifest export.

## Browser automation notes (browser-use skill)

- Playwright locator `.click()` hangs on the DSH web UI (probably a
  stability/overlay quirk). `.fill()`, `.selectOption()`, and reading snapshots
  work fine. For buttons, click by viewport coordinates with `tab.cua.click`,
  aiming from the latest screenshot; re-screenshot after layout changes because
  hover-revealed row buttons (pause/edit/delete) only exist while hovered.
- Combobox indexing: the create form has several `combobox` roles; the Minute
  selector is unnamed — target it with `getByRole("combobox").nth(1)`, not
  `.last()` (that is the Model selector).
- First boot of an isolated `$DSH_HOME` shows the "Internal Testing Notice"
  (Continue ≈ x849,y486 at 1280x720) then API-key onboarding ("Configure later"
  ≈ x691,y441). After a server restart the onboarding reappears; the notice
  does not.
- The one-shot delay task fires ~2 minutes after creation; poll the drawer or
  `curl -X POST /api/scheduledTasks/list` with a valid payload instead of
  guessing timings.

## Fast diagnostics for a suspicious boot

- `dsh --profile web --dump-config | grep -A3 scheduled` — are the three insert
  rows composed? (Rows come from bundle layers read at boot; the profile's own
  `cordis.patch.yml` staying `[]` after a bundle add is EXPECTED.)
- Settings → Plugins → Plugin list, search "scheduled": all three entries
  should say Mounted + Enabled. Mounted alone does NOT prove API routes work —
  always also run `scripts/verify-env.sh probe <port>`.
- `curl -X POST /api/scheduledTasks/list -d '{}'`: a JSON envelope
  (`bad-request: invalid client-request message`) means the route is alive;
  a literal 404 means it is not.
- Server stdout (`dsh web` log) is nearly silent; boot failures surface as a
  thrown error (e.g. duplicate loader entry id), but silent 404s do not appear
  there — use the probe.
