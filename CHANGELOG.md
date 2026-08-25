# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[SemVer](https://semver.org/)-based starting at 0.1.0.

## [0.1.0] — initial public release

### Added

- **scheduled-task plugin** — global scheduled tasks for DeepSeek Harness as a
  pure external plugin (host scheduler + durable domain, browser remotes mount,
  sidebar UI), split into `host` / `remotes` / `client` workspace packages.
- Seven schedule selectors: `after` (one-shot delay), `at` (absolute local
  time), `every` (fixed rate, ≥300s), plus fully functional wall-clock presets
  `hourly` (minute anchor) / `daily` / `weekly` (multi-day, Mon=1..Sun=7) /
  `monthly` (skips months without the day) with timezone-aware occurrence math
  and strict-future advancement.
- Run sessions derived per task+project (`task-<id>-<cwd-hash>`): editing a
  task's project starts a fresh conversation inside the new workspace; returning
  to an earlier project re-attaches its history. Conversation titles are pinned
  to the task title via the session-title service.
- Right-drawer UI: searchable/filterable list with hover row actions and
  click-to-read unread state, inline multi-part schedule editor with live
  preview lines, create/edit form with workspace (project directory), model,
  and confirm-before-change (approval policy) fields.
- Remote surface (`scheduledTasks/{list,create,update,setStatus,delete,markRead}`)
  with hand-vendored typert schemas kept in sync with the wire model.
- Tooling: `bootstrap` against a local DSH checkout (`DSH_ROOT` or sibling),
  node:test unit suites (32 cases), remote-surface verify script, GitHub
  Actions CI running all gates.
